import { describe, expect, it } from "vitest"
import type { SendContext } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { normalizeMessage } from "../../src/core/message.ts"
import http, { defaultBody } from "../../src/drivers/http.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const endpoint = "https://mail.internal/v1/send"

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  raw: string | undefined
}

/** Records every request and answers with a scripted response. */
function stub(script: (call: Call) => [number, unknown] = () => [200, { id: "gw_1" }]) {
  const calls: Call[] = []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const raw = typeof init.body === "string" ? init.body : undefined
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: raw ? safeJson(raw) : undefined,
      raw,
    }
    calls.push(call)
    const [status, payload] = script(call)
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const ctx: SendContext = { driver: "http", attempt: 1, meta: {} }
const normalized = (over: Partial<Parameters<typeof normalizeMessage>[0]> = {}) =>
  normalizeMessage({ ...msg, ...over }, defaults)

describe("http options", () => {
  it("refuses a missing endpoint", () => {
    expect(() => http({ endpoint: "" })).toThrow(/missing required option/)
  })

  it("posts to the endpoint by default and honors an override", async () => {
    const s = stub()
    const email = createEmail({ driver: http({ endpoint, fetch: s.fetch }), defaults })
    await email.send(msg)
    await createEmail({
      driver: http({ endpoint, method: "PUT", fetch: s.fetch }),
      defaults,
    }).send(msg)

    expect(s.calls.map((c) => [c.url, c.method])).toEqual([
      [endpoint, "POST"],
      [endpoint, "PUT"],
    ])
  })

  it("reports under its own name when given one", async () => {
    const s = stub(() => [500, { message: "down" }])
    const { error } = await createEmail({
      driver: http({ endpoint, name: "gateway", fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error?.driver).toBe("gateway")
    expect(error?.message).toContain("[gateway]")
  })

  it("refuses what the declared features exclude, and nothing when undeclared", async () => {
    const s = stub()
    const declared = await createEmail({
      driver: http({ endpoint, fetch: s.fetch, features: { html: true } }),
      defaults,
    }).send({ ...msg, scheduledAt: "2030-01-01T00:00:00Z" })
    expect(declared.error?.code).toBe("UNSUPPORTED")

    const undeclared = await createEmail({
      driver: http({ endpoint, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, scheduledAt: "2030-01-01T00:00:00Z" })
    expect(undeclared.error).toBeNull()
  })
})

describe("http default payload", () => {
  it("emits the normalized message, JSON-safe", async () => {
    const s = stub()
    await createEmail({ driver: http({ endpoint, fetch: s.fetch }), defaults }).send({
      ...msg,
      cc: "cc@x.com",
      replyTo: "reply@acme.com",
      html: "<p>hi</p>",
      headers: { "X-Trace": "abc" },
      metadata: { userId: "42" },
      tags: [{ name: "campaign", value: "welcome" }],
      idempotencyKey: "order-1",
      scheduledAt: "2030-01-01T00:00:00Z",
    })

    expect(s.calls[0]?.headers["content-type"]).toBe("application/json")
    expect(s.calls[0]?.body).toEqual({
      from: { email: "hi@acme.com", name: "Acme" },
      to: [{ email: "ada@example.com", name: "Ada" }],
      cc: [{ email: "cc@x.com" }],
      bcc: [],
      replyTo: [{ email: "reply@acme.com" }],
      subject: "hi",
      headers: { "X-Trace": "abc" },
      metadata: { userId: "42" },
      tags: [{ name: "campaign", value: "welcome" }],
      attachments: [],
      text: "hello",
      html: "<p>hi</p>",
      idempotencyKey: "order-1",
      scheduledAt: "2030-01-01T00:00:00.000Z",
    })
  })

  it("base64-encodes attachment content and says so", async () => {
    const s = stub()
    await createEmail({ driver: http({ endpoint, fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [
        {
          filename: "a.txt",
          content: new TextEncoder().encode("hello"),
          contentType: "text/plain",
        },
      ],
    })
    const body = s.calls[0]?.body as { attachments: Record<string, unknown>[] }
    expect(body.attachments[0]).toEqual({
      filename: "a.txt",
      content: "aGVsbG8=",
      encoding: "base64",
      contentType: "text/plain",
    })
  })

  it("leaves out a pre-composed MIME document rather than guessing an encoding", () => {
    expect(defaultBody(normalized({ raw: "From: a@b.com\r\n\r\nhi" }))).not.toHaveProperty("raw")
  })
})

describe("http hooks", () => {
  it("lets the caller own the payload", async () => {
    const s = stub()
    await createEmail({
      driver: http({
        endpoint,
        fetch: s.fetch,
        body: (m) => ({ rcpt: m.to.map((a) => a.email), subj: m.subject }),
      }),
      defaults,
    }).send(msg)
    expect(s.calls[0]?.body).toEqual({ rcpt: ["ada@example.com"], subj: "hi" })
  })

  it("sends a string body verbatim, with the caller's content type", async () => {
    const s = stub()
    await createEmail({
      driver: http({
        endpoint,
        fetch: s.fetch,
        headers: { "content-type": "application/xml" },
        body: (m) => `<send><subject>${m.subject}</subject></send>`,
      }),
      defaults,
    }).send(msg)
    expect(s.calls[0]?.raw).toBe("<send><subject>hi</subject></send>")
    expect(s.calls[0]?.headers["content-type"]).toBe("application/xml")
  })

  it("takes the provider's id from extractId", async () => {
    const s = stub(() => [200, { envelope: { ref: "gw_99" } }])
    const { data } = await createEmail({
      driver: http({
        endpoint,
        fetch: s.fetch,
        extractId: (body) => (body as { envelope: { ref: string } }).envelope.ref,
      }),
      defaults,
    }).send(msg)
    expect(data?.id).toBe("gw_99")
    expect(data?.provider).toEqual({ envelope: { ref: "gw_99" } })
  })

  it("finds an id in the usual places without a hook", async () => {
    const cases: [unknown, string][] = [
      [{ id: "a" }, "a"],
      [{ messageId: "b" }, "b"],
      [{ message_id: "c" }, "c"],
      [{ MessageID: "d" }, "d"],
      [{ data: { id: "e" } }, "e"],
      [{ id: 7 }, "7"],
      ["f", "f"],
    ]
    for (const [payload, expected] of cases) {
      const s = stub(() => [200, payload])
      const { data } = await createEmail({
        driver: http({ endpoint, fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(data?.id).toBe(expected)
    }
  })

  it("accepts an empty answer as a send, with a local id", async () => {
    const s = stub(() => [202, null])
    const { data, error } = await createEmail({
      driver: http({ endpoint, name: "gateway", fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error).toBeNull()
    expect(data?.id).toMatch(/^gateway_/)
    expect(data?.provider).toBeUndefined()
  })

  it("keeps a non-object answer on the result rather than dropping it", async () => {
    const s = stub(() => [200, [{ id: "x" }]])
    const { data } = await createEmail({
      driver: http({ endpoint, fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(data?.provider).toEqual({ response: [{ id: "x" }] })
  })

  it("merges static headers and per-message headers over the auth header", async () => {
    const s = stub()
    await createEmail({
      driver: http({
        endpoint,
        fetch: s.fetch,
        auth: { type: "bearer", token: "tok" },
        headers: (m) => ({ "x-idempotency": m.idempotencyKey ?? "", "x-tenant": "acme" }),
      }),
      defaults,
    }).send({ ...msg, idempotencyKey: "order-1" })

    expect(s.calls[0]?.headers).toMatchObject({
      authorization: "Bearer tok",
      "x-idempotency": "order-1",
      "x-tenant": "acme",
    })
  })

  it("builds each auth shape", async () => {
    const s = stub()
    const send = (auth: Parameters<typeof http>[0]["auth"]) =>
      createEmail({ driver: http({ endpoint, fetch: s.fetch, auth }), defaults }).send(msg)

    await send({ type: "bearer", token: "tok" })
    await send({ type: "basic", username: "ada", password: "s3cret" })
    await send({ type: "header", name: "x-api-key", value: "k" })

    expect(s.calls[0]?.headers.authorization).toBe("Bearer tok")
    expect(s.calls[1]?.headers.authorization).toBe(`Basic ${btoa("ada:s3cret")}`)
    expect(s.calls[2]?.headers["x-api-key"]).toBe("k")
  })
})

describe("http error classification", () => {
  it("falls back to the shared status taxonomy", async () => {
    const cases = [
      [401, "AUTH", false],
      [429, "RATE_LIMIT", true],
      [500, "NETWORK", true],
      [422, "PROVIDER", false],
    ] as const
    for (const [status, code, retryable] of cases) {
      const s = stub(() => [status, { message: "nope" }])
      const { error } = await createEmail({
        driver: http({ endpoint, fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect([status, error?.code, error?.retryable, error?.message]).toEqual([
        status,
        code,
        retryable,
        "[unemail] [http] nope",
      ])
    }
  })

  it("lets classify reach the taxonomy where the status code cannot", async () => {
    const s = stub(() => [409, { reason: "throttled" }])
    const { error } = await createEmail({
      driver: http({
        endpoint,
        fetch: s.fetch,
        classify: (status, body) =>
          status === 409 && (body as { reason?: string }).reason === "throttled"
            ? { code: "RATE_LIMIT", message: "gateway is throttling", retryable: true }
            : null,
      }),
      defaults,
    }).send(msg)

    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
    expect(error?.message).toContain("gateway is throttling")
  })

  it("uses the status default when classify declines", async () => {
    const s = stub(() => [503, { message: "maintenance" }])
    const { error } = await createEmail({
      driver: http({ endpoint, fetch: s.fetch, classify: () => null }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("NETWORK")
  })

  it("does not throw past its own boundary when fetch rejects", async () => {
    const broken = (async () => {
      throw new TypeError("connection refused")
    }) as unknown as typeof fetch
    const driver = http({ endpoint, fetch: broken })
    await expect(driver.send(normalized(), ctx)).resolves.toMatchObject({
      error: expect.objectContaining({ code: "PROVIDER" }),
    })
  })
})

describe("http cancellation", () => {
  it("forwards the caller's signal to the request", async () => {
    const controller = new AbortController()
    const hanging = ((_url: string, init: RequestInit = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
        controller.abort()
      })
    }) as unknown as typeof fetch

    const driver = http({ endpoint, fetch: hanging })
    const { error } = await driver.send(normalized(), { ...ctx, signal: controller.signal })
    expect(error?.code).toBe("CANCELLED")
  })

  it("abandons a request that outlives timeoutMs", async () => {
    const hanging = ((_url: string, init: RequestInit = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
    }) as unknown as typeof fetch

    const driver = http({ endpoint, fetch: hanging, timeoutMs: 5 })
    const { error } = await driver.send(normalized(), ctx)
    // A deadline is transient, so it must stay retryable — a cancellation
    // is a decision and would tell retry to give up.
    expect(error?.code).toBe("TIMEOUT")
    expect(error?.retryable).toBe(true)
  })
})

describe("http batches", () => {
  it("keeps one result per message, in order", async () => {
    const s = stub((call) => {
      const subject = (call.body as { subject: string }).subject
      return subject === "b" ? [422, { message: "rejected" }] : [200, { id: subject }]
    })
    const batch = await createEmail({
      driver: http({ endpoint, fetch: s.fetch }),
      defaults,
    }).sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b" },
      { ...msg, subject: "c" },
    ])

    expect(s.calls).toHaveLength(3)
    expect(batch.results.map((r) => r.data?.id ?? r.error?.code)).toEqual(["a", "PROVIDER", "c"])
    expect(batch.failed).toEqual([{ index: 1, error: expect.objectContaining({ status: 422 }) }])
  })
})
