import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import brevo from "../../src/drivers/brevo.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }

/** Records every request and answers with a scripted response. */
function stub(script: (url: string, body: any) => [number, unknown]) {
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
    const [status, payload] = script(url, body)
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
      ...(init.signal ? { signal: init.signal } : {}),
    })
    return new Response(payload == null ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function driver(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  return createEmail({ driver: brevo({ apiKey: "k", fetch: fetchImpl, ...options }), defaults })
}

describe("brevo", () => {
  it("requires an api key", () => {
    expect(() => brevo({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("maps the message onto Brevo's payload", async () => {
    const s = stub(() => [201, { messageId: "<1@smtp-relay.brevo.com>" }])
    const { data } = await driver(s.fetch, {
      batchId: "275d3289-d5cb-4768-9460-a990054b6c81",
    }).send({
      ...msg,
      html: "<p>hi</p>",
      cc: "cc@x.com",
      bcc: ["one@x.com", "two@x.com"],
      replyTo: ["Support <reply@acme.com>", "ignored@acme.com"],
      headers: { "X-Custom": "1" },
      tags: [{ name: "campaign", value: "welcome" }],
      metadata: { userId: "42" },
      scheduledAt: "2030-01-01T00:00:00Z",
      template: { id: "42", variables: { name: "Ada" } },
    })

    expect(data?.id).toBe("<1@smtp-relay.brevo.com>")
    expect(s.calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/email")
    expect(s.calls[0]!.method).toBe("POST")
    expect(s.calls[0]!.headers["api-key"]).toBe("k")
    expect(s.calls[0]!.body).toEqual({
      sender: { email: "hi@acme.com", name: "Acme" },
      to: [{ email: "ada@example.com", name: "Ada" }],
      cc: [{ email: "cc@x.com" }],
      bcc: [{ email: "one@x.com" }, { email: "two@x.com" }],
      // Brevo takes a single reply-to, so only the first survives.
      replyTo: { email: "reply@acme.com", name: "Support" },
      subject: "hi",
      htmlContent: "<p>hi</p>",
      textContent: "hello",
      headers: {
        "X-Custom": "1",
        "X-Mailin-custom": JSON.stringify({ userId: "42", campaign: "welcome" }),
      },
      tags: ["campaign"],
      templateId: 42,
      params: { name: "Ada" },
      scheduledAt: "2030-01-01T00:00:00.000Z",
      batchId: "275d3289-d5cb-4768-9460-a990054b6c81",
    })
  })

  it("turns `sandbox` into the X-Sib-Sandbox header rather than a field", async () => {
    const s = stub(() => [201, { messageId: "m1" }])
    await driver(s.fetch).send({ ...msg, sandbox: true })
    expect(s.calls[0]!.body.headers).toEqual({ "X-Sib-Sandbox": "drop" })
  })

  it("base64-encodes attachment bytes and never guesses at a string", async () => {
    const s = stub(() => [201, { messageId: "m1" }])
    await driver(s.fetch).send({
      ...msg,
      attachments: [
        { filename: "a.txt", content: new TextEncoder().encode("hello") },
        { filename: "b.txt", content: "aGVsbG8=", encoding: "base64" },
        { filename: "c.txt", content: "hello" },
      ],
    })
    expect(s.calls[0]!.body.attachment).toEqual([
      { name: "a.txt", content: "aGVsbG8=" },
      { name: "b.txt", content: "aGVsbG8=" },
      { name: "c.txt", content: "aGVsbG8=" },
    ])
  })

  it("passes a UUID idempotency key through untouched", async () => {
    const s = stub(() => [201, { messageId: "m1" }])
    await driver(s.fetch).send({ ...msg, idempotencyKey: "b52dbf00-81dd-4a08-b807-085c0a1b2c3d" })
    expect(s.calls[0]!.headers.idempotencyKey).toBe("b52dbf00-81dd-4a08-b807-085c0a1b2c3d")
  })

  it("hashes a non-UUID idempotency key into one, because Brevo rejects anything else", async () => {
    const s = stub(() => [201, { messageId: "m1" }])
    const email = driver(s.fetch)
    await email.send({ ...msg, idempotencyKey: "welcome:1" })
    await email.send({ ...msg, idempotencyKey: "welcome:1" })
    await email.send({ ...msg, idempotencyKey: "welcome:2" })

    const keys = s.calls.map((call) => call.headers.idempotencyKey!)
    expect(keys[0]).toMatch(UUID)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).not.toBe(keys[2])
  })

  it("sends no idempotency header when no message carries a key", async () => {
    const s = stub(() => [201, { messageId: "m1" }])
    await driver(s.fetch).send(msg)
    expect(s.calls[0]!.headers.idempotencyKey).toBeUndefined()
  })

  it("batches as messageVersions and keeps the ids positional", async () => {
    const s = stub(() => [201, { messageIds: ["<a@brevo>", "<b@brevo>"] }])
    const batch = await driver(s.fetch).sendBatch([
      { ...msg, to: "one@x.com", subject: "one" },
      { ...msg, to: "two@x.com", subject: "two", html: "<p>2</p>", cc: "cc@x.com" },
    ])

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.body.messageVersions).toEqual([
      { to: [{ email: "one@x.com" }], subject: "one", textContent: "hello" },
      {
        to: [{ email: "two@x.com" }],
        cc: [{ email: "cc@x.com" }],
        subject: "two",
        htmlContent: "<p>2</p>",
        textContent: "hello",
      },
    ])
    expect(batch.sent.map((r) => r.id)).toEqual(["<a@brevo>", "<b@brevo>"])
  })

  it("reports a short messageIds list against the right messages", async () => {
    const s = stub(() => [201, { messageIds: ["<a@brevo>"] }])
    const batch = await driver(s.fetch).sendBatch([msg, msg])
    expect(batch.sent.map((r) => r.id)).toEqual(["<a@brevo>"])
    expect(batch.failed[0]?.index).toBe(1)
    expect(batch.failed[0]?.error.message).toMatch(/messageId/)
  })

  it("falls back to one request per message when the batch disagrees on the envelope", async () => {
    const s = stub(() => [201, { messageId: "m" }])
    const batch = await driver(s.fetch).sendBatch([
      { ...msg, tags: [{ name: "a", value: "1" }] },
      { ...msg, tags: [{ name: "b", value: "2" }] },
    ])
    expect(s.calls).toHaveLength(2)
    expect(s.calls.every((call) => call.body.messageVersions === undefined)).toBe(true)
    expect(batch.ok).toBe(true)
  })

  it("chunks at 1000 versions per request", async () => {
    const s = stub((_url, body) => [
      201,
      { messageIds: body.messageVersions.map((_: unknown, i: number) => `id_${i}`) },
    ])
    const batch = await driver(s.fetch).sendBatch(
      Array.from({ length: 1001 }, (_, i) => ({ ...msg, to: `r${i}@x.com` })),
    )
    expect(s.calls.map((call) => call.body.messageVersions.length)).toEqual([1000, 1])
    expect(batch.results).toHaveLength(1001)
    expect(batch.ok).toBe(true)
  })

  it("also splits a batch that would exceed 2000 recipients", async () => {
    const many = Array.from({ length: 99 }, (_, i) => `r${i}@x.com`)
    const s = stub((_url, body) => [
      201,
      { messageIds: body.messageVersions.map((_: unknown, i: number) => `id_${i}`) },
    ])
    // 99 recipients each: 20 versions fit under 2000, the 21st does not.
    await driver(s.fetch).sendBatch(Array.from({ length: 25 }, () => ({ ...msg, to: many })))
    expect(s.calls.map((call) => call.body.messageVersions.length)).toEqual([20, 5])
  })

  it("refuses a message with more recipients than one Brevo call accepts", async () => {
    const s = stub(() => [201, { messageId: "m" }])
    const { error } = await driver(s.fetch).send({
      ...msg,
      to: Array.from({ length: 100 }, (_, i) => `r${i}@x.com`),
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/at most 99/)
    expect(s.calls).toHaveLength(0)
  })

  it("refuses a template Brevo cannot address", async () => {
    const s = stub(() => [201, { messageId: "m" }])
    const email = driver(s.fetch)
    const byAlias = await email.send({ ...msg, template: { alias: "welcome" } })
    expect(byAlias.error?.code).toBe("INVALID_OPTIONS")
    expect(byAlias.error?.message).toMatch(/numeric id/)

    const byName = await email.send({ ...msg, template: { id: "welcome" } })
    expect(byName.error?.code).toBe("INVALID_OPTIONS")
    expect(byName.error?.message).toMatch(/must be numeric/)
    expect(s.calls).toHaveLength(0)
  })

  it("classifies status codes into the shared taxonomy", async () => {
    const cases = [
      [401, "AUTH", false],
      [429, "RATE_LIMIT", true],
      [500, "NETWORK", true],
      [400, "PROVIDER", false],
    ] as const
    for (const [status, code, retryable] of cases) {
      const s = stub(() => [status, { code: "invalid_parameter", message: "nope" }])
      const { error } = await driver(s.fetch).send(msg)
      expect([status, error?.code, error?.retryable, error?.message]).toEqual([
        status,
        code,
        retryable,
        `[unemail] [brevo] nope`,
      ])
    }
  })

  it("treats Brevo's own permission codes as auth failures whatever the status says", async () => {
    for (const code of ["unauthorized", "permission_denied"]) {
      const s = stub(() => [400, { code, message: "Key not enabled" }])
      const { error } = await driver(s.fetch).send(msg)
      expect(error?.code).toBe("AUTH")
      expect(error?.retryable).toBe(false)
    }
  })

  it("reports a 2xx with no messageId as a provider failure", async () => {
    const s = stub(() => [201, {}])
    const { error } = await driver(s.fetch).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/messageId/)
  })

  it("forwards the caller's abort signal into the request", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(JSON.stringify({ messageId: "m" }), { status: 201 })
    }) as unknown as typeof fetch

    await createEmail({
      driver: brevo({ apiKey: "k", fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)
    expect(aborted).toBe(true)
  })

  it("forwards the abort signal on the batch path too", async () => {
    const s = stub(() => [201, { messageIds: ["a", "b"] }])
    const controller = new AbortController()
    await createEmail({
      driver: brevo({ apiKey: "k", fetch: s.fetch }),
      defaults,
      signal: controller.signal,
    }).sendBatch([msg, msg])
    expect(s.calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it("cancels a scheduled send", async () => {
    const s = stub(() => [204, null])
    const { error } = await driver(s.fetch).cancel("<1@brevo>")
    expect(error).toBeNull()
    expect(s.calls[0]!.method).toBe("DELETE")
    expect(s.calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/email/%3C1%40brevo%3E")
  })

  it("retrieves a single scheduled message", async () => {
    const s = stub(() => [
      200,
      { createdAt: "2030-01-01T00:00:00Z", scheduledAt: "2030-01-02T00:00:00Z", status: "queued" },
    ])
    const { data } = await driver(s.fetch).retrieve("<1@brevo>")
    expect(s.calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/emailStatus/%3C1%40brevo%3E")
    expect(data?.state).toBe("scheduled")
    expect(data?.at?.toISOString()).toBe("2030-01-02T00:00:00.000Z")
  })

  it("retrieves a batch by batchId, reading the first entry of `batches`", async () => {
    const s = stub(() => [
      200,
      { count: 1, batches: [{ createdAt: "2030-01-01T00:00:00Z", status: "processed" }] },
    ])
    const { data } = await driver(s.fetch).retrieve("275d3289-d5cb-4768-9460-a990054b6c81")
    expect(data?.state).toBe("sent")
  })

  it("maps the scheduling states Brevo reports", async () => {
    const cases = [
      ["queued", "scheduled"],
      ["inProgress", "queued"],
      ["processed", "sent"],
      ["error", "failed"],
      ["something-new", "unknown"],
    ] as const
    for (const [status, state] of cases) {
      const s = stub(() => [200, { status }])
      expect((await driver(s.fetch).retrieve("id")).data?.state).toBe(state)
    }
  })

  it("declares every feature it actually implements", () => {
    const instance = brevo({ apiKey: "k", fetch: (() => {}) as unknown as typeof fetch })
    expect(instance.features).toMatchObject({
      attachments: true,
      batch: true,
      scheduling: true,
      idempotency: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      sandbox: true,
      cancelable: true,
      retrievable: true,
    })
    expect(typeof instance.cancel).toBe("function")
    expect(typeof instance.retrieve).toBe("function")
    expect(typeof instance.sendBatch).toBe("function")
  })
})
