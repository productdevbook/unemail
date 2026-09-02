import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import mailgun from "../../src/drivers/mailgun.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const credentials = { apiKey: "key-test", domain: "mg.acme.com" }
const queued = { id: "<20260901.abc@mg.acme.com>", message: "Queued. Thank you." }

/** Records every request and answers with a scripted response. Mailgun
 *  takes multipart/form-data, so the recorded body is the `FormData` the
 *  driver handed to fetch rather than a JSON string. */
function stub(script: (url: string, init: RequestInit) => [number, unknown] = () => [200, queued]) {
  const calls: {
    url: string
    method: string
    headers: Record<string, string>
    form: FormData
  }[] = []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const [status, payload] = script(url, init)
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      form: init.body instanceof FormData ? init.body : new FormData(),
    })
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const field = (form: FormData, name: string) => form.get(name) as string | null
const fields = (form: FormData, name: string) => form.getAll(name).map(String)

const email = (stubbed: ReturnType<typeof stub>, options = {}) =>
  createEmail({ driver: mailgun({ ...credentials, fetch: stubbed.fetch, ...options }), defaults })

describe("mailgun", () => {
  it("requires an api key and a domain", () => {
    expect(() => mailgun({ apiKey: "", domain: "d" })).toThrow(/missing required option/)
    expect(() => mailgun({ apiKey: "k", domain: "" })).toThrow(/missing required option/)
  })

  it("posts a form to the domain's messages endpoint with basic auth", async () => {
    const s = stub()
    const { data } = await email(s).send(msg)

    const call = s.calls[0]!
    expect(call.url).toBe("https://api.mailgun.net/v3/mg.acme.com/messages")
    expect(call.method).toBe("POST")
    expect(call.headers.authorization).toBe(`Basic ${btoa("api:key-test")}`)
    // fetch writes the content type itself: only it knows the boundary.
    expect(Object.keys(call.headers).map((n) => n.toLowerCase())).not.toContain("content-type")
    // Angle brackets are on the send response and on nothing else Mailgun
    // will accept the id back through.
    expect(data?.id).toBe("20260901.abc@mg.acme.com")
    expect(data?.provider).toMatchObject({ message: "Queued. Thank you." })
  })

  it("maps the message onto the documented form fields", async () => {
    const s = stub()
    await email(s, { ipPool: "pool-1" }).send({
      ...msg,
      cc: "cc@x.com",
      bcc: "bcc@x.com",
      replyTo: ["reply@acme.com", "Two <two@acme.com>"],
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
      tags: [{ name: "campaign", value: "welcome-2026" }],
      tracking: { opens: true, clicks: false },
    })

    const form = s.calls[0]!.form
    expect(field(form, "from")).toBe("Acme <hi@acme.com>")
    expect(fields(form, "to")).toEqual(["Ada <ada@example.com>"])
    expect(fields(form, "cc")).toEqual(["cc@x.com"])
    expect(fields(form, "bcc")).toEqual(["bcc@x.com"])
    expect(field(form, "subject")).toBe("hi")
    expect(field(form, "text")).toBe("hello")
    expect(field(form, "html")).toBe("<p>hi</p>")
    expect(field(form, "h:Reply-To")).toBe("reply@acme.com, Two <two@acme.com>")
    expect(field(form, "h:X-Campaign")).toBe("welcome")
    expect(field(form, "v:userId")).toBe("42")
    expect(fields(form, "o:tag")).toEqual(["campaign"])
    // A tag has no value field of its own here, so it is carried as a
    // variable as well.
    expect(field(form, "v:campaign")).toBe("welcome-2026")
    expect(field(form, "o:tracking-opens")).toBe("yes")
    expect(field(form, "o:tracking-clicks")).toBe("no")
    expect(field(form, "o:sending-ip-pool")).toBe("pool-1")
    expect(field(form, "recipient-variables")).toBeNull()
  })

  it("sends to the EU host when the domain lives there", async () => {
    const s = stub()
    await email(s, { region: "eu" }).send(msg)
    expect(s.calls[0]!.url).toBe("https://api.eu.mailgun.net/v3/mg.acme.com/messages")
  })

  it("lets an explicit endpoint win over the region", async () => {
    const s = stub()
    await email(s, { region: "eu", endpoint: "https://gateway.acme.com/" }).send(msg)
    expect(s.calls[0]!.url).toBe("https://gateway.acme.com/v3/mg.acme.com/messages")
  })

  it("schedules with an RFC 2822 delivery time", async () => {
    const s = stub()
    const scheduledAt = new Date("2030-01-01T12:00:00Z")
    await email(s).send({ ...msg, scheduledAt })
    expect(field(s.calls[0]!.form, "o:deliverytime")).toBe("Tue, 01 Jan 2030 12:00:00 GMT")
  })

  it("turns test mode on per message and per driver", async () => {
    const s = stub()
    await email(s).send({ ...msg, sandbox: true })
    expect(field(s.calls[0]!.form, "o:testmode")).toBe("yes")

    const t = stub()
    await email(t, { sandbox: true }).send(msg)
    expect(field(t.calls[0]!.form, "o:testmode")).toBe("yes")

    const u = stub()
    await email(u).send(msg)
    expect(field(u.calls[0]!.form, "o:testmode")).toBeNull()
  })

  describe("templates", () => {
    it("addresses a stored template by name and JSON-encodes its variables", async () => {
      const s = stub()
      await email(s).send({ ...msg, template: { alias: "welcome", variables: { name: "Ada" } } })
      expect(field(s.calls[0]!.form, "template")).toBe("welcome")
      expect(field(s.calls[0]!.form, "t:variables")).toBe('{"name":"Ada"}')
    })

    it("takes an id as the name too, since Mailgun has only names", async () => {
      const s = stub()
      await email(s).send({ ...msg, template: { id: "welcome" } })
      expect(field(s.calls[0]!.form, "template")).toBe("welcome")
    })

    it("refuses a template with neither an alias nor an id", async () => {
      const s = stub()
      const { error } = await email(s).send({ ...msg, template: { variables: { a: 1 } } })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(s.calls).toHaveLength(0)
    })
  })

  describe("attachments", () => {
    it("uploads bytes as a file part, not as text", async () => {
      const s = stub()
      await email(s).send({
        ...msg,
        attachments: [
          {
            filename: "report.pdf",
            content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            contentType: "application/pdf",
          },
        ],
      })
      const file = s.calls[0]!.form.get("attachment") as File
      expect(file.name).toBe("report.pdf")
      expect(file.type).toBe("application/pdf")
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      )
    })

    it("decodes content the caller declared base64, and keeps text as text", async () => {
      const s = stub()
      await email(s).send({
        ...msg,
        attachments: [
          { filename: "a.txt", content: "dGVzdA==", encoding: "base64" },
          { filename: "b.txt", content: "test" },
        ],
      })
      const [a, b] = s.calls[0]!.form.getAll("attachment") as File[]
      expect(await a!.text()).toBe("test")
      expect(await b!.text()).toBe("test")
    })

    it("names an inline part by its cid, which is what cid: resolves against", async () => {
      const s = stub()
      await email(s).send({
        ...msg,
        html: '<img src="cid:logo">',
        attachments: [{ filename: "logo.png", content: new Uint8Array([1]), cid: "logo" }],
      })
      const form = s.calls[0]!.form
      expect(form.get("attachment")).toBeNull()
      expect((form.get("inline") as File).name).toBe("logo")
    })
  })

  describe("limits it refuses before the request", () => {
    it("refuses more than three tags", async () => {
      const s = stub()
      const { error } = await email(s).send({
        ...msg,
        tags: Array.from({ length: 4 }, (_, i) => ({ name: `t${i}`, value: "v" })),
      })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/at most 3 tags/)
      expect(s.calls).toHaveLength(0)
    })

    it("refuses a tag longer than 128 characters", async () => {
      const s = stub()
      const { error } = await email(s).send({
        ...msg,
        tags: [{ name: "x".repeat(129), value: "v" }],
      })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/longer than 128/)
      expect(s.calls).toHaveLength(0)
    })
  })

  describe("batching", () => {
    it("fans one request out with recipient-variables, positionally", async () => {
      const s = stub()
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "Bee <b@x.com>" },
      ])

      expect(s.calls).toHaveLength(1)
      const form = s.calls[0]!.form
      expect(fields(form, "to")).toEqual(["a@x.com", "Bee <b@x.com>"])
      expect(JSON.parse(field(form, "recipient-variables")!)).toEqual({
        "a@x.com": { email: "a@x.com" },
        "b@x.com": { email: "b@x.com", name: "Bee" },
      })
      expect(batch.results.map((r) => r.data?.id)).toEqual([
        "20260901.abc@mg.acme.com",
        "20260901.abc@mg.acme.com",
      ])
    })

    it("splits messages that differ in anything but their recipient", async () => {
      const s = stub()
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com", subject: "one" },
        { ...msg, to: "b@x.com", subject: "two" },
      ])
      expect(s.calls).toHaveLength(2)
      expect(s.calls.every((call) => field(call.form, "recipient-variables") === null)).toBe(true)
      expect(batch.sent).toHaveLength(2)
    })

    it("sends a message with cc, bcc, several recipients or an attachment on its own", async () => {
      const s = stub()
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com", cc: "cc@x.com" },
        { ...msg, to: ["c@x.com", "d@x.com"] },
        { ...msg, to: "e@x.com", attachments: [{ filename: "a.txt", content: "hi" }] },
        { ...msg, to: "f@x.com" },
      ])

      // The two plain messages share a request; the other three cannot,
      // because batch sending fans out on `to` alone.
      expect(s.calls).toHaveLength(4)
      expect(fields(s.calls[0]!.form, "to")).toEqual(["a@x.com", "f@x.com"])
      expect(batch.sent).toHaveLength(5)
      expect(batch.results.map((r) => r.error)).toEqual([null, null, null, null, null])
    })

    it("chunks at the 1000-recipient batch cap", async () => {
      const s = stub()
      const batch = await email(s).sendBatch(
        Array.from({ length: 1500 }, (_, i) => ({ ...msg, to: `a${i}@x.com` })),
      )
      expect(s.calls).toHaveLength(2)
      expect(fields(s.calls[0]!.form, "to")).toHaveLength(1000)
      expect(fields(s.calls[1]!.form, "to")).toHaveLength(500)
      expect(batch.results).toHaveLength(1500)
    })

    it("fails only the message that breaks a limit", async () => {
      const s = stub()
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com", tags: [{ name: "x".repeat(200), value: "v" }] },
        { ...msg, to: "c@x.com" },
      ])
      expect(batch.sent).toHaveLength(2)
      expect(batch.failed).toEqual([
        { index: 1, error: expect.objectContaining({ code: "INVALID_OPTIONS" }) },
      ])
      expect(fields(s.calls[0]!.form, "to")).toEqual(["a@x.com", "c@x.com"])
    })

    it("reports the request's failure against every message in it", async () => {
      const s = stub(() => [429, { message: "account-requests-per-sec limit exceeded" }])
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])
      expect(batch.failed.map((f) => f.index)).toEqual([0, 1])
      expect(batch.failed[0]?.error.code).toBe("RATE_LIMIT")
      expect(batch.failed[0]?.error.retryable).toBe(true)
    })
  })

  describe("errors", () => {
    it("classifies status codes into the shared taxonomy", async () => {
      const cases = [
        [401, "AUTH", false],
        [403, "AUTH", false],
        [429, "RATE_LIMIT", true],
        [500, "NETWORK", true],
        [400, "PROVIDER", false],
      ] as const
      for (const [status, code, retryable] of cases) {
        const s = stub(() => [status, { message: "nope" }])
        const { error } = await email(s).send(msg)
        expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
      }
    })

    it("reads the message out of Mailgun's envelope", async () => {
      const s = stub(() => [400, { message: "to parameter is not a valid address" }])
      const { error } = await email(s).send(msg)
      expect(error?.message).toContain("to parameter is not a valid address")
    })

    it("reads a 401 that answers with a bare string instead of an envelope", async () => {
      const s = stub(() => [401, "Forbidden"])
      const { error } = await email(s).send(msg)
      expect(error?.code).toBe("AUTH")
      expect(error?.message).toContain("Forbidden")
    })

    it("fails when the response carried no id", async () => {
      const s = stub(() => [200, { message: "Queued. Thank you." }])
      const { error } = await email(s).send(msg)
      expect(error?.code).toBe("PROVIDER")
      expect(error?.message).toMatch(/message id/)
    })
  })

  it("cancels an in-flight request when the caller's signal aborts", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(JSON.stringify(queued), { status: 200 })
    }) as unknown as typeof fetch

    await createEmail({
      driver: mailgun({ ...credentials, fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)

    expect(aborted).toBe(true)
  })

  it("forwards a caller-supplied timeout", async () => {
    const seen: (AbortSignal | undefined)[] = []
    const s = stub()
    const spy = (async (url: string | URL, init: RequestInit = {}) => {
      seen.push(init.signal ?? undefined)
      return s.fetch(url, init)
    }) as unknown as typeof fetch

    await createEmail({
      driver: mailgun({ ...credentials, fetch: spy, timeoutMs: 1 }),
      defaults,
    }).send(msg)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })
})
