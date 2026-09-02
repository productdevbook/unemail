import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import cloudflareEmail from "../../src/drivers/cloudflare-email.ts"
import type { CloudflareEmailServiceMessage } from "../../src/drivers/cloudflare-email-service.ts"
import cloudflareEmailRest from "../../src/drivers/cloudflare-email-rest.ts"
import cloudflareEmailService from "../../src/drivers/cloudflare-email-service.ts"
import mailtrap from "../../src/drivers/mailtrap.ts"

const msg = { to: "Ada <ada@example.com>", subject: "s", text: "t" } as const
const defaults = { from: "Acme <hi@acme.com>" }

function stub(payload: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

describe("mailtrap", () => {
  it("requires an api key", () => {
    expect(() => mailtrap({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("maps the message onto the Email API payload", async () => {
    const s = stub({ success: true, message_ids: ["mt_1"] })
    const { data } = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch }),
      defaults,
    }).send({
      ...msg,
      html: "<p>hi</p>",
      cc: "cc@x.com",
      replyTo: "reply@acme.com",
      metadata: { userId: "42" },
      tags: [
        { name: "category", value: "billing" },
        { name: "cohort", value: "beta" },
      ],
    })

    expect(data?.id).toBe("mt_1")
    expect(s.calls[0]!.url).toBe("https://send.api.mailtrap.io/api/send")
    expect(s.calls[0]!.headers["api-token"]).toBe("k")
    expect(s.calls[0]!.body).toMatchObject({
      from: { email: "hi@acme.com", name: "Acme" },
      to: [{ email: "ada@example.com", name: "Ada" }],
      cc: [{ email: "cc@x.com" }],
      reply_to: { email: "reply@acme.com" },
      html: "<p>hi</p>",
      category: "billing",
      custom_variables: { userId: "42", tag_cohort: "beta" },
    })
  })

  it("falls back to the default category when no tag names one", async () => {
    const s = stub({ success: true, message_ids: ["mt_1"] })
    await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch, defaultCategory: "transactional" }),
      defaults,
    }).send(msg)
    expect(s.calls[0]!.body.category).toBe("transactional")
  })

  it("routes a sandbox message to the sandbox host with the inbox in the path", async () => {
    const s = stub({ success: true, message_ids: ["mt_1"] })
    await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch, inboxId: 1234567 }),
      defaults,
    }).send({ ...msg, sandbox: true })
    expect(s.calls[0]!.url).toBe("https://sandbox.api.mailtrap.io/api/send/1234567")
  })

  it("refuses a sandbox send with no inbox id, rather than posting to a bad url", async () => {
    const s = stub({ success: true })
    const { error } = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch, sandbox: true }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/inboxId/)
    expect(s.calls).toHaveLength(0)
  })

  it("refuses a batch that mixes sandbox and live messages", async () => {
    const s = stub({ success: true })
    const batch = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch, inboxId: 1 }),
      defaults,
    }).sendBatch([msg, { ...msg, sandbox: true }])
    expect(batch.ok).toBe(false)
    expect(batch.failed[0]?.error.code).toBe("INVALID_OPTIONS")
    expect(s.calls).toHaveLength(0)
  })

  it("keeps batch results positional", async () => {
    const s = stub({
      success: true,
      responses: [
        { success: true, message_ids: ["a"] },
        { success: false, errors: ["bad to"] },
      ],
    })
    const batch = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch }),
      defaults,
    }).sendBatch([msg, msg])

    expect(s.calls[0]!.url).toBe("https://send.api.mailtrap.io/api/batch")
    expect(batch.sent.map((r) => r.id)).toEqual(["a"])
    expect(batch.failed[0]?.index).toBe(1)
    expect(batch.failed[0]?.error.message).toContain("bad to")
  })

  it("reports a 200 response that says success:false as a failure", async () => {
    const s = stub({ success: false, errors: ["'to' is invalid"] })
    const { error } = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("'to' is invalid")
  })

  it("surfaces the errors array on an HTTP failure", async () => {
    const s = stub({ errors: ["Unauthorized"] }, 401)
    const { error } = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("AUTH")
    expect(error?.message).toContain("Unauthorized")
  })

  it("chunks a batch at Mailtrap's 500-message cap", async () => {
    const s = stub({
      success: true,
      responses: Array.from({ length: 500 }, (_, i) => ({ success: true, message_ids: [`m${i}`] })),
    })
    const batch = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch }),
      defaults,
    }).sendBatch(Array.from({ length: 600 }, () => msg))

    expect(s.calls).toHaveLength(2)
    expect(s.calls[0]!.body.requests).toHaveLength(500)
    expect(s.calls[1]!.body.requests).toHaveLength(100)
    expect(batch.results).toHaveLength(600)
  })

  it("routes to the bulk host when asked", async () => {
    const s = stub({ success: true, message_ids: ["mt_1"] })
    await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch, bulk: true }),
      defaults,
    }).send(msg)
    expect(s.calls[0]!.url).toBe("https://bulk.api.mailtrap.io/api/send")
  })

  it("truncates a category to the documented 255 characters", async () => {
    const s = stub({ success: true, message_ids: ["mt_1"] })
    await createEmail({ driver: mailtrap({ apiKey: "k", fetch: s.fetch }), defaults }).send({
      ...msg,
      tags: [{ name: "category", value: "c".repeat(300) }],
    })
    expect(s.calls[0]!.body.category).toHaveLength(255)
  })

  it("refuses a recipient list past the documented 1000 cap", async () => {
    const s = stub({ success: true })
    const { error } = await createEmail({
      driver: mailtrap({ apiKey: "k", fetch: s.fetch }),
      defaults,
    }).send({ ...msg, to: Array.from({ length: 1001 }, (_, i) => `u${i}@x.com`) })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/at most 1000/)
    expect(s.calls).toHaveLength(0)
  })

  it("declines scheduling, which Mailtrap does not offer", async () => {
    const { error } = await createEmail({
      driver: mailtrap({ apiKey: "k" }),
      defaults,
    }).send({ ...msg, scheduledAt: "2030-01-01T00:00:00Z" })
    expect(error?.code).toBe("UNSUPPORTED")
  })
})

