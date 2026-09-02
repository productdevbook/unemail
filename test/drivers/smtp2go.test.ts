import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import smtp2go from "../../src/drivers/smtp2go.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const apiKey = "api-TEST"

/** Records every request and answers with a scripted response. */
function stub(script: (url: string, init: RequestInit) => [number, unknown]) {
  const calls: {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  }[] = []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const [status, payload] = script(url, init)
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    })
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

/** The ordinary answer: 200, nothing failed, an email id. */
const accepted = (id = "1u0SwL-B9zBpi9ffUq-JAB2") =>
  stub(() => [
    200,
    { request_id: "aa253464", data: { succeeded: 1, failed: 0, failures: [], email_id: id } },
  ])

const email = (stubbed: ReturnType<typeof stub>, options = {}) =>
  createEmail({ driver: smtp2go({ apiKey, fetch: stubbed.fetch, ...options }), defaults })

const headerMap = (body: any): Record<string, string> =>
  Object.fromEntries(
    ((body.custom_headers ?? []) as { header: string; value: string }[]).map((entry) => [
      entry.header,
      entry.value,
    ]),
  )

describe("smtp2go", () => {
  it("requires an apiKey", () => {
    expect(() => smtp2go({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("sends to the global host unless a region is named", async () => {
    const s = accepted()
    await email(s).send(msg)
    expect(s.calls[0]!.url).toBe("https://api.smtp2go.com/v3/email/send")
    expect(s.calls[0]!.method).toBe("POST")
    expect(s.calls[0]!.headers["x-smtp2go-api-key"]).toBe(apiKey)

    for (const region of ["us", "eu", "au"] as const) {
      const regional = accepted()
      await email(regional, { region }).send(msg)
      expect(regional.calls[0]!.url).toBe(`https://${region}-api.smtp2go.com/v3/email/send`)
    }
  })

  it("lets an explicit endpoint win over the region", async () => {
    const s = accepted()
    await email(s, { region: "eu", endpoint: "https://gateway.acme.com/" }).send(msg)
    expect(s.calls[0]!.url).toBe("https://gateway.acme.com/v3/email/send")
  })

  it("maps the message onto the v3 payload", async () => {
    const s = accepted("email_1")
    const { data } = await email(s).send({
      ...msg,
      cc: "cc@x.com",
      bcc: ["Bee <bcc@x.com>"],
      replyTo: ["reply@acme.com", "Second <two@acme.com>"],
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
      tags: [{ name: "campaign", value: "welcome-2026" }],
    })

    expect(data?.id).toBe("email_1")
    const body = s.calls[0]!.body
    expect(body).toMatchObject({
      sender: "Acme <hi@acme.com>",
      to: ["Ada <ada@example.com>"],
      cc: ["cc@x.com"],
      bcc: ["Bee <bcc@x.com>"],
      subject: "hi",
      text_body: "hello",
      html_body: "<p>hi</p>",
    })
    // SMTP2GO has no reply-to, metadata or tag field of its own; a custom
    // header is what carries each of them.
    expect(headerMap(body)).toEqual({
      "X-Campaign": "welcome",
      "Reply-To": "reply@acme.com, Second <two@acme.com>",
      "X-Metadata-userId": "42",
      "X-Tag-campaign": "welcome-2026",
    })
    expect(body.fastaccept).toBeUndefined()
  })

  it("sends no subject for a templated message, which carries its own", async () => {
    const s = accepted()
    await email(s).send({
      to: "a@x.com",
      template: { id: "tmpl_1", variables: { username: "ada" } },
    })
    const body = s.calls[0]!.body
    expect(body.template_id).toBe("tmpl_1")
    expect(body.template_data).toEqual({ username: "ada" })
    expect("subject" in body).toBe(false)
  })

  it("asks for fastaccept only when the option says so", async () => {
    const s = accepted()
    await email(s, { fastAccept: true }).send(msg)
    expect(s.calls[0]!.body.fastaccept).toBe(true)
  })

  it("base64-encodes an attachment and keys an inline image by its cid", async () => {
    const s = accepted()
    await email(s).send({
      ...msg,
      html: '<img src="cid:logo.png">',
      attachments: [
        { filename: "report.pdf", content: "test", contentType: "application/pdf" },
        { filename: "brand.png", content: new Uint8Array([1, 2, 3]), cid: "logo.png" },
      ],
    })
    const body = s.calls[0]!.body
    expect(body.attachments).toEqual([
      { filename: "report.pdf", mimetype: "application/pdf", fileblob: "dGVzdA==" },
    ])
    // An inline image is addressed as `cid:<filename>`, so the content id
    // has to be the filename SMTP2GO sees or the reference resolves to
    // nothing.
    expect(body.inlines).toEqual([{ filename: "logo.png", fileblob: "AQID" }])
  })

  it("hands over an attachment url instead of fetching the bytes itself", async () => {
    const s = accepted()
    const { error } = await email(s).send({
      ...msg,
      attachments: [
        {
          filename: "big.pdf",
          url: "https://cdn.acme.com/big.pdf",
          contentType: "application/pdf",
        },
      ],
    })
    expect(error).toBeNull()
    expect(s.calls[0]!.body.attachments).toEqual([
      { filename: "big.pdf", mimetype: "application/pdf", url: "https://cdn.acme.com/big.pdf" },
    ])
  })
})

describe("smtp2go answers 200 even when the send failed", () => {
  it("reports a failures array as a failure, not a success", async () => {
    const s = stub(() => [
      200,
      {
        request_id: "aa253464",
        data: {
          succeeded: 0,
          failed: 1,
          failures: ["ada@example.com: address is on the suppression list"],
          email_id: "",
        },
      },
    ])
    const { data, error } = await email(s).send(msg)
    expect(data).toBeNull()
    expect(error?.code).toBe("PROVIDER")
    expect(error?.retryable).toBe(false)
    expect(error?.message).toMatch(/suppression list/)
  })

  it("reports a failed count even when the failures array says nothing", async () => {
    const s = stub(() => [
      200,
      { request_id: "r", data: { succeeded: 0, failed: 1, failures: [], email_id: "e" } },
    ])
    const { error } = await email(s).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/1 failed/)
  })

  it("reads an object failure as well as the documented string", async () => {
    const s = stub(() => [
      200,
      {
        data: {
          failed: 1,
          failures: [{ email: "ada@example.com", error: "550 no such user" }],
        },
      },
    ])
    const { error } = await email(s).send(msg)
    expect(error?.message).toMatch(/ada@example\.com: 550 no such user/)
  })

  it("accepts a fastaccept response, which carries no counters at all", async () => {
    const s = stub(() => [200, { request_id: "r", data: { email_id: "email_2" } }])
    const { data } = await email(s, { fastAccept: true }).send(msg)
    expect(data?.id).toBe("email_2")
  })

  it("fails a 200 that carried no email id", async () => {
    const s = stub(() => [200, { request_id: "r", data: {} }])
    const { error } = await email(s).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/no email_id/)
  })
})

describe("smtp2go scheduling", () => {
  const soon = () => new Date(Date.now() + 60 * 60 * 1000)

  it("sends the schedule and reports the message by its schedule id", async () => {
    const s = stub(() => [
      200,
      {
        data: { succeeded: 1, failed: 0, failures: [], email_id: "e1", schedule_id: "sched_1" },
      },
    ])
    const at = soon()
    const { data } = await email(s).send({ ...msg, scheduledAt: at })

    expect(s.calls[0]!.body.schedule).toBe(at.toISOString())
    // The schedule id is the only handle `cancel()` accepts.
    expect(data?.id).toBe("sched_1")
    expect(data?.provider).toMatchObject({ data: { email_id: "e1" } })
  })

  it("refuses a schedule more than three days ahead", async () => {
    const s = accepted()
    const { error } = await email(s).send({
      ...msg,
      scheduledAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/at most 3 days ahead/)
    expect(s.calls).toHaveLength(0)
  })

  it("cancels a scheduled send by its schedule id", async () => {
    const s = stub(() => [200, { data: {} }])
    const { error } = await email(s).cancel("sched_1")
    expect(error).toBeNull()
    expect(s.calls[0]!.url).toBe("https://api.smtp2go.com/v3/email/scheduled/remove")
    expect(s.calls[0]!.body).toEqual({ schedule_id: "sched_1" })
  })

  it("retrieves a scheduled send, and says nothing about one it cannot find", async () => {
    const found = stub(() => [
      200,
      { data: [{ schedule_id: "sched_1", schedule: "2030-06-30T23:11:56Z" }] },
    ])
    const state = await email(found).retrieve("sched_1")
    expect(found.calls[0]!.url).toBe("https://api.smtp2go.com/v3/email/scheduled/search")
    expect(state.data?.state).toBe("scheduled")
    expect(state.data?.at?.toISOString()).toBe("2030-06-30T23:11:56.000Z")

    const missing = stub(() => [200, { data: [] }])
    expect((await email(missing).retrieve("sched_1")).data?.state).toBe("unknown")
  })
})

describe("smtp2go limits are refused before the request", () => {
  it("more than 100 recipients in one field, naming the field", async () => {
    const s = accepted()
    const { error } = await email(s).send({
      ...msg,
      cc: Array.from({ length: 101 }, (_, i) => `c${i}@x.com`),
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/at most 100 `cc` recipients/)
    expect(s.calls).toHaveLength(0)
  })

  it("a header SMTP2GO does not allow", async () => {
    const s = accepted()
    for (const name of ["Content-Type", "content-transfer-encoding", "MIME-Version"]) {
      const { error } = await email(s).send({ ...msg, headers: { [name]: "x" } })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/may not be set/)
    }
    expect(s.calls).toHaveLength(0)
  })
})

describe("smtp2go batching and failures", () => {
  it("returns one result per message, in order, with a failure in the middle", async () => {
    let call = 0
    const s = stub(() => {
      call += 1
      return call === 2
        ? [200, { data: { succeeded: 0, failed: 1, failures: ["rejected"], email_id: "" } }]
        : [200, { data: { succeeded: 1, failed: 0, failures: [], email_id: `e${call}` } }]
    })

    const batch = await email(s).sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b" },
      { ...msg, subject: "c" },
    ])

    // The endpoint takes one message per request, so a batch is a run of
    // them rather than one array.
    expect(s.calls).toHaveLength(3)
    expect(s.calls.map((c) => c.body.subject)).toEqual(["a", "b", "c"])
    expect(batch.results.map((r) => r.data?.id)).toEqual(["e1", undefined, "e3"])
    expect(batch.failed.map((f) => f.index)).toEqual([1])
  })

  it("classifies a transport failure by its status", async () => {
    const codeFor = async (status: number, payload: unknown = {}) => {
      const s = stub(() => [status, payload])
      return (await email(s).send(msg)).error
    }
    expect((await codeFor(401))?.code).toBe("AUTH")
    expect((await codeFor(429))?.code).toBe("RATE_LIMIT")
    expect((await codeFor(500))?.code).toBe("NETWORK")
    expect((await codeFor(500))?.retryable).toBe(true)
  })

  it("reads the reason out of `data`, where the shared extractor cannot see it", async () => {
    const s = stub(() => [
      400,
      {
        request_id: "22e5acba",
        data: {
          error_code: "E_ApiResponseCodes.NON_VALIDATING_IN_PAYLOAD",
          error: "sender is not a validated address",
        },
      },
    ])
    const { error } = await email(s).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/sender is not a validated address/)
  })

  it("calls a rejected key an AUTH failure even though it arrives as a 400", async () => {
    const s = stub(() => [
      400,
      {
        data: {
          error_code: "E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED",
          error: "You do not have permission to access this API endpoint",
        },
      },
    ])
    const { error } = await email(s).send(msg)
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
  })

  it("cancels an in-flight request when the caller's signal aborts", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(JSON.stringify({ data: { email_id: "e" } }), { status: 200 })
    }) as unknown as typeof fetch

    await createEmail({
      driver: smtp2go({ apiKey, fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)

    expect(aborted).toBe(true)
  })

  it("forwards a caller-supplied timeout", async () => {
    const seen: (AbortSignal | undefined)[] = []
    const s = accepted()
    const spy = (async (url: string | URL, init: RequestInit = {}) => {
      seen.push(init.signal ?? undefined)
      return s.fetch(url, init)
    }) as unknown as typeof fetch

    await createEmail({ driver: smtp2go({ apiKey, fetch: spy, timeoutMs: 1 }), defaults }).send(msg)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })
})
