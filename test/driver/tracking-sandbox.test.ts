import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import sendgrid from "../../src/driver/sendgrid.ts"
import mailgun from "../../src/driver/mailgun.ts"
import postmark from "../../src/driver/postmark.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("per-message tracking / sandbox / metadata", () => {
  it("sendgrid maps tracking + sandbox + metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }))
    const email = createEmail({
      driver: sendgrid({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      tracking: { opens: true, clicks: false },
      sandbox: true,
      metadata: { tenant: "acme", userId: "42" },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.mail_settings).toEqual({ sandbox_mode: { enable: true } })
    expect(body.tracking_settings).toEqual({
      open_tracking: { enable: true },
      click_tracking: { enable: false },
    })
    expect(body.personalizations[0].custom_args).toEqual({ tenant: "acme", userId: "42" })
  })

  it("mailgun maps tracking + o:testmode + v:metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "mg_1" }))
    const email = createEmail({
      driver: mailgun({
        apiKey: "k",
        domain: "d.com",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      tracking: { opens: true, clicks: true },
      sandbox: true,
      metadata: { tenant: "acme" },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get("o:testmode")).toBe("yes")
    expect(form.get("o:tracking-opens")).toBe("yes")
    expect(form.get("o:tracking-clicks")).toBe("yes")
    expect(form.get("v:tenant")).toBe("acme")
  })

  it("postmark maps TrackOpens, TrackLinks, Metadata, and first tag → Tag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ MessageID: "pm_1", SubmittedAt: "2026-05-01T00:00:00Z" }))
    const email = createEmail({
      driver: postmark({ token: "t", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      tracking: { opens: true, clicks: true },
      metadata: { tenant: "acme" },
      tags: [{ name: "welcome", value: "v1" }],
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.TrackOpens).toBe(true)
    expect(body.TrackLinks).toBe("HtmlAndText")
    expect(body.Tag).toBe("welcome")
    expect(body.Metadata).toEqual({ tenant: "acme" })
  })
})
