import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import mailbreeze from "../../src/drivers/mailbreeze.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const LIVE_KEY = "sk_live_abc"
const TEST_KEY = "sk_test_abc"
const SEND_URL = "https://api.mailbreeze.com/v1/emails"

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

const accepted = (data: Record<string, unknown> = { messageId: "msg_1" }) => ({
  success: true,
  data,
  meta: { requestId: "req_1", path: "/api/v1/emails" },
})

describe("mailbreeze", () => {
  it("rejects a key that is not a MailBreeze key", () => {
    expect(() => mailbreeze({ apiKey: "re_nope" })).toThrow(/must start with 'sk_live_'/)
    expect(() => mailbreeze({ apiKey: "" })).toThrow(/missing required option/)
    expect(() => mailbreeze({ apiKey: TEST_KEY })).not.toThrow()
  })

  it("maps the message onto MailBreeze's payload", async () => {
    const s = stub(() => [200, accepted()])
    const { data } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send({
      ...msg,
      cc: "cc@x.com",
      bcc: "bcc@x.com",
      replyTo: "reply@acme.com",
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
      idempotencyKey: "welcome:1",
    })

    expect(data?.id).toBe("msg_1")
    const call = s.calls[0]!
    expect(call.url).toBe(SEND_URL)
    expect(call.method).toBe("POST")
    expect(call.headers["x-api-key"]).toBe(LIVE_KEY)
    expect(call.body).toEqual({
      from: "Acme <hi@acme.com>",
      to: ["Ada <ada@example.com>"],
      subject: "hi",
      cc: ["cc@x.com"],
      bcc: ["bcc@x.com"],
      text: "hello",
      html: "<p>hi</p>",
      replyTo: "reply@acme.com",
      idempotencyKey: "welcome:1",
      headers: { "X-Campaign": "welcome", "X-Metadata-userId": "42" },
    })
  })

  it("joins several reply addresses instead of dropping all but one", async () => {
    const s = stub(() => [200, accepted()])
    await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, replyTo: ["a@x.com", "Bee <b@x.com>"] })

    expect(s.calls[0]!.body.replyTo).toBe("a@x.com, Bee <b@x.com>")
  })

  it("sends a template without inventing a subject for it", async () => {
    const s = stub(() => [200, accepted()])
    await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send({
      to: "ada@example.com",
      template: { alias: "welcome-template", variables: { name: "Ada" } },
    })

    expect(s.calls[0]!.body).toEqual({
      from: "Acme <hi@acme.com>",
      to: ["ada@example.com"],
      templateId: "welcome-template",
      variables: { name: "Ada" },
    })
    expect(s.calls[0]!.body).not.toHaveProperty("subject")
  })

  it("refuses a template that names neither an id nor an alias", async () => {
    const s = stub(() => [200, accepted()])
    const { error } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send({ to: "ada@example.com", template: { variables: { name: "Ada" } } })

    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(s.calls).toHaveLength(0)
  })

  it("refuses an idempotency key longer than MailBreeze accepts", async () => {
    const s = stub(() => [200, accepted()])
    const { error } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, idempotencyKey: "k".repeat(257) })

    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toContain("at most 256")
    expect(s.calls).toHaveLength(0)
  })

  it("refuses `sandbox` on a live key rather than sending it for real", async () => {
    const s = stub(() => [200, accepted()])
    const { error } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, sandbox: true })

    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toContain("property of the API key")
    expect(s.calls).toHaveLength(0)
  })

  it("accepts `sandbox` on a test key", async () => {
    const s = stub(() => [200, accepted({ messageId: "sandbox_1", sandbox: true })])
    const { data, error } = await createEmail({
      driver: mailbreeze({ apiKey: TEST_KEY, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, sandbox: true })

    expect(error).toBeNull()
    expect(data?.id).toBe("sandbox_1")
  })

  it("carries the response's sandbox flag through to the caller", async () => {
    const simulated = stub(() => [
      200,
      accepted({ messageId: "sandbox_1", sandbox: true, message: "Email simulated (test mode)" }),
    ])
    const test = await createEmail({
      driver: mailbreeze({ apiKey: TEST_KEY, fetch: simulated.fetch }),
      defaults,
    }).send(msg)
    expect(test.data?.provider).toMatchObject({ sandbox: true })

    // A live send omits the flag; it still reads as a boolean, so a caller
    // can ask the question without knowing which key was used.
    const real = stub(() => [200, accepted()])
    const live = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: real.fetch }),
      defaults,
    }).send(msg)
    expect(live.data?.provider).toMatchObject({ sandbox: false })
  })

  it("reads an id from either the envelope or an unwrapped body", async () => {
    for (const [payload, id] of [
      [accepted({ id: "em_1", messageId: "msg_1" }), "em_1"],
      [accepted({ messageId: "msg_1" }), "msg_1"],
      [{ messageId: "msg_1" }, "msg_1"],
    ] as const) {
      const s = stub(() => [200, payload])
      const { data } = await createEmail({
        driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(data?.id).toBe(id)
    }
  })

  it("reports a response with no id as a provider failure", async () => {
    const s = stub(() => [200, accepted({})])
    const { error } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("did not contain an email id")
  })

  it("treats a 200 that says success: false as a failure", async () => {
    const s = stub(() => [
      200,
      {
        success: false,
        error: { code: "SPAM_SCORE_TOO_HIGH", message: "content flagged as spam" },
      },
    ])
    const { error } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send(msg)

    expect(error?.code).toBe("PROVIDER")
    expect(error?.retryable).toBe(false)
    expect(error?.message).toContain("content flagged as spam")
  })

  it("classifies status codes into the shared taxonomy", async () => {
    const cases = [
      [401, "AUTH", false],
      [403, "AUTH", false],
      [429, "RATE_LIMIT", true],
      [500, "NETWORK", true],
      [422, "PROVIDER", false],
    ] as const
    for (const [status, code, retryable] of cases) {
      const s = stub(() => [status, { success: false, error: { code: "X", message: "nope" } }])
      const { error } = await createEmail({
        driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
    }
  })

  it("surfaces the message out of MailBreeze's error envelope", async () => {
    const s = stub(() => [
      400,
      {
        success: false,
        error: {
          code: "INVALID_EMAIL",
          message: "Invalid email address format",
          details: { field: "to" },
        },
      },
    ])
    const { error } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send(msg)

    expect(error?.message).toContain("Invalid email address format")
  })

  it("does not blame the key for a domain that has sending switched off", async () => {
    const s = stub(() => [
      403,
      { success: false, error: { code: "SENDING_DISABLED", message: "sending is disabled" } },
    ])
    const { error } = await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: s.fetch }),
      defaults,
    }).send(msg)

    expect(error?.code).toBe("PROVIDER")
    expect(error?.retryable).toBe(false)
  })

  it("refuses what its features do not claim", async () => {
    const email = createEmail({ driver: mailbreeze({ apiKey: LIVE_KEY }), defaults })

    for (const extra of [
      // The send endpoint takes uploaded attachment ids, never content.
      { attachments: [{ filename: "a.txt", content: "hi" }] },
      { scheduledAt: "2030-01-01T00:00:00Z" },
    ]) {
      const { error } = await email.send({ ...msg, ...extra })
      expect(error?.code).toBe("UNSUPPORTED")
    }
  })

  it("cancels an in-flight request when the instance signal aborts", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(JSON.stringify(accepted()), { status: 200 })
    }) as unknown as typeof fetch

    await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)

    expect(aborted).toBe(true)
  })

  it("forwards a caller-supplied timeout", async () => {
    const seen: (AbortSignal | undefined)[] = []
    const s = stub(() => [200, accepted()])
    const spy = (async (url: string | URL, init: RequestInit = {}) => {
      seen.push(init.signal ?? undefined)
      return s.fetch(url, init)
    }) as unknown as typeof fetch

    await createEmail({
      driver: mailbreeze({ apiKey: LIVE_KEY, fetch: spy, timeoutMs: 1 }),
      defaults,
    }).send(msg)

    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })
})
