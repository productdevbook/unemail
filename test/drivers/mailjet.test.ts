import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import mailjet from "../../src/drivers/mailjet.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const apiKey = "pub"
const apiSecret = "priv"

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

function sent(uuid: string) {
  return {
    Status: "success",
    CustomID: "",
    To: [{ Email: "ada@example.com", MessageUUID: uuid, MessageID: 70650219165027410 }],
    Cc: [],
    Bcc: [],
  }
}

/** The ordinary answer: one success object per message in the request, in
 *  the order they were sent. */
const accepted = () =>
  stub((_url, init) => {
    const body = JSON.parse(String(init.body)) as { Messages: unknown[] }
    return [200, { Messages: body.Messages.map((_, index) => sent(`mj_${index}`)) }]
  })

const email = (stubbed: ReturnType<typeof stub>, options = {}) =>
  createEmail({
    driver: mailjet({ apiKey, apiSecret, fetch: stubbed.fetch, ...options }),
    defaults,
  })

const basic = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`

describe("mailjet", () => {
  it("requires both halves of the key pair", () => {
    expect(() => mailjet({ apiKey: "", apiSecret })).toThrow(/missing required option/)
    expect(() => mailjet({ apiKey, apiSecret: "" })).toThrow(/missing required option/)
  })

  it("maps the message onto the v3.1 payload", async () => {
    const s = accepted()
    const { data } = await email(s).send({
      ...msg,
      cc: "cc@x.com",
      bcc: "Bee <bcc@x.com>",
      replyTo: "reply@acme.com",
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
      tags: [
        { name: "campaign", value: "welcome-2026" },
        { name: "cohort", value: "beta" },
      ],
      tracking: { opens: true, clicks: false },
      idempotencyKey: "order-1",
    })

    expect(data?.id).toBe("mj_0")
    const call = s.calls[0]!
    expect(call.url).toBe("https://api.mailjet.com/v3.1/send")
    expect(call.method).toBe("POST")
    expect(call.headers.authorization).toBe(basic)
    expect(call.body.Messages).toHaveLength(1)
    expect(call.body.Messages[0]).toMatchObject({
      From: { Email: "hi@acme.com", Name: "Acme" },
      To: [{ Email: "ada@example.com", Name: "Ada" }],
      Cc: [{ Email: "cc@x.com" }],
      Bcc: [{ Email: "bcc@x.com", Name: "Bee" }],
      ReplyTo: { Email: "reply@acme.com" },
      Subject: "hi",
      TextPart: "hello",
      HTMLPart: "<p>hi</p>",
      Headers: { "X-Campaign": "welcome" },
      CustomID: "order-1",
      CustomCampaign: "campaign",
      TrackOpens: "enabled",
      TrackClicks: "disabled",
    })
    // A campaign is a bare name, so the tags' values ride along with the
    // metadata rather than reaching nobody.
    expect(JSON.parse(call.body.Messages[0].EventPayload)).toEqual({
      userId: "42",
      campaign: "welcome-2026",
      cohort: "beta",
    })
    expect(call.body.SandboxMode).toBeUndefined()
  })

  it("leaves tracking off a message with no HTML part to instrument", async () => {
    const s = accepted()
    await email(s).send({ ...msg, tracking: { opens: true, clicks: true } })
    expect(s.calls[0]!.body.Messages[0].TrackOpens).toBeUndefined()
    expect(s.calls[0]!.body.Messages[0].TrackClicks).toBeUndefined()
  })

  it("sends no Subject for a templated message and turns the template language on", async () => {
    const s = accepted()
    await email(s).send({
      to: "a@x.com",
      template: { id: "1234", variables: { day: "Tuesday" } },
    })
    const message = s.calls[0]!.body.Messages[0]
    expect(message).toMatchObject({
      TemplateID: 1234,
      TemplateLanguage: true,
      Variables: { day: "Tuesday" },
    })
    expect("Subject" in message).toBe(false)
  })

  it("refuses a template id that is not Mailjet's numeric one", async () => {
    const s = accepted()
    const { error } = await email(s).send({ to: "a@x.com", template: { alias: "welcome" } })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/numeric template id/)
    expect(s.calls).toHaveLength(0)
  })

  it("splits attachments from inline images and base64-encodes both", async () => {
    const s = accepted()
    await email(s).send({
      ...msg,
      html: '<img src="cid:logo">',
      attachments: [
        { filename: "a.txt", content: "test", contentType: "text/plain" },
        { filename: "logo.png", content: new Uint8Array([1, 2, 3]), cid: "logo" },
      ],
    })
    const message = s.calls[0]!.body.Messages[0]
    expect(message.Attachments).toEqual([
      { ContentType: "text/plain", Filename: "a.txt", Base64Content: "dGVzdA==" },
    ])
    expect(message.InlinedAttachments).toEqual([
      {
        ContentType: "application/octet-stream",
        Filename: "logo.png",
        Base64Content: "AQID",
        ContentID: "logo",
      },
    ])
  })

  it("is refused a url attachment before the request, because it cannot fetch one", async () => {
    const s = accepted()
    const { error } = await email(s).send({
      ...msg,
      attachments: [{ filename: "big.pdf", url: "https://cdn.acme.com/big.pdf" }],
    })
    expect(error?.code).toBe("UNSUPPORTED")
    expect(error?.message).toContain("`attachments[].url`")
    expect(s.calls).toHaveLength(0)
  })

  it("is refused scheduledAt, which the Send API has no field for", async () => {
    const s = accepted()
    const { error } = await email(s).send({ ...msg, scheduledAt: "2030-01-01T00:00:00Z" })
    expect(error?.code).toBe("UNSUPPORTED")
    expect(s.calls).toHaveLength(0)
  })

  it("puts SandboxMode at the root of the payload, not on the message", async () => {
    const s = stub(() => [
      200,
      // Sandbox validates and drops the message: accepted, but with no id.
      {
        Messages: [
          { Status: "success", To: [{ Email: "a@x.com", MessageUUID: "", MessageID: 0 }] },
        ],
      },
    ])
    const { data } = await email(s).send({ ...msg, sandbox: true })
    expect(s.calls[0]!.body.SandboxMode).toBe(true)
    expect(s.calls[0]!.body.Messages[0].SandboxMode).toBeUndefined()
    expect(data?.id).toBe("sandbox")
  })

  it("takes the instance sandbox default, and lets a message override it", async () => {
    const s = accepted()
    const client = email(s, { sandbox: true })
    await client.send(msg)
    await client.send({ ...msg, sandbox: false })
    expect(s.calls[0]!.body.SandboxMode).toBe(true)
    expect(s.calls[1]!.body.SandboxMode).toBeUndefined()
  })
})

describe("mailjet batching", () => {
  it("sends the whole batch as one Messages array and reports it positionally", async () => {
    const s = accepted()
    const batch = await email(s).sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b" },
      { ...msg, subject: "c" },
    ])

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.body.Messages.map((m: any) => m.Subject)).toEqual(["a", "b", "c"])
    expect(batch.results.map((r) => r.data?.id)).toEqual(["mj_0", "mj_1", "mj_2"])
    expect(batch.ok).toBe(true)
  })

  it("keeps a sandboxed message out of the request carrying live ones", async () => {
    const s = accepted()
    const batch = await email(s).sendBatch([
      { ...msg, subject: "live" },
      { ...msg, subject: "dry", sandbox: true },
      { ...msg, subject: "live too" },
    ])

    expect(s.calls).toHaveLength(2)
    expect(s.calls[0]!.body.SandboxMode).toBeUndefined()
    expect(s.calls[0]!.body.Messages.map((m: any) => m.Subject)).toEqual(["live", "live too"])
    expect(s.calls[1]!.body.SandboxMode).toBe(true)
    expect(s.calls[1]!.body.Messages.map((m: any) => m.Subject)).toEqual(["dry"])
    expect(batch.results).toHaveLength(3)
    expect(batch.ok).toBe(true)
  })

  it("keeps the accepted messages when a 400 reports one of them as failed", async () => {
    // Mailjet answers a partly-failed batch with 400 and the whole Messages
    // array; reading the status alone would lose the message it sent.
    const s = stub(() => [
      400,
      {
        Messages: [
          {
            Status: "error",
            Errors: [
              {
                ErrorIdentifier: "88b5ca9f",
                ErrorCode: "send-0003",
                StatusCode: 400,
                ErrorMessage: 'At least "HTMLPart", "TextPart" or "TemplateID" must be provided.',
                ErrorRelatedTo: ["HTMLPart", "TextPart"],
              },
            ],
          },
          sent("mj_ok"),
        ],
      },
    ])

    const batch = await email(s).sendBatch([
      { ...msg, subject: "broken" },
      { ...msg, subject: "fine" },
    ])

    expect(batch.sent.map((r) => r.id)).toEqual(["mj_ok"])
    expect(batch.failed).toHaveLength(1)
    expect(batch.failed[0]!.index).toBe(0)
    expect(batch.failed[0]!.error.code).toBe("PROVIDER")
    expect(batch.failed[0]!.error.message).toMatch(/HTMLPart, TextPart: At least/)
    expect(batch.results).toHaveLength(2)
  })

  it("classifies a per-message error by its own StatusCode", async () => {
    const s = stub(() => [
      400,
      {
        Messages: [
          {
            Status: "error",
            Errors: [
              {
                ErrorCode: "send-0008",
                StatusCode: 403,
                ErrorMessage: "sender not authorized",
                ErrorRelatedTo: ["From"],
              },
            ],
          },
        ],
      },
    ])
    const { error } = await email(s).send(msg)
    expect(error?.code).toBe("AUTH")
    expect(error?.status).toBe(403)
    expect(error?.retryable).toBe(false)
  })

  it("fails the whole request when the body carries no per-message report", async () => {
    const s = stub(() => [
      400,
      { ErrorCode: "mj-0002", ErrorMessage: "Malformed JSON", StatusCode: 400 },
    ])
    const batch = await email(s).sendBatch([msg, msg])
    expect(batch.failed.map((f) => f.index)).toEqual([0, 1])
    expect(batch.failed[0]!.error.code).toBe("PROVIDER")
  })

  it("fails only the messages whose report is missing an id", async () => {
    const s = stub(() => [200, { Messages: [{ Status: "success", To: [] }] }])
    const { error } = await email(s).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/no MessageUUID/)
  })

  it("splits a batch at the 50-recipient cap the whole request shares", async () => {
    const s = accepted()
    const batch = await email(s).sendBatch(
      Array.from({ length: 60 }, (_, i) => ({ ...msg, to: `p${i}@x.com` })),
    )

    expect(s.calls).toHaveLength(2)
    expect(s.calls[0]!.body.Messages).toHaveLength(50)
    expect(s.calls[1]!.body.Messages).toHaveLength(10)
    expect(batch.results).toHaveLength(60)
    expect(batch.ok).toBe(true)
  })

  it("counts recipients, not messages, when splitting", async () => {
    const s = accepted()
    const many = Array.from({ length: 30 }, (_, i) => `p${i}@x.com`)
    const batch = await email(s).sendBatch([
      { ...msg, to: many },
      { ...msg, to: many.map((address) => `x-${address}`) },
    ])

    expect(s.calls).toHaveLength(2)
    expect(batch.results).toHaveLength(2)
  })
})

describe("mailjet limits are refused before the request", () => {
  const refuse = async (over: Record<string, unknown>) => {
    const s = accepted()
    const { error } = await email(s).send({ ...msg, ...over })
    return { error, calls: s.calls }
  }

  it("a subject over 255 characters", async () => {
    const { error, calls } = await refuse({ subject: "x".repeat(256) })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/255 characters/)
    expect(calls).toHaveLength(0)
  })

  it("more than 50 recipients across to, cc and bcc", async () => {
    const { error } = await refuse({
      to: Array.from({ length: 40 }, (_, i) => `a${i}@x.com`),
      cc: Array.from({ length: 11 }, (_, i) => `b${i}@x.com`),
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/at most 50 recipients/)
  })

  it("but counts a repeated address only once, as Mailjet does", async () => {
    const s = accepted()
    const many = Array.from({ length: 50 }, (_, i) => `a${i}@x.com`)
    const { error } = await email(s).send({ ...msg, to: many, cc: many })
    expect(error).toBeNull()
  })

  it("a second replyTo, rather than dropping it", async () => {
    const { error } = await refuse({ replyTo: ["a@x.com", "b@x.com"] })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/single `replyTo`/)
  })

  it("a header Mailjet reserves for itself", async () => {
    const { error } = await refuse({ headers: { "X-MJ-CustomID": "nope" } })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/may not be overridden/)
  })

  it("and leaves the rest of the batch alone", async () => {
    const s = accepted()
    const batch = await email(s).sendBatch([
      { ...msg, subject: "fine" },
      { ...msg, subject: "y".repeat(256) },
      { ...msg, subject: "also fine" },
    ])

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.body.Messages).toHaveLength(2)
    expect(batch.failed.map((f) => f.index)).toEqual([1])
    expect(batch.results[0]!.data?.id).toBe("mj_0")
    expect(batch.results[2]!.data?.id).toBe("mj_1")
  })
})

describe("mailjet transport failures", () => {
  const codeFor = async (status: number, payload: unknown = {}) => {
    const s = stub(() => [status, payload])
    const { error } = await email(s).send(msg)
    return error
  }

  it("classifies by status when the body says nothing per message", async () => {
    expect((await codeFor(401))?.code).toBe("AUTH")
    expect((await codeFor(429))?.code).toBe("RATE_LIMIT")
    expect((await codeFor(500))?.code).toBe("NETWORK")
    expect((await codeFor(500))?.retryable).toBe(true)
    expect((await codeFor(400))?.code).toBe("PROVIDER")
  })

  it("cancels an in-flight request when the caller's signal aborts", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(JSON.stringify({ Messages: [sent("mj_0")] }), { status: 200 })
    }) as unknown as typeof fetch

    await createEmail({
      driver: mailjet({ apiKey, apiSecret, fetch: hanging }),
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

    await createEmail({
      driver: mailjet({ apiKey, apiSecret, fetch: spy, timeoutMs: 1 }),
      defaults,
    }).send(msg)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })
})
