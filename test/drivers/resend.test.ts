import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import resend from "../../src/drivers/resend.ts"

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (extraHeaders) Object.assign(headers, extraHeaders)
  return new Response(JSON.stringify(body), { status, headers })
}

describe("resend driver", () => {
  it("POSTs /emails and normalizes the success response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "re_abc" }))
    const email = createEmail({
      driver: resend({ apiKey: "re_test_key", fetch: fetchMock as unknown as typeof fetch }),
    })

    const { data, error } = await email.send({
      from: "Acme <hi@acme.com>",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })

    expect(error).toBeNull()
    expect(data?.id).toBe("re_abc")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.resend.com/emails")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body.from).toBe("Acme <hi@acme.com>")
    expect(body.to).toEqual(["user@example.com"])
    expect(body.subject).toBe("hi")
    expect(body.text).toBe("hello")
  })

  it("passes idempotencyKey as the Idempotency-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "re_1" }))
    const email = createEmail({
      driver: resend({ apiKey: "re_test_key", fetch: fetchMock as unknown as typeof fetch }),
    })

    await email.send({
      from: "hi@acme.com",
      to: "user@example.com",
      subject: "x",
      text: "x",
      idempotencyKey: "welcome/42",
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["Idempotency-Key"]).toBe("welcome/42")
  })

  it("maps 401 to AUTH error (not retryable)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "bad key" }, 401))
    const email = createEmail({
      driver: resend({ apiKey: "re_test_key", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(data).toBeNull()
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
  })

  it("maps 429 to RATE_LIMIT (retryable)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "slow down" }, 429))
    const email = createEmail({
      driver: resend({ apiKey: "re_test_key", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
  })

  it("supports batch send via /emails/batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "a" }, { id: "b" }] }))
    const email = createEmail({
      driver: resend({ apiKey: "re_test_key", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data } = await email.sendBatch([
      { from: "a@b.com", to: "x@y.com", subject: "1", text: "x" },
      { from: "a@b.com", to: "y@y.com", subject: "2", text: "x" },
    ])
    expect(data).toHaveLength(2)
    expect(data?.[0]?.id).toBe("a")
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe("https://api.resend.com/emails/batch")
  })

  it("rejects apiKey that does not start with 're_'", () => {
    expect(() => resend({ apiKey: "not-a-resend-key" })).toThrow(/must start with/)
  })
})
