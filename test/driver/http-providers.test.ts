/** Batch smoke tests for the HTTP-only provider drivers. Each block
 *  verifies:
 *   - correct endpoint + auth header shape
 *   - request payload key names (since every provider has its own casing)
 *   - happy-path success → `data.id`, `data.driver` set
 *   - auth failure → `error.code === "AUTH"` (via the shared _http helper) */
import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import sendgrid from "../../src/driver/sendgrid.ts"
import mailgun from "../../src/driver/mailgun.ts"
import brevo from "../../src/driver/brevo.ts"
import mailersend from "../../src/driver/mailersend.ts"
import loops from "../../src/driver/loops.ts"
import mailchannels from "../../src/driver/mailchannels.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function textResponse(body = "", status = 202): Response {
  return new Response(body, { status })
}

describe("sendgrid driver", () => {
  it("POSTs to /v3/mail/send with personalizations + Bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("", 202))
    const email = createEmail({
      driver: sendgrid({ apiKey: "SG.test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
    })
    expect(error).toBeNull()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer SG.test")
    const body = JSON.parse(init.body as string)
    expect(body.from).toEqual({ email: "a@b.com" })
    expect(body.personalizations[0].to).toEqual([{ email: "c@d.com" }])
    expect(body.content).toEqual([{ type: "text/plain", value: "x" }])
  })

  it("maps 401 to AUTH", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "bad" }] }, 401))
    const email = createEmail({
      driver: sendgrid({ apiKey: "SG.test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(error?.code).toBe("AUTH")
  })
})

describe("mailgun driver", () => {
  it("POSTs form-data to /v3/{domain}/messages with basic auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "<mg-abc@example.com>", message: "Queued" }))
    const email = createEmail({
      driver: mailgun({
        apiKey: "key-xyz",
        domain: "mail.example.com",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("mg-abc@example.com")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.mailgun.net/v3/mail.example.com/messages")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toMatch(/^Basic /)
    // body is FormData — just check it exists
    expect(init.body).toBeInstanceOf(FormData)
  })
})

describe("brevo driver", () => {
  it("POSTs to /v3/smtp/email with api-key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messageId: "brevo_123" }))
    const email = createEmail({
      driver: brevo({ apiKey: "xkeysib-test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { data, error } = await email.send({
      from: "Acme <a@b.com>",
      to: "c@d.com",
      subject: "hi",
      text: "x",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("brevo_123")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.brevo.com/v3/smtp/email")
    const headers = init.headers as Record<string, string>
    expect(headers["api-key"]).toBe("xkeysib-test")
    const body = JSON.parse(init.body as string)
    expect(body.sender).toEqual({ email: "a@b.com", name: "Acme" })
    expect(body.to).toEqual([{ email: "c@d.com" }])
  })
})

describe("mailersend driver", () => {
  it("POSTs to /v1/email with Bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("", 202))
    const email = createEmail({
      driver: mailersend({
        apiKey: "ms_test",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { error } = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(error).toBeNull()
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe("https://api.mailersend.com/v1/email")
  })

  it("sendBatch hits /v1/bulk-email", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ bulk_email_id: "bulk_1" }))
    const email = createEmail({
      driver: mailersend({
        apiKey: "ms_test",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { data } = await email.sendBatch([
      { from: "a@b.com", to: "x@y.com", subject: "1", text: "x" },
      { from: "a@b.com", to: "y@y.com", subject: "2", text: "x" },
    ])
    expect(data).toHaveLength(2)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe("https://api.mailersend.com/v1/bulk-email")
  })
})

describe("loops driver", () => {
  it("POSTs transactionalId + email + dataVariables", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    const email = createEmail({
      driver: loops({
        apiKey: "loops_test",
        transactionalId: "welcome",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { data, error } = await email.send({
      from: "noreply@a.com", // loops ignores `from` — the template owns that
      to: "user@b.com",
      subject: "not used",
      tags: [{ name: "firstName", value: "Ada" }],
    })
    expect(error).toBeNull()
    expect(data?.driver).toBe("loops")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://app.loops.so/api/v1/transactional")
    const body = JSON.parse(init.body as string)
    expect(body.transactionalId).toBe("welcome")
    expect(body.email).toBe("user@b.com")
    expect(body.dataVariables).toEqual({ firstName: "Ada" })
  })

  it("errors when no transactionalId is configured", async () => {
    const fetchMock = vi.fn()
    const email = createEmail({
      driver: loops({ apiKey: "loops_test", fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
    })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("mailchannels driver", () => {
  it("POSTs to /tx/v1/send with personalizations (no api key required in Workers)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("", 202))
    const email = createEmail({
      driver: mailchannels({ fetch: fetchMock as unknown as typeof fetch }),
    })
    const { error } = await email.send({
      from: "hi@acme.com",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe("https://api.mailchannels.net/tx/v1/send")
  })

  it("includes DKIM settings when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("", 202))
    const email = createEmail({
      driver: mailchannels({
        fetch: fetchMock as unknown as typeof fetch,
        dkim: { domain: "acme.com", selector: "mc", privateKey: "PK" },
      }),
    })
    await email.send({ from: "a@acme.com", to: "c@d.com", subject: "x", text: "x" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.personalizations[0].dkim_domain).toBe("acme.com")
    expect(body.personalizations[0].dkim_selector).toBe("mc")
    expect(body.personalizations[0].dkim_private_key).toBe("PK")
  })
})
