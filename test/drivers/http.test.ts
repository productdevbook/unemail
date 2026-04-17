import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import http from "../../src/drivers/http.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("http driver", () => {
  it("POSTs the default payload shape and extracts id from common fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }))
    const email = createEmail({
      driver: http({
        endpoint: "https://api.example.com/send",
        apiKey: "secret",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { data, error } = await email.send({
      from: "hi@acme.com",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("abc")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.example.com/send")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer secret")
    const body = JSON.parse(init.body as string)
    expect(body.to).toEqual(["user@example.com"])
    expect(body.subject).toBe("hi")
  })

  it("respects a custom transform", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messageId: "x" }))
    const email = createEmail({
      driver: http({
        endpoint: "https://api.example.com/send",
        fetch: fetchMock as unknown as typeof fetch,
        transform: (m) => ({ recipient: m.to as string, text: m.text }),
      }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "hi" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ recipient: "c@d.com", text: "hi" })
  })

  it("maps 500 to NETWORK (retryable)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "oops" }, 503))
    const email = createEmail({
      driver: http({
        endpoint: "https://api.example.com/send",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("NETWORK")
    expect(error?.retryable).toBe(true)
  })
})
