import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import loops from "../../src/drivers/loops.ts"

const TEMPLATE = "clfq6dinn000yl70fgwwyp82l"
/** Loops has no free-form body: a message names the transactional email. */
const msg = {
  to: "Ada <ada@example.com>",
  subject: "ignored by Loops",
  template: { id: TEMPLATE },
} as const
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

const sent = () => stub(() => [200, { success: true }])

function driver(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  return createEmail({ driver: loops({ apiKey: "k", fetch: fetchImpl, ...options }), defaults })
}

describe("loops", () => {
  it("requires an api key", () => {
    expect(() => loops({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("maps the message onto the transactional payload", async () => {
    const s = sent()
    const { data } = await driver(s.fetch, { addToAudience: true }).send({
      ...msg,
      template: { id: TEMPLATE, variables: { name: "Ada", count: 3 } },
      metadata: { userId: "42" },
      tags: [{ name: "cohort", value: "beta" }],
      idempotencyKey: "welcome:1",
    })

    expect(s.calls[0]!.url).toBe("https://app.loops.so/api/v1/transactional")
    expect(s.calls[0]!.method).toBe("POST")
    expect(s.calls[0]!.headers.authorization).toBe("Bearer k")
    expect(s.calls[0]!.headers["idempotency-key"]).toBe("welcome:1")
    expect(s.calls[0]!.body).toEqual({
      transactionalId: TEMPLATE,
      email: "ada@example.com",
      addToAudience: true,
      // Loops has one extension point, so metadata and tags land in it too.
      dataVariables: { userId: "42", cohort: "beta", name: "Ada", count: 3 },
    })
    expect(data?.id).toBe("welcome:1")
    expect(data?.driver).toBe("loops")
  })

  it("keeps the template's own variables ahead of metadata of the same name", async () => {
    const s = sent()
    await driver(s.fetch).send({
      ...msg,
      metadata: { name: "from-metadata" },
      template: { id: TEMPLATE, variables: { name: "from-template" } },
    })
    expect(s.calls[0]!.body.dataVariables).toEqual({ name: "from-template" })
  })

  it("sends no dataVariables key when there is nothing to put in it", async () => {
    const s = sent()
    await driver(s.fetch).send(msg)
    expect(s.calls[0]!.body).toEqual({ transactionalId: TEMPLATE, email: "ada@example.com" })
  })

  it("takes the transactionalId from the driver when the message names no template", async () => {
    const s = sent()
    await driver(s.fetch, { transactionalId: "default_tpl" }).send({
      to: "ada@example.com",
      subject: "s",
      template: { variables: { a: "1" } },
    })
    expect(s.calls[0]!.body.transactionalId).toBe("default_tpl")
  })

  it("accepts a template alias as the transactionalId", async () => {
    const s = sent()
    await driver(s.fetch).send({ ...msg, template: { alias: "by-alias" } })
    expect(s.calls[0]!.body.transactionalId).toBe("by-alias")
  })

  it("base64-encodes attachments and names a content type", async () => {
    const s = sent()
    await driver(s.fetch).send({
      ...msg,
      attachments: [
        {
          filename: "a.txt",
          content: new TextEncoder().encode("hello"),
          contentType: "text/plain",
        },
        { filename: "b.bin", content: "aGVsbG8=", encoding: "base64" },
      ],
    })
    expect(s.calls[0]!.body.attachments).toEqual([
      { filename: "a.txt", contentType: "text/plain", data: "aGVsbG8=" },
      { filename: "b.bin", contentType: "application/octet-stream", data: "aGVsbG8=" },
    ])
  })

  it("refuses a free-form body instead of sending an empty template", async () => {
    const s = sent()
    const { error } = await driver(s.fetch, { transactionalId: "t" }).send({
      to: "ada@example.com",
      subject: "hi",
      html: "<p>hello</p>",
    })
    expect(error?.code).toBe("UNSUPPORTED")
    expect(error?.message).toMatch(/template\.variables/)
    expect(s.calls).toHaveLength(0)
  })

  it("refuses a message that names no transactional email at all", async () => {
    const s = sent()
    const { error } = await driver(s.fetch).send({
      to: "ada@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/transactionalId/)
    expect(s.calls).toHaveLength(0)
  })

  it("refuses the fields Loops would drop on the floor", async () => {
    const s = sent()
    const email = driver(s.fetch)
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ to: ["one@x.com", "two@x.com"] }, "INVALID_OPTIONS", /exactly one recipient/],
      [{ cc: "cc@x.com" }, "UNSUPPORTED", /cc/],
      [{ bcc: "bcc@x.com" }, "UNSUPPORTED", /bcc/],
      [{ replyTo: "reply@x.com" }, "UNSUPPORTED", /replyTo/],
      [{ idempotencyKey: "k".repeat(101) }, "INVALID_OPTIONS", /100 characters/],
    ]
    for (const [overrides, code, pattern] of cases) {
      const { error } = await email.send({ ...msg, ...overrides })
      expect([overrides, error?.code]).toEqual([overrides, code])
      expect(error?.message).toMatch(pattern)
    }
    expect(s.calls).toHaveLength(0)
  })

  it("classifies status codes into the shared taxonomy", async () => {
    const cases = [
      [401, "AUTH", false],
      [429, "RATE_LIMIT", true],
      [500, "NETWORK", true],
      [400, "PROVIDER", false],
      [409, "PROVIDER", false],
    ] as const
    for (const [status, code, retryable] of cases) {
      const s = stub(() => [status, { success: false, message: "nope" }])
      const { error } = await driver(s.fetch).send(msg)
      expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
    }
  })

  it("unpacks the nested reason out of a Loops validation failure", async () => {
    const s = stub(() => [
      400,
      {
        success: false,
        message: "There was a problem with your request.",
        error: { path: "dataVariables", message: "Missing required fields", reason: "name" },
      },
    ])
    const { error } = await driver(s.fetch).send(msg)
    expect(error?.message).toBe(
      "[unemail] [loops] There was a problem with your request.: Missing required fields (name)",
    )
  })

  it("reports a 200 that says success:false as a failure", async () => {
    const s = stub(() => [200, { success: false, message: "transactional email not published" }])
    const { error } = await driver(s.fetch).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.retryable).toBe(false)
    expect(error?.message).toMatch(/not published/)
  })

  it("keys the result by the send when Loops returns no id of its own", async () => {
    const s = sent()
    const { data } = await driver(s.fetch).send(msg)
    expect(data?.id).toBe(`${TEMPLATE}:ada@example.com`)
  })

  it("forwards the caller's abort signal into the request", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch

    await createEmail({
      driver: loops({ apiKey: "k", fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)
    expect(aborted).toBe(true)
  })

  it("still returns one result per message when the core sends a list", async () => {
    const s = stub((_url, body) =>
      body.email === "two@x.com"
        ? [400, { success: false, message: "bad" }]
        : [200, { success: true }],
    )
    const batch = await driver(s.fetch).sendBatch([
      { ...msg, to: "one@x.com" },
      { ...msg, to: "two@x.com" },
      { ...msg, to: "three@x.com" },
    ])
    expect(batch.results).toHaveLength(3)
    expect(batch.failed.map((f) => f.index)).toEqual([1])
  })

  it("declares only what Loops can actually do", () => {
    const instance = loops({ apiKey: "k", fetch: (() => {}) as unknown as typeof fetch })
    expect(instance.features).toEqual({
      attachments: true,
      html: false,
      text: false,
      templates: true,
      idempotency: true,
    })
    // No bulk endpoint, no cancel, no status lookup.
    expect(instance.sendBatch).toBeUndefined()
    expect(instance.cancel).toBeUndefined()
    expect(instance.retrieve).toBeUndefined()
  })
})