describe("cloudflare-email (Email Routing)", () => {
  const EmailMessage = class {
    constructor(
      readonly from: string,
      readonly to: string,
      readonly raw: string,
    ) {}
  }

  it("requires a binding", () => {
    expect(() => cloudflareEmail({ binding: undefined as never })).toThrow(/missing required/)
  })

  it("explains itself when the EmailMessage constructor is absent", () => {
    expect(() => cloudflareEmail({ binding: { send: vi.fn() } })).toThrow(/EmailMessage/)
  })

  it("hands the binding a raw RFC 5322 document", async () => {
    const send = vi.fn()
    const { data, error } = await createEmail({
      driver: cloudflareEmail({ binding: { send }, EmailMessage }),
      defaults,
    }).send({ ...msg, html: "<p>hi</p>" })

    expect(error).toBeNull()
    expect(data?.id).toMatch(/^<.+@cloudflare-email>$/)

    const sent = send.mock.calls[0]![0] as InstanceType<typeof EmailMessage>
    expect(sent.from).toBe("hi@acme.com")
    expect(sent.to).toBe("ada@example.com")
    expect(sent.raw).toContain("Subject: s")
    expect(sent.raw).toContain("<p>hi</p>")
  })

  it("refuses more than one recipient instead of silently sending to the first", async () => {
    const send = vi.fn()
    const { error } = await createEmail({
      driver: cloudflareEmail({ binding: { send }, EmailMessage }),
      defaults,
    }).send({ ...msg, to: ["a@x.com", "b@x.com"] })

    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/one recipient/)
    expect(send).not.toHaveBeenCalled()
  })

  it("turns a binding throw into a Result", async () => {
    const send = vi.fn(() => {
      throw new Error("not verified")
    })
    const { error } = await createEmail({
      driver: cloudflareEmail({ binding: { send }, EmailMessage }),
      defaults,
    }).send(msg)
    expect(error?.message).toContain("not verified")
  })
})

