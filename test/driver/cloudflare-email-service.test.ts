import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import cloudflareEmailService from "../../src/driver/cloudflare-email-service.ts"
import type { CloudflareEmailServiceMessage } from "../../src/driver/cloudflare-email-service.ts"

function sent(send: ReturnType<typeof vi.fn>): CloudflareEmailServiceMessage {
  return send.mock.calls[0]?.[0] as CloudflareEmailServiceMessage
}

/** Mirrors the binding's failure mode: a plain `Error` carrying an `E_*` code. */
function bindingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe("cloudflare-email-service driver", () => {
  it("sends structured fields, not MIME", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "msg-1" })
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    const { data, error } = await email.send({
      from: "Acme <sender@acme.com>",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
      html: "<p>hello</p>",
    })

    expect(error).toBeNull()
    expect(data?.id).toBe("msg-1")
    expect(data?.driver).toBe("cloudflare-email-service")
    expect(sent(send)).toMatchObject({
      from: { email: "sender@acme.com", name: "Acme" },
      to: [{ email: "user@example.com" }],
      subject: "hi",
      text: "hello",
      html: "<p>hello</p>",
    })
  })

  it("sends multiple recipients in one call", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "msg-2" })
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    await email.send({
      from: "sender@acme.com",
      to: ["Ada <a@example.com>", { email: "b@example.com", name: "Bob" }],
      cc: "cc@example.com",
      bcc: ["bcc@example.com"],
      replyTo: "Support <support@acme.com>",
      subject: "x",
      text: "x",
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(sent(send)).toEqual(
      expect.objectContaining({
        from: { email: "sender@acme.com" },
        to: [
          { email: "a@example.com", name: "Ada" },
          { email: "b@example.com", name: "Bob" },
        ],
        cc: [{ email: "cc@example.com" }],
        bcc: [{ email: "bcc@example.com" }],
        replyTo: { email: "support@acme.com", name: "Support" },
      }),
    )
  })

  it("never sends `name: undefined` to the binding", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "msg-2b" })
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })

    const payload = sent(send)
    expect(Object.keys(payload.from)).toEqual(["email"])
    expect(Object.keys(payload.to[0]!)).toEqual(["email"])
  })

  it("omits cc, bcc and attachments when unused", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "msg-3" })
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })

    const payload = sent(send)
    expect(payload.cc).toBeUndefined()
    expect(payload.bcc).toBeUndefined()
    expect(payload.attachments).toBeUndefined()
  })

  it("maps attachments onto the provider's field names", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "msg-4" })
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      attachments: [
        { filename: "report.csv", content: "a,b", contentType: "text/csv" },
        { filename: "logo.png", content: "iVBOR", contentType: "image/png", cid: "logo" },
        { filename: "blob.bin", content: "AAAA" },
      ],
    })

    expect(sent(send).attachments).toEqual([
      { filename: "report.csv", content: "a,b", type: "text/csv", disposition: "attachment" },
      {
        filename: "logo.png",
        content: "iVBOR",
        type: "image/png",
        disposition: "inline",
        contentId: "logo",
      },
      {
        filename: "blob.bin",
        content: "AAAA",
        type: "application/octet-stream",
        disposition: "attachment",
      },
    ])
  })

  it("forwards custom headers", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "msg-5" })
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      headers: { "X-Campaign-ID": "welcome" },
    })

    expect(sent(send).headers).toMatchObject({ "X-Campaign-ID": "welcome" })
  })

  it("requires a binding", () => {
    expect(() => cloudflareEmailService({} as never)).toThrow(/binding/)
  })

  it("classifies validation failures as non-retryable", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(bindingError("E_SENDER_NOT_VERIFIED", "domain not onboarded"))
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    const { error } = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })

    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
    expect(error?.message).toMatch(/domain not onboarded/)
  })

  it("classifies rate limits as retryable", async () => {
    const send = vi.fn().mockRejectedValue(bindingError("E_RATE_LIMIT_EXCEEDED", "slow down"))
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    const { error } = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })

    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
  })

  it("falls back to PROVIDER for unrecognized errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"))
    const email = createEmail({ driver: cloudflareEmailService({ binding: { send } }) })

    const { error } = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })

    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/boom/)
  })
})
