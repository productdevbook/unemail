import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import scaleway from "../../src/drivers/scaleway.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const credentials = { secretKey: "scw-secret", projectId: "proj-1" }
const SEND_URL = "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails"

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

const accepted = (ids: string[] = ["em_1"]) => ({
  emails: ids.map((id) => ({ id, message_id: `<${id}@tem>`, status: "new" })),
})

describe("scaleway", () => {
  it("requires a secret key and a project", () => {
    expect(() => scaleway({ secretKey: "", projectId: "p" })).toThrow(/missing required option/)
    expect(() => scaleway({ secretKey: "s", projectId: "" })).toThrow(/projectId/)
  })

  it("maps the message onto Scaleway's payload", async () => {
    const s = stub(() => [200, accepted()])
    const { data } = await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send({
      ...msg,
      cc: "cc@x.com",
      bcc: "bcc@x.com",
      replyTo: "reply@acme.com",
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
    })

    expect(data?.id).toBe("em_1")
    const call = s.calls[0]!
    expect(call.url).toBe(SEND_URL)
    expect(call.method).toBe("POST")
    expect(call.headers["x-auth-token"]).toBe("scw-secret")
    expect(call.body).toMatchObject({
      from: { email: "hi@acme.com", name: "Acme" },
      to: [{ email: "ada@example.com", name: "Ada" }],
      cc: [{ email: "cc@x.com" }],
      bcc: [{ email: "bcc@x.com" }],
      subject: "hi",
      text: "hello",
      html: "<p>hi</p>",
      project_id: "proj-1",
    })
    // Scaleway has no reply_to and no metadata field; both are headers.
    expect(call.body.additional_headers).toEqual([
      { key: "X-Campaign", value: "welcome" },
      { key: "Reply-To", value: "reply@acme.com" },
      { key: "X-Metadata-userId", value: "42" },
    ])
  })

  it("does not add a second Reply-To when the caller set one itself", async () => {
    const s = stub(() => [200, accepted()])
    await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, replyTo: "reply@acme.com", headers: { "reply-to": "other@acme.com" } })

    expect(s.calls[0]!.body.additional_headers).toEqual([
      { key: "reply-to", value: "other@acme.com" },
    ])
  })

  it("puts the region in the path", async () => {
    const s = stub(() => [200, accepted()])
    await createEmail({
      driver: scaleway({ ...credentials, region: "nl-ams", fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(s.calls[0]!.url).toContain("/regions/nl-ams/emails")
  })

  it("base64-encodes attachments and names their MIME type", async () => {
    const s = stub(() => [200, accepted()])
    await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send({
      ...msg,
      attachments: [
        {
          filename: "a.txt",
          content: new TextEncoder().encode("hello"),
          contentType: "text/plain",
        },
        { filename: "b.bin", content: "test" },
      ],
    })

    expect(s.calls[0]!.body.attachments).toEqual([
      { name: "a.txt", type: "text/plain", content: "aGVsbG8=" },
      // Scaleway requires a type per attachment, so an untyped one gets the
      // generic default rather than being rejected.
      { name: "b.bin", type: "application/octet-stream", content: "dGVzdA==" },
    ])
  })

  it("refuses a request over the 2 MB API cap before sending it", async () => {
    const s = stub(() => [200, accepted()])
    const { error } = await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send({
      ...msg,
      attachments: [{ filename: "big.bin", content: new Uint8Array(1_600_000) }],
    })

    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toContain("2097152")
    expect(s.calls).toHaveLength(0)
  })

  it("sends a message that fits under the cap", async () => {
    const s = stub(() => [200, accepted()])
    const { error } = await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, attachments: [{ filename: "ok.bin", content: new Uint8Array(1_000_000) }] })

    expect(error).toBeNull()
    expect(s.calls).toHaveLength(1)
  })

  it("keeps every recipient's email object, and answers with the first id", async () => {
    const s = stub(() => [200, accepted(["em_1", "em_2"])])
    const { data } = await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send({ ...msg, to: ["a@x.com", "b@x.com"] })

    expect(data?.id).toBe("em_1")
    expect((data!.provider as { emails: { id: string }[] }).emails.map((e) => e.id)).toEqual([
      "em_1",
      "em_2",
    ])
  })

  it("reports a response with no email id as a provider failure", async () => {
    const s = stub(() => [200, { emails: [] }])
    const { error } = await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("did not contain an email id")
  })

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
      const { error } = await createEmail({
        driver: scaleway({ ...credentials, fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
    }
  })

  it("treats an exhausted quota as a rate limit that retrying will not clear", async () => {
    const s = stub(() => [
      403,
      { type: "quotas_exceeded", message: "quota email_per_month exceeded" },
    ])
    const { error } = await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send(msg)

    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(false)
    expect(error?.message).toContain("quota email_per_month exceeded")
  })

  it("names the offending argument when Scaleway rejects the request", async () => {
    const s = stub(() => [
      400,
      {
        type: "invalid_arguments",
        message: "invalid argument(s)",
        details: [{ argument_name: "from.email", reason: "constraint" }],
      },
    ])
    const { error } = await createEmail({
      driver: scaleway({ ...credentials, fetch: s.fetch }),
      defaults,
    }).send(msg)

    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("from.email constraint")
  })

  it("cancels and retrieves", async () => {
    const s = stub((url) =>
      url.endsWith("/cancel")
        ? [200, { id: "em_1", status: "canceled" }]
        : [200, { id: "em_1", status: "sent", created_at: "2030-01-01T00:00:00Z" }],
    )
    const email = createEmail({ driver: scaleway({ ...credentials, fetch: s.fetch }), defaults })

    expect((await email.cancel("em_1")).error).toBeNull()
    expect(s.calls[0]!.url).toBe(`${SEND_URL}/em_1/cancel`)

    const status = await email.retrieve("em_1")
    expect(status.data?.state).toBe("sent")
    expect(s.calls[1]!.method).toBe("GET")
  })

  it("maps every documented send status onto the shared taxonomy", async () => {
    const cases = [
      ["new", "queued"],
      ["sending", "queued"],
      ["sent", "sent"],
      ["failed", "failed"],
      ["canceled", "cancelled"],
      ["unknown", "unknown"],
    ] as const
    for (const [status, state] of cases) {
      const s = stub(() => [200, { id: "em_1", status }])
      const result = await createEmail({
        driver: scaleway({ ...credentials, fetch: s.fetch }),
        defaults,
      }).retrieve("em_1")
      expect([status, result.data?.state]).toEqual([status, state])
    }
  })

  it("refuses what its features do not claim", async () => {
    const driver = scaleway(credentials)
    const email = createEmail({ driver, defaults })

    for (const extra of [
      { template: { alias: "welcome" } },
      { scheduledAt: "2030-01-01T00:00:00Z" },
      { sandbox: true },
      { attachments: [{ filename: "a.pdf", url: "https://x.test/a.pdf" }] },
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
      driver: scaleway({ ...credentials, fetch: hanging }),
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
      driver: scaleway({ ...credentials, fetch: spy, timeoutMs: 1 }),
      defaults,
    }).send(msg)

    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })
})