describe("cloudflare-email-service (Email Sending)", () => {
  it("requires a binding", () => {
    expect(() => cloudflareEmailService({ binding: undefined as never })).toThrow(
      /missing required/,
    )
  })

  it("sends structured fields rather than raw MIME", async () => {
    const send = vi.fn(async (_message: CloudflareEmailServiceMessage) => ({
      messageId: "cf_1",
    }))
    const { data } = await createEmail({
      driver: cloudflareEmailService({ binding: { send } }),
      defaults,
    }).send({
      ...msg,
      html: "<p>hi</p>",
      cc: "cc@x.com",
      replyTo: "reply@acme.com",
      headers: { "X-Campaign": "welcome" },
      attachments: [{ filename: "a.txt", content: "hello", contentType: "text/plain" }],
    })

    expect(data?.id).toBe("cf_1")
    expect(send.mock.calls[0]![0]).toMatchObject({
      from: { email: "hi@acme.com", name: "Acme" },
      to: [{ email: "ada@example.com", name: "Ada" }],
      cc: [{ email: "cc@x.com" }],
      replyTo: { email: "reply@acme.com" },
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      attachments: [
        // base64 of "hello" — a text string must never reach a provider
        // that expects base64 unencoded.
        { filename: "a.txt", content: "aGVsbG8=", type: "text/plain", disposition: "attachment" },
      ],
    })
  })

  it("maps the binding's E_ codes onto the shared taxonomy", async () => {
    const cases = [
      ["E_SENDER_NOT_VERIFIED", "AUTH", false],
      ["E_RATE_LIMIT_EXCEEDED", "RATE_LIMIT", true],
      ["E_DELIVERY_FAILED", "NETWORK", true],
      ["E_VALIDATION_ERROR", "INVALID_OPTIONS", false],
    ] as const

    for (const [code, expected, retryable] of cases) {
      const send = vi.fn(() => {
        throw Object.assign(new Error(code), { code })
      })
      const { error } = await createEmail({
        driver: cloudflareEmailService({ binding: { send } }),
        defaults,
      }).send(msg)
      expect([code, error?.code, error?.retryable]).toEqual([code, expected, retryable])
    }
  })

  it("falls back to PROVIDER for a code it does not know", async () => {
    const send = vi.fn(() => {
      throw Object.assign(new Error("something new"), { code: "E_BRAND_NEW" })
    })
    const { error } = await createEmail({
      driver: cloudflareEmailService({ binding: { send } }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("PROVIDER")
  })

  it("refuses more than 50 recipients before paying for a round trip", async () => {
    const send = vi.fn()
    const { error } = await createEmail({
      driver: cloudflareEmailService({ binding: { send } }),
      defaults,
    }).send({
      ...msg,
      to: Array.from({ length: 51 }, (_, i) => `u${i}@x.com`),
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/the limit is 50/)
    expect(send).not.toHaveBeenCalled()
  })

  it("refuses more than 32 attachments", async () => {
    const send = vi.fn()
    const { error } = await createEmail({
      driver: cloudflareEmailService({ binding: { send } }),
      defaults,
    }).send({
      ...msg,
      attachments: Array.from({ length: 33 }, (_, i) => ({ filename: `${i}.txt`, content: "x" })),
    })
    expect(error?.message).toMatch(/the limit is 32/)
    expect(send).not.toHaveBeenCalled()
  })

  it("reports a response with no messageId rather than an empty id", async () => {
    const send = vi.fn(async () => undefined)
    const { error } = await createEmail({
      driver: cloudflareEmailService({ binding: { send } }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/no messageId/)
  })
})

describe("cloudflare-email-rest (Email Service over HTTP)", () => {
  const opts = { accountId: "acct", apiToken: "tok" }

  it("requires an account id and a token", () => {
    expect(() => cloudflareEmailRest({ ...opts, accountId: "" })).toThrow(/accountId/)
    expect(() => cloudflareEmailRest({ ...opts, apiToken: "" })).toThrow(/apiToken/)
  })

  it("posts to the account's sending endpoint with a bearer token", async () => {
    const s = stub({ success: true, errors: [], result: { delivered: ["ada@example.com"] } })
    const { data, error } = await createEmail({
      driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, html: "<p>hi</p>", cc: "cc@x.com" })

    expect(error).toBeNull()
    expect(data?.driver).toBe("cloudflare-email-rest")
    expect(s.calls[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/email/sending/send",
    )
    expect(s.calls[0]!.headers.authorization).toBe("Bearer tok")
    expect(s.calls[0]!.body).toMatchObject({
      from: { email: "hi@acme.com", name: "Acme" },
      to: [{ email: "ada@example.com", name: "Ada" }],
      cc: [{ email: "cc@x.com" }],
      html: "<p>hi</p>",
    })
  })

  it("base64-encodes attachments", async () => {
    const s = stub({ success: true, result: { delivered: ["a@x.com"] } })
    await createEmail({ driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [{ filename: "n.txt", content: "test" }],
    })
    expect(s.calls[0]!.body.attachments[0].content).toBe("dGVzdA==")
  })

  it("reports a permanent bounce even when other recipients were delivered", async () => {
    const s = stub({
      success: true,
      result: { delivered: ["a@x.com"], permanent_bounces: ["gone@x.com"] },
    })
    const { error } = await createEmail({
      driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, to: ["a@x.com", "gone@x.com"] })

    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("gone@x.com")
    expect(error?.retryable).toBe(false)
  })

  it("fails when nothing was accepted", async () => {
    const s = stub({ success: true, result: { delivered: [], queued: [] } })
    const { error } = await createEmail({
      driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error?.message).toMatch(/no recipient was accepted/)
  })

  it("treats a queued recipient as accepted", async () => {
    const s = stub({ success: true, result: { queued: ["ada@example.com"] } })
    const { error } = await createEmail({
      driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error).toBeNull()
  })

  it("maps Cloudflare's numeric error codes onto the shared taxonomy", async () => {
    const cases = [
      [10101, 401, "AUTH", false],
      [10004, 429, "RATE_LIMIT", true],
      [10200, 400, "INVALID_OPTIONS", false],
      [10002, 500, "NETWORK", true],
    ] as const

    for (const [code, status, expected, retryable] of cases) {
      const s = stub({ success: false, errors: [{ code, message: `err ${code}` }] }, status)
      const { error } = await createEmail({
        driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect([code, error?.code, error?.retryable]).toEqual([code, expected, retryable])
      expect(error?.message).toContain(`err ${code}`)
    }
  })

  it("reports success:false inside a 200 as a failure", async () => {
    const s = stub({ success: false, errors: [{ message: "domain not onboarded" }] })
    const { error } = await createEmail({
      driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error?.message).toContain("domain not onboarded")
  })

  it("refuses more than 50 recipients before the request", async () => {
    const s = stub({ success: true })
    const { error } = await createEmail({
      driver: cloudflareEmailRest({ ...opts, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, to: Array.from({ length: 51 }, (_, i) => `u${i}@x.com`) })
    expect(error?.message).toMatch(/the limit is 50/)
    expect(s.calls).toHaveLength(0)
  })
})
