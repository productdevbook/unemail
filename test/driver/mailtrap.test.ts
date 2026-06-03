import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import mailtrap from "../../src/driver/mailtrap.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("mailtrap driver", () => {
  it("POSTs /api/send with Api-Token and address shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, message_ids: ["mt_1"] }))
    const email = createEmail({
      driver: mailtrap({ apiKey: "token", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data, error } = await email.send({
      from: "Acme <hi@acme.com>",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("mt_1")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://send.api.mailtrap.io/api/send")
    const headers = init.headers as Record<string, string>
    expect(headers["api-token"]).toBe("token")
    expect(headers["user-agent"]).toBe("unemail/mailtrap")
    const body = JSON.parse(init.body as string)
    expect(body.from).toEqual({ email: "hi@acme.com", name: "Acme" })
    expect(body.to).toEqual([{ email: "user@example.com" }])
    expect(body.category).toBe("transactional")
  })

  it("maps category tag and extra tags to custom_variables", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, message_ids: ["x"] }))
    const email = createEmail({
      driver: mailtrap({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      tags: [
        { name: "category", value: "password-reset" },
        { name: "tenant", value: "acme" },
      ],
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.category).toBe("password-reset")
    expect(body.custom_variables).toEqual({ tag_tenant: "acme" })
  })

  it("uses defaultCategory when no category tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, message_ids: ["x"] }))
    const email = createEmail({
      driver: mailtrap({
        apiKey: "k",
        defaultCategory: "notifications",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.category).toBe("notifications")
  })

  it("rejects missing apiKey at factory time", () => {
    expect(() => mailtrap({} as { apiKey: string })).toThrow(/apiKey/)
  })

  it("maps 401 to AUTH", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: false, errors: ["Unauthorized"] }, 401))
    const email = createEmail({
      driver: mailtrap({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
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

  it("maps 429 to RATE_LIMIT", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: false, errors: ["Too many requests"] }, 429))
    const email = createEmail({
      driver: mailtrap({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
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

  it("returns PROVIDER when HTTP 200 but success is false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: false, errors: ["Invalid from"] }))
    const email = createEmail({
      driver: mailtrap({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("Invalid from")
  })

  it("returns UNSUPPORTED for scheduledAt", async () => {
    const fetchMock = vi.fn()
    const email = createEmail({
      driver: mailtrap({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      scheduledAt: new Date(),
    })
    expect(error?.code).toBe("UNSUPPORTED")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sendBatch POSTs /api/batch with requests array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        responses: [
          { success: true, message_ids: ["a"] },
          { success: true, message_ids: ["b"] },
        ],
      }),
    )
    const email = createEmail({
      driver: mailtrap({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data, error } = await email.sendBatch([
      { from: "a@b.com", to: "x@y.com", subject: "1", text: "x" },
      { from: "a@b.com", to: "y@y.com", subject: "2", text: "x" },
    ])
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    expect(data?.[0]?.id).toBe("a")
    expect(data?.[1]?.id).toBe("b")
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe("https://send.api.mailtrap.io/api/batch")
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.requests).toHaveLength(2)
  })

  it("sendBatch fails when a batch item has success false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        responses: [
          { success: true, message_ids: ["a"] },
          { success: false, errors: ["bad"] },
        ],
      }),
    )
    const email = createEmail({
      driver: mailtrap({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.sendBatch([
      { from: "a@b.com", to: "x@y.com", subject: "1", text: "x" },
      { from: "a@b.com", to: "y@y.com", subject: "2", text: "x" },
    ])
    expect(error?.code).toBe("PROVIDER")
  })
})
