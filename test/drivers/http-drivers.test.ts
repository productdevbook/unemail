import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import postmark from "../../src/drivers/postmark.ts"
import resend from "../../src/drivers/resend.ts"
import ses from "../../src/drivers/ses.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }

/** Records every request and answers with a scripted response. */
function stubFetch(script: (url: string, init: RequestInit) => [number, unknown]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
    []
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

describe("resend", () => {
  it("rejects a key that is not a Resend key", () => {
    expect(() => resend({ apiKey: "sk_live_nope" })).toThrow(/must start with 're_'/)
    expect(() => resend({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("maps the message onto Resend's payload", async () => {
    const stub = stubFetch(() => [200, { id: "re_1" }])
    const email = createEmail({
      driver: resend({ apiKey: "re_test", fetch: stub.fetch }),
      defaults,
    })
    const { data } = await email.send({
      ...msg,
      cc: "cc@x.com",
      replyTo: "reply@acme.com",
      html: "<p>hi</p>",
      tags: [{ name: "campaign", value: "welcome" }],
      metadata: { userId: "42" },
      scheduledAt: "2030-01-01T00:00:00Z",
    })

    expect(data?.id).toBe("re_1")
    const [call] = stub.calls
    expect(call?.url).toBe("https://api.resend.com/emails")
    expect(call?.headers.authorization).toBe("Bearer re_test")
    expect(call?.body).toMatchObject({
      from: "Acme <hi@acme.com>",
      to: ["Ada <ada@example.com>"],
      cc: ["cc@x.com"],
      reply_to: ["reply@acme.com"],
      subject: "hi",
      html: "<p>hi</p>",
      tags: [{ name: "campaign", value: "welcome" }],
      scheduled_at: "2030-01-01T00:00:00.000Z",
      headers: { "X-Metadata-userId": "42" },
    })
  })

  it("forwards the idempotency key as a header", async () => {
    const stub = stubFetch(() => [200, { id: "re_1" }])
    await createEmail({ driver: resend({ apiKey: "re_x", fetch: stub.fetch }), defaults }).send({
      ...msg,
      idempotencyKey: "welcome:1",
    })
    expect(stub.calls[0]?.headers["idempotency-key"]).toBe("welcome:1")
  })

  it("base64-encodes attachment bytes", async () => {
    const stub = stubFetch(() => [200, { id: "re_1" }])
    await createEmail({ driver: resend({ apiKey: "re_x", fetch: stub.fetch }), defaults }).send({
      ...msg,
      attachments: [
        {
          filename: "a.txt",
          content: new TextEncoder().encode("hello"),
          contentType: "text/plain",
        },
      ],
    })
    const body = stub.calls[0]!.body as { attachments: { content: string }[] }
    const attachment = body.attachments[0]
    expect(attachment?.content).toBe("aGVsbG8=")
  })

  it("classifies status codes into the shared taxonomy", async () => {
    const cases = [
      [401, "AUTH", false],
      [429, "RATE_LIMIT", true],
      [500, "NETWORK", true],
      [422, "PROVIDER", false],
    ] as const
    for (const [status, code, retryable] of cases) {
      const stub = stubFetch(() => [status, { message: "nope" }])
      const { error } = await createEmail({
        driver: resend({ apiKey: "re_x", fetch: stub.fetch }),
        defaults,
      }).send(msg)
      expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
    }
  })

  it("maps a batch positionally", async () => {
    const stub = stubFetch(() => [200, { data: [{ id: "a" }, { id: "b" }] }])
    const batch = await createEmail({
      driver: resend({ apiKey: "re_x", fetch: stub.fetch }),
      defaults,
    }).sendBatch([msg, msg])
    expect(stub.calls[0]?.url).toBe("https://api.resend.com/emails/batch")
    expect(batch.sent.map((r) => r.id)).toEqual(["a", "b"])
  })

  it("cancels and retrieves", async () => {
    const stub = stubFetch((url) =>
      url.endsWith("/cancel") ? [200, {}] : [200, { id: "re_1", last_event: "delivered" }],
    )
    const email = createEmail({ driver: resend({ apiKey: "re_x", fetch: stub.fetch }), defaults })
    expect((await email.cancel("re_1")).error).toBeNull()
    expect((await email.retrieve("re_1")).data?.state).toBe("delivered")
  })
})

describe("postmark", () => {
  it("maps the message onto Postmark's payload", async () => {
    const stub = stubFetch(() => [200, { MessageID: "pm_1", SubmittedAt: "2030-01-01T00:00:00Z" }])
    const email = createEmail({
      driver: postmark({ token: "tok", messageStream: "outbound", fetch: stub.fetch }),
      defaults,
    })
    const { data } = await email.send({
      ...msg,
      html: "<p>hi</p>",
      tracking: { opens: true, clicks: false },
      metadata: { userId: "42" },
    })

    expect(data?.id).toBe("pm_1")
    expect(stub.calls[0]?.headers["x-postmark-server-token"]).toBe("tok")
    expect(stub.calls[0]?.body).toMatchObject({
      From: "Acme <hi@acme.com>",
      To: "Ada <ada@example.com>",
      HtmlBody: "<p>hi</p>",
      TrackOpens: true,
      TrackLinks: "None",
      Metadata: { userId: "42" },
      MessageStream: "outbound",
    })
  })

  it("routes a message's own stream over the driver default", async () => {
    const stub = stubFetch(() => [200, { MessageID: "pm_1" }])
    await createEmail({
      driver: postmark({ token: "t", messageStream: "outbound", fetch: stub.fetch }),
      defaults,
    }).send({ ...msg, stream: "broadcast" })
    expect((stub.calls[0]!.body as { MessageStream: string }).MessageStream).toBe("broadcast")
  })

  it("carries extra tags as metadata instead of dropping them", async () => {
    const stub = stubFetch(() => [200, { MessageID: "pm_1" }])
    await createEmail({ driver: postmark({ token: "t", fetch: stub.fetch }), defaults }).send({
      ...msg,
      tags: [
        { name: "first", value: "1" },
        { name: "second", value: "2" },
      ],
    })
    expect(stub.calls[0]?.body).toMatchObject({ Tag: "first", Metadata: { second: "2" } })
  })

  it("surfaces a per-message failure inside a 200 batch response", async () => {
    const stub = stubFetch(() => [
      200,
      [{ MessageID: "pm_1" }, { ErrorCode: 300, Message: "invalid recipient" }],
    ])
    const batch = await createEmail({
      driver: postmark({ token: "t", fetch: stub.fetch }),
      defaults,
    }).sendBatch([msg, msg])

    expect(batch.ok).toBe(false)
    expect(batch.sent).toHaveLength(1)
    expect(batch.failed[0]).toMatchObject({ index: 1 })
    expect(batch.failed[0]?.error.message).toContain("invalid recipient")
    expect(batch.failed[0]?.error.retryable).toBe(false)
  })

  it("treats ErrorCode 10 as an auth failure whatever the status says", async () => {
    const stub = stubFetch(() => [422, { ErrorCode: 10, Message: "bad token" }])
    const { error } = await createEmail({
      driver: postmark({ token: "t", fetch: stub.fetch }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("AUTH")
  })

  it("refuses a batch that mixes templated and plain messages", async () => {
    const stub = stubFetch(() => [200, []])
    const batch = await createEmail({
      driver: postmark({ token: "t", fetch: stub.fetch }),
      defaults,
    }).sendBatch([msg, { ...msg, template: { alias: "welcome" } }])
    expect(batch.ok).toBe(false)
    expect(batch.failed[0]?.error.code).toBe("INVALID_OPTIONS")
    expect(stub.calls).toHaveLength(0)
  })
})

describe("ses", () => {
  const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret" }

  it("requires a region and credentials", () => {
    expect(() => ses({ region: "" })).toThrow(/missing required option/)
    expect(() => ses({ region: "eu-central-1", accessKeyId: "", secretAccessKey: "" })).toThrow(
      /no credentials/,
    )
  })

  it("posts a signed, base64 raw MIME document", async () => {
    const stub = stubFetch(() => [200, { MessageId: "ses_1" }])
    const { data } = await createEmail({
      driver: ses({
        region: "eu-central-1",
        ...credentials,
        fetch: stub.fetch,
        now: () => new Date("2030-01-01T00:00:00Z"),
      }),
      defaults,
    }).send({ ...msg, bcc: "hidden@x.com" })

    expect(data?.id).toBe("ses_1")
    const call = stub.calls[0]!
    expect(call.url).toBe("https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails")
    expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/)

    const body = call.body as {
      Destination: { ToAddresses: string[] }
      Content: { Raw: { Data: string } }
    }
    // Bcc belongs on the envelope and must not appear in the document.
    expect(body.Destination.ToAddresses).toEqual(["ada@example.com", "hidden@x.com"])
    const raw = Buffer.from(body.Content.Raw.Data, "base64").toString("utf8")
    expect(raw).toContain("Subject: hi")
    expect(raw).not.toMatch(/^Bcc:/m)
  })

  it("reads credentials from the environment when none are passed", async () => {
    const previous = process.env.AWS_ACCESS_KEY_ID
    process.env.AWS_ACCESS_KEY_ID = "AKIAENV"
    process.env.AWS_SECRET_ACCESS_KEY = "envsecret"
    try {
      expect(() => ses({ region: "us-east-1" })).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.AWS_ACCESS_KEY_ID
      else process.env.AWS_ACCESS_KEY_ID = previous
      delete process.env.AWS_SECRET_ACCESS_KEY
    }
  })

  it("classifies an expired token as AUTH, not as a generic 400", async () => {
    const stub = stubFetch(() => [400, { __type: "InvalidClientTokenId", message: "expired" }])
    const { error } = await createEmail({
      driver: ses({ region: "eu-central-1", ...credentials, fetch: stub.fetch }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
  })

  it("classifies throttling as a retryable rate limit", async () => {
    const stub = stubFetch(() => [400, { __type: "Throttling", message: "slow down" }])
    const { error } = await createEmail({
      driver: ses({ region: "eu-central-1", ...credentials, fetch: stub.fetch }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
  })
})
