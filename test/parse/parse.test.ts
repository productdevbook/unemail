import { describe, expect, it } from "vitest"
import { normalizeParsed, parseEmail } from "../../src/parse/index.ts"

describe("normalizeParsed", () => {
  it("normalizes a postal-mime shape into ParsedEmail", () => {
    const out = normalizeParsed({
      messageId: "<msg@x>",
      date: "2026-04-17T12:00:00Z",
      subject: "Hi",
      from: { address: "a@b.com", name: "Ada" },
      to: [{ address: "c@d.com" }],
      cc: [{ address: "cc@d.com" }],
      replyTo: { address: "r@d.com" },
      text: "body",
      html: "<p>body</p>",
      references: "<ref1@x> <ref2@x>",
      headers: [
        { key: "X-Thing", value: "yes" },
        { key: "Message-ID", value: "<msg@x>" },
      ],
      attachments: [
        { filename: "a.txt", content: new TextEncoder().encode("hi"), mimeType: "text/plain" },
      ],
    })
    expect(out.subject).toBe("Hi")
    expect(out.from).toEqual({ email: "a@b.com", name: "Ada" })
    expect(out.to).toEqual([{ email: "c@d.com", name: undefined }])
    expect(out.cc).toEqual([{ email: "cc@d.com", name: undefined }])
    expect(out.replyTo).toEqual({ email: "r@d.com", name: undefined })
    expect(out.references).toEqual(["<ref1@x>", "<ref2@x>"])
    expect(out.headers["x-thing"]).toBe("yes")
    expect(out.attachments).toHaveLength(1)
    expect(new TextDecoder().decode(out.attachments[0]!.content)).toBe("hi")
  })
})

describe("parseEmail", () => {
  it("uses a user-provided parse override without requiring postal-mime", async () => {
    const out = await parseEmail("Subject: Hello\r\n\r\nbody", {
      parse: async () => ({
        subject: "Hello",
        from: { address: "a@b.com" },
        to: [{ address: "c@d.com" }],
        text: "body",
      }),
    })
    expect(out.subject).toBe("Hello")
    expect(out.from).toEqual({ email: "a@b.com", name: undefined })
    expect(out.text).toBe("body")
  })
})
