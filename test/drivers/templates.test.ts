import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import sendgrid from "../../src/drivers/sendgrid.ts"
import mailgun from "../../src/drivers/mailgun.ts"
import postmark from "../../src/drivers/postmark.ts"
import brevo from "../../src/drivers/brevo.ts"
import mailersend from "../../src/drivers/mailersend.ts"
import loops from "../../src/drivers/loops.ts"
import zeptomail from "../../src/drivers/zeptomail.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("msg.template pass-through across drivers", () => {
  const baseMsg = {
    from: "a@b.com",
    to: "c@d.com",
    subject: "hi",
    text: "hello",
    template: { id: "tpl-1", variables: { name: "Ada" } },
  }

  it("sendgrid maps to template_id + dynamic_template_data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }))
    const email = createEmail({
      driver: sendgrid({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send(baseMsg)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.template_id).toBe("tpl-1")
    expect(body.personalizations[0].dynamic_template_data).toEqual({ name: "Ada" })
  })

  it("mailgun maps to template + X-Mailgun-Variables", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "mg" }))
    const email = createEmail({
      driver: mailgun({
        apiKey: "k",
        domain: "d.com",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    await email.send(baseMsg)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get("template")).toBe("tpl-1")
    expect(form.get("h:X-Mailgun-Variables")).toBe(JSON.stringify({ name: "Ada" }))
  })

  it("postmark routes to /email/withTemplate and sets TemplateAlias + TemplateModel", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ MessageID: "pm", SubmittedAt: "2026-05-01T00:00:00Z" }))
    const email = createEmail({
      driver: postmark({ token: "t", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send({ ...baseMsg, template: { alias: "welcome", variables: { name: "Ada" } } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.postmarkapp.com/email/withTemplate")
    const body = JSON.parse(init.body as string)
    expect(body.TemplateAlias).toBe("welcome")
    expect(body.TemplateModel).toEqual({ name: "Ada" })
  })

  it("brevo maps to templateId + params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messageId: "<b@v>" }))
    const email = createEmail({
      driver: brevo({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send({ ...baseMsg, template: { id: "42", variables: { name: "Ada" } } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.templateId).toBe(42)
    expect(body.params).toEqual({ name: "Ada" })
  })

  it("mailersend maps to template_id + personalization.data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }))
    const email = createEmail({
      driver: mailersend({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send(baseMsg)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.template_id).toBe("tpl-1")
    expect(body.personalization?.[0]?.data).toEqual({ name: "Ada" })
  })

  it("loops maps template.id to transactionalId + variables to dataVariables", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    const email = createEmail({
      driver: loops({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send(baseMsg)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.transactionalId).toBe("tpl-1")
    expect(body.dataVariables).toEqual({ name: "Ada" })
  })

  it("zeptomail maps to template_key + merge_info", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ message_id: "z" }] }))
    const email = createEmail({
      driver: zeptomail({
        token: "Zoho-enczapikey abc",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    await email.send(baseMsg)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.template_key).toBe("tpl-1")
    expect(body.merge_info).toEqual({ name: "Ada" })
  })
})
