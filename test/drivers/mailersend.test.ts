import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import mailersend from "../../src/drivers/mailersend.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const MESSAGE_ID = "63daa73a6b1e6f0e7c0a1d2e"

/** Records every request and answers with a scripted response. MailerSend
 *  returns the message id in a header, so the script may set those too. */
function stub(script: (url: string, body: any) => [number, unknown, Record<string, string>?]) {
  const calls: {
    url: string
    method: string
    headers: Record<string, string>
    body: any
    signal?: AbortSignal
  }[] = []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined
    const [status, payload, headers = {}] = script(url, body)
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
      ...(init.signal ? { signal: init.signal } : {}),
    })
    return new Response(payload == null ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

/** Every send answers 202 with the id only in the header, as the real API does. */
const accepted = () => stub(() => [202, null, { "x-message-id": MESSAGE_ID }])

function driver(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  return createEmail({
    driver: mailersend({ apiKey: "k", fetch: fetchImpl, ...options }),
    defaults,
  })
}

describe("mailersend", () => {
  it("requires an api key", () => {
    expect(() => mailersend({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("maps the message onto MailerSend's payload", async () => {
    const s = accepted()
    const sendAt = new Date(Date.now() + 60 * 60 * 1000)
    const { data } = await driver(s.fetch, { precedenceBulk: true }).send({
      ...msg,
      html: "<p>hi</p>",
      cc: "cc@x.com",
      bcc: "bcc@x.com",
      replyTo: ["Support <reply@acme.com>", "second@acme.com"],
      headers: { "X-Custom": "1" },
      metadata: { userId: "42" },
      tracking: { opens: true, clicks: false },
      scheduledAt: sendAt,
      template: { id: "tpl_1", variables: { name: "Ada" } },
    })

    expect(data?.id).toBe(MESSAGE_ID)
    expect(s.calls[0]!.url).toBe("https://api.mailersend.com/v1/email")
    expect(s.calls[0]!.headers.authorization).toBe("Bearer k")
    expect(s.calls[0]!.body).toEqual({
      from: { email: "hi@acme.com", name: "Acme" },
      to: [{ email: "ada@example.com", name: "Ada" }],
      cc: [{ email: "cc@x.com" }],
      bcc: [{ email: "bcc@x.com" }],
      // MailerSend takes a single reply-to, so only the first survives.
      reply_to: { email: "reply@acme.com", name: "Support" },
      subject: "hi",
      text: "hello",
      html: "<p>hi</p>",
      headers: [
        { name: "X-Custom", value: "1" },
        { name: "X-Metadata-userId", value: "42" },
      ],
      template_id: "tpl_1",
      personalization: [{ email: "ada@example.com", data: { name: "Ada" } }],
      settings: { track_opens: true, track_clicks: false },
      precedence_bulk: true,
      send_at: Math.floor(sendAt.getTime() / 1000),
    })
  })

  it("repeats personalization for every recipient rather than only the first", async () => {
    const s = accepted()
    await driver(s.fetch).send({
      ...msg,
      to: ["one@x.com", "two@x.com"],
      template: { id: "tpl", variables: { plan: "pro" } },
    })
    expect(s.calls[0]!.body.personalization).toEqual([
      { email: "one@x.com", data: { plan: "pro" } },
      { email: "two@x.com", data: { plan: "pro" } },
    ])
  })

  it("lifts In-Reply-To, References and List-Unsubscribe into their own fields", async () => {
    const s = accepted()
    await driver(s.fetch).send({
      ...msg,
      headers: { "In-Reply-To": "<a@x>", References: "<a@x> <b@x>", "X-Keep": "yes" },
      unsubscribe: { url: "https://acme.com/u" },
    })
    const body = s.calls[0]!.body
    expect(body.in_reply_to).toBe("<a@x>")
    expect(body.references).toEqual(["<a@x>", "<b@x>"])
    expect(body.list_unsubscribe).toBe("<https://acme.com/u>")
    expect(body.headers).toEqual([{ name: "X-Keep", value: "yes" }])
  })

  it("carries tag values as headers, since MailerSend tags are bare strings", async () => {
    const s = accepted()
    await driver(s.fetch).send({
      ...msg,
      tags: [
        { name: "campaign", value: "welcome" },
        { name: "cohort", value: "beta" },
      ],
    })
    expect(s.calls[0]!.body.tags).toEqual(["campaign", "cohort"])
    expect(s.calls[0]!.body.headers).toEqual([
      { name: "X-Tag-campaign", value: "welcome" },
      { name: "X-Tag-cohort", value: "beta" },
    ])
  })

  it("base64-encodes attachments and marks a cid one inline", async () => {
    const s = accepted()
    await driver(s.fetch).send({
      ...msg,
      attachments: [
        { filename: "a.txt", content: new TextEncoder().encode("hello") },
        { filename: "logo.png", content: "aGVsbG8=", encoding: "base64", cid: "logo" },
      ],
    })
    expect(s.calls[0]!.body.attachments).toEqual([
      { filename: "a.txt", content: "aGVsbG8=", disposition: "attachment" },
      { filename: "logo.png", content: "aGVsbG8=", disposition: "inline", id: "logo" },
    ])
  })

  it("reports a send whose response carries no message id", async () => {
    const s = stub(() => [202, null])
    const { error } = await driver(s.fetch).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/x-message-id/)
  })

  it("sends a batch to the bulk endpoint and answers positionally", async () => {
    const s = stub(() => [202, { bulk_email_id: "bulk_1" }])
    const batch = await driver(s.fetch).sendBatch([msg, { ...msg, to: "two@x.com" }])
    expect(s.calls[0]!.url).toBe("https://api.mailersend.com/v1/bulk-email")
    expect(s.calls[0]!.body).toHaveLength(2)
    expect(s.calls[0]!.body[1].to).toEqual([{ email: "two@x.com" }])
    // The bulk endpoint issues one id for the request, not one per message.
    expect(batch.sent.map((r) => r.id)).toEqual(["bulk_1", "bulk_1"])
  })

  it("chunks a batch at 500 messages per bulk request", async () => {
    const s = stub(() => [202, { bulk_email_id: "bulk" }])
    const batch = await driver(s.fetch).sendBatch(
      Array.from({ length: 501 }, (_, i) => ({ ...msg, to: `r${i}@x.com` })),
    )
    expect(s.calls.map((call) => call.body.length)).toEqual([500, 1])
    expect(batch.results).toHaveLength(501)
    expect(batch.ok).toBe(true)
  })

  it("fails only the messages that break a MailerSend cap, and sends the rest", async () => {
    const s = stub(() => [202, { bulk_email_id: "bulk" }])
    const batch = await driver(s.fetch).sendBatch([
      msg,
      { ...msg, tags: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, value: "v" })) },
      { ...msg, to: "three@x.com" },
    ])
    expect(s.calls[0]!.body).toHaveLength(2)
    expect(batch.failed).toEqual([
      { index: 1, error: expect.objectContaining({ code: "INVALID_OPTIONS" }) },
    ])
    expect(batch.results[0]?.data?.id).toBe("bulk")
    expect(batch.results[2]?.data?.id).toBe("bulk")
  })

  it("refuses the recipient and tag counts MailerSend rejects, without a round trip", async () => {
    const s = accepted()
    const email = driver(s.fetch)
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ to: Array.from({ length: 51 }, (_, i) => `r${i}@x.com`) }, /at most 50 `to`/],
      [{ cc: Array.from({ length: 11 }, (_, i) => `c${i}@x.com`) }, /at most 10 `cc`/],
      [{ bcc: Array.from({ length: 11 }, (_, i) => `b${i}@x.com`) }, /at most 10 `bcc`/],
      [{ tags: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, value: "v" })) }, /at most 5/],
    ]
    for (const [overrides, pattern] of cases) {
      const { error } = await email.send({ ...msg, ...overrides })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(pattern)
    }
    expect(s.calls).toHaveLength(0)
  })

  it("refuses a send scheduled beyond MailerSend's 72 hour window", async () => {
    const s = accepted()
    const { error } = await driver(s.fetch).send({
      ...msg,
      scheduledAt: new Date(Date.now() + 73 * 60 * 60 * 1000),
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/72 hours/)
    expect(s.calls).toHaveLength(0)

    const ok = accepted()
    expect((await driver(ok.fetch).send({ ...msg, scheduledAt: "2030-01-01" })).error?.code).toBe(
      "INVALID_OPTIONS",
    )
  })

  it("classifies status codes into the shared taxonomy", async () => {
    const cases = [
      [401, "AUTH", false],
      [429, "RATE_LIMIT", true],
      [500, "NETWORK", true],
      [422, "PROVIDER", false],
    ] as const
    for (const [status, code, retryable] of cases) {
      const s = stub(() => [status, { message: "nope" }])
      const { error } = await driver(s.fetch).send(msg)
      expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
    }
  })

  it("reports the per-field reasons out of a 422 rather than the generic sentence", async () => {
    const s = stub(() => [
      422,
      {
        message: "The given data was invalid.",
        errors: {
          "from.email": ["The from.email must be a verified domain. #MS42207"],
          "to.0.email": ["Invalid email."],
        },
      },
    ])
    const { error } = await driver(s.fetch).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("from.email: The from.email must be a verified domain")
    expect(error?.message).toContain("to.0.email: Invalid email.")
  })

  it("forwards the caller's abort signal into the request", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(null, { status: 202, headers: { "x-message-id": MESSAGE_ID } })
    }) as unknown as typeof fetch

    await createEmail({
      driver: mailersend({ apiKey: "k", fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)
    expect(aborted).toBe(true)
  })

  it("forwards the abort signal on the bulk path too", async () => {
    const s = stub(() => [202, { bulk_email_id: "bulk" }])
    const controller = new AbortController()
    await createEmail({
      driver: mailersend({ apiKey: "k", fetch: s.fetch }),
      defaults,
      signal: controller.signal,
    }).sendBatch([msg, msg])
    expect(s.calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it("cancels a scheduled message", async () => {
    const s = stub(() => [204, null])
    const { error } = await driver(s.fetch).cancel(MESSAGE_ID)
    expect(error).toBeNull()
    expect(s.calls[0]!.method).toBe("DELETE")
    expect(s.calls[0]!.url).toBe(`https://api.mailersend.com/v1/message-schedules/${MESSAGE_ID}`)
  })

  it("retrieves a message and maps its status", async () => {
    const cases = [
      ["queued", "queued"],
      ["sent", "sent"],
      ["delivered", "delivered"],
      ["soft_bounced", "bounced"],
      ["hard_bounced", "bounced"],
      ["spam_complaint", "complained"],
      ["rejected", "failed"],
      ["something-new", "unknown"],
    ] as const
    for (const [status, state] of cases) {
      const s = stub(() => [
        200,
        { data: { id: MESSAGE_ID, created_at: "2030-01-01T00:00:00Z", emails: [{ status }] } },
      ])
      const { data } = await driver(s.fetch).retrieve(MESSAGE_ID)
      expect(s.calls[0]!.url).toBe(`https://api.mailersend.com/v1/messages/${MESSAGE_ID}`)
      expect(data?.state).toBe(state)
      expect(data?.at?.toISOString()).toBe("2030-01-01T00:00:00.000Z")
    }
  })

  it("falls back to the bulk endpoint for an id the message endpoint does not know", async () => {
    const s = stub((url) =>
      url.includes("/v1/messages/")
        ? [404, { message: "Not found." }]
        : [200, { data: { id: "bulk_1", state: "completed" } }],
    )
    const { data } = await driver(s.fetch).retrieve("bulk_1")
    expect(s.calls.map((call) => call.url)).toEqual([
      "https://api.mailersend.com/v1/messages/bulk_1",
      "https://api.mailersend.com/v1/bulk-email/bulk_1",
    ])
    expect(data?.state).toBe("sent")
  })

  it("does not chase the bulk endpoint on a failure that is not a 404", async () => {
    const s = stub(() => [401, { message: "Unauthenticated." }])
    const { error } = await driver(s.fetch).retrieve(MESSAGE_ID)
    expect(error?.code).toBe("AUTH")
    expect(s.calls).toHaveLength(1)
  })

  it("declares every feature it actually implements", () => {
    const instance = mailersend({ apiKey: "k", fetch: (() => {}) as unknown as typeof fetch })
    expect(instance.features).toMatchObject({
      attachments: true,
      batch: true,
      scheduling: true,
      tracking: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      cancelable: true,
      retrievable: true,
    })
    expect(instance.features?.idempotency).toBeUndefined()
    expect(typeof instance.cancel).toBe("function")
    expect(typeof instance.retrieve).toBe("function")
    expect(typeof instance.sendBatch).toBe("function")
  })
})
