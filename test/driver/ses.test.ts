import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import ses from "../../src/driver/ses.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function makeDriver(fetchMock: unknown) {
  return ses({
    region: "us-east-1",
    accessKeyId: "AKIA_test",
    secretAccessKey: "secret_test",
    fetch: fetchMock as typeof fetch,
    now: () => new Date(Date.UTC(2026, 3, 17, 12, 0, 0)),
  })
}

describe("ses driver", () => {
  it("POSTs /v2/email/outbound-emails with a SigV4 Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ MessageId: "ses_123" }))
    const email = createEmail({ driver: makeDriver(fetchMock) })
    const { data, error } = await email.send({
      from: "Acme <hi@acme.com>",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("ses_123")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(headers["x-amz-date"]).toBe("20260417T120000Z")
    expect(headers.host).toBe("email.us-east-1.amazonaws.com")
  })

  it("builds a raw-MIME payload (base64) for Content.Raw.Data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ MessageId: "ses_123" }))
    const email = createEmail({ driver: makeDriver(fetchMock) })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "attach",
      text: "x",
      attachments: [{ filename: "hello.txt", content: "hello" }],
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.Content.Raw.Data).toBeTypeOf("string")
    const decoded = Buffer.from(body.Content.Raw.Data as string, "base64").toString("utf8")
    expect(decoded).toContain("multipart/mixed")
    expect(decoded).toContain('filename="hello.txt"')
  })

  it("maps SES AUTH errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          __type: "InvalidClientTokenId",
          message: "The security token included in the request is invalid",
        },
        403,
      ),
    )
    const email = createEmail({ driver: makeDriver(fetchMock) })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
  })

  it("maps SES throttling to RATE_LIMIT (retryable)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ __type: "ThrottlingException", message: "Rate exceeded" }, 400),
      )
    const email = createEmail({ driver: makeDriver(fetchMock) })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
  })

  it("passes EmailTags when msg.tags are set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ MessageId: "ses_123" }))
    const email = createEmail({ driver: makeDriver(fetchMock) })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      tags: [{ name: "campaign", value: "welcome" }],
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.EmailTags).toEqual([{ Name: "campaign", Value: "welcome" }])
  })

  it("throws on missing region", () => {
    expect(() => ses({} as never)).toThrow(/region/)
  })

  it("throws on missing credentials", () => {
    expect(() => ses({ region: "us-east-1" })).toThrow(/credentials/)
  })
})
