import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import postmark from "../../src/driver/postmark.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("postmark driver", () => {
  it("POSTs /email with Postmark's PascalCase shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        MessageID: "pm_123",
        SubmittedAt: "2026-04-17T03:10:00Z",
        To: "user@example.com",
      }),
    )
    const email = createEmail({
      driver: postmark({ token: "pmk_test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data, error } = await email.send({
      from: "Acme <hi@acme.com>",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("pm_123")
    expect(data?.at).toBeInstanceOf(Date)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.postmarkapp.com/email")
    const headers = init.headers as Record<string, string>
    expect(headers["x-postmark-server-token"]).toBe("pmk_test")
    const body = JSON.parse(init.body as string)
    expect(body.From).toBe("Acme <hi@acme.com>")
    expect(body.To).toBe("user@example.com")
    expect(body.Subject).toBe("hi")
    expect(body.TextBody).toBe("hello")
  })

  it("routes msg.stream to Postmark's MessageStream field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ MessageID: "pm_1" }))
    const email = createEmail({
      driver: postmark({ token: "pmk_test", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send({
      stream: "broadcast",
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.MessageStream).toBe("broadcast")
  })

  it("applies driver-level messageStream default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ MessageID: "pm_1" }))
    const email = createEmail({
      driver: postmark({
        token: "pmk_test",
        messageStream: "outbound",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.MessageStream).toBe("outbound")
  })

  it("maps 401 to AUTH (not retryable)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ErrorCode: 10, Message: "Invalid API token" }, 401))
    const email = createEmail({
      driver: postmark({ token: "pmk_test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
  })

  it("sendBatch posts to /email/batch and fails the whole batch on partial error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([{ MessageID: "a" }, { ErrorCode: 300, Message: "Invalid recipient" }]),
      )
    const email = createEmail({
      driver: postmark({ token: "pmk_test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data, error } = await email.sendBatch([
      { from: "a@b.com", to: "x@y.com", subject: "1", text: "x" },
      { from: "a@b.com", to: "y@y.com", subject: "2", text: "x" },
    ])
    expect(data).toBeNull()
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/Invalid recipient/)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe("https://api.postmarkapp.com/email/batch")
  })

  it("sendBatch returns an array of results on full success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { MessageID: "a", SubmittedAt: "2026-04-17T03:10:00Z" },
        { MessageID: "b", SubmittedAt: "2026-04-17T03:10:00Z" },
      ]),
    )
    const email = createEmail({
      driver: postmark({ token: "pmk_test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data, error } = await email.sendBatch([
      { from: "a@b.com", to: "x@y.com", subject: "1", text: "x" },
      { from: "a@b.com", to: "y@y.com", subject: "2", text: "x" },
    ])
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    expect(data?.[0]?.id).toBe("a")
  })
})
