import { describe, expect, it } from "vitest"
import { buildMime, dotStuff, resolveMessageId, toMimeInput } from "../../src/drivers/_mime.ts"
import { normalizeMessage } from "../../src/core/message.ts"

const build = (input: Parameters<typeof normalizeMessage>[0], messageId = "<id@test>") =>
  buildMime(toMimeInput(normalizeMessage({ from: "Acme <hi@acme.com>", ...input }), messageId))

const base = { to: "Ada <ada@example.com>", subject: "hi" } as const

describe("buildMime", () => {
  it("emits a single text/plain part when there is only text", () => {
    const mime = build({ ...base, text: "hello" })
    expect(mime.headers["Content-Type"]).toBe("text/plain; charset=utf-8")
    expect(mime.body).toContain("From: Acme <hi@acme.com>")
    expect(mime.body).toContain("To: Ada <ada@example.com>")
    expect(mime.body).toContain("Message-ID: <id@test>")
    expect(mime.body).toMatch(/\r\n\r\nhello$/)
  })

  it("emits a single text/html part when there is only html", () => {
    const mime = build({ ...base, html: "<p>hi</p>" })
    expect(mime.headers["Content-Type"]).toBe("text/html; charset=utf-8")
  })

  it("emits multipart/alternative with text before html", () => {
    const mime = build({ ...base, text: "plain", html: "<p>rich</p>" })
    expect(mime.headers["Content-Type"]).toMatch(/^multipart\/alternative; boundary="/)
    expect(mime.body.indexOf("text/plain")).toBeLessThan(mime.body.indexOf("text/html"))
    expect(mime.body).toMatch(/--[^\r\n]+--\r?\n?$/)
  })

  it("wraps the body and the attachments in multipart/mixed", () => {
    const mime = build({
      ...base,
      text: "see attached",
      attachments: [{ filename: "a.txt", content: "hello", contentType: "text/plain" }],
    })
    expect(mime.headers["Content-Type"]).toMatch(/^multipart\/mixed; boundary="/)
    expect(mime.body).toContain('Content-Disposition: attachment; filename="a.txt"')
    expect(mime.body).toContain("Content-Transfer-Encoding: base64")
  })

  it("marks a cid attachment inline by default", () => {
    const mime = build({
      ...base,
      html: "<img src='cid:logo'>",
      attachments: [{ filename: "logo.png", content: new Uint8Array([1, 2, 3]), cid: "logo" }],
    })
    expect(mime.body).toContain("Content-ID: <logo>")
    expect(mime.body).toContain("Content-Disposition: inline")
  })

  it("puts to, cc and bcc on the envelope and only to and cc in headers", () => {
    const mime = build({
      ...base,
      text: "x",
      cc: "cc@x.com",
      bcc: ["b1@x.com", "b2@x.com"],
    })
    expect(mime.envelope.rcpt).toEqual(["ada@example.com", "cc@x.com", "b1@x.com", "b2@x.com"])
    expect(mime.envelope.from).toBe("hi@acme.com")
    expect(mime.headers.Cc).toBe("cc@x.com")
    expect(mime.headers.Bcc).toBeUndefined()
    expect(mime.body).not.toMatch(/^Bcc:/m)
  })

  it("deduplicates the envelope recipients", () => {
    const mime = build({ ...base, text: "x", to: ["a@x.com", "a@x.com"], cc: "a@x.com" })
    expect(mime.envelope.rcpt).toEqual(["a@x.com"])
  })

  it("drops a caller-supplied Bcc header", () => {
    const mime = build({ ...base, text: "x", headers: { Bcc: "sneaky@x.com" } })
    expect(mime.body).not.toContain("sneaky@x.com")
  })

  it("RFC 2047 encodes a non-ASCII subject", () => {
    const mime = build({ ...base, subject: "Merhaba dünya", text: "x" })
    expect(mime.headers.Subject).toMatch(/^=\?utf-8\?B\?/)
    const encoded = mime.headers.Subject.replace(/^=\?utf-8\?B\?|\?=$/g, "")
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("Merhaba dünya")
  })

  it("leaves an ASCII subject alone", () => {
    expect(build({ ...base, text: "x" }).headers.Subject).toBe("hi")
  })

  it("quoted-printable encodes non-ASCII body bytes", () => {
    const mime = build({ ...base, text: "über" })
    expect(mime.body).toContain("=C3=BCber")
  })

  it("keeps every line inside the 76-column soft limit", () => {
    const mime = build({ ...base, text: "ü".repeat(200) })
    const longest = Math.max(...mime.body.split("\r\n").map((line) => line.length))
    expect(longest).toBeLessThanOrEqual(76)
  })

  it("carries caller headers through", () => {
    const mime = build({ ...base, text: "x", headers: { "X-Campaign": "welcome" } })
    expect(mime.body).toContain("X-Campaign: welcome")
  })
})

describe("dotStuff", () => {
  it("doubles a leading dot so the payload cannot end the DATA block", () => {
    expect(dotStuff(".hidden")).toBe("..hidden")
    expect(dotStuff("a\n.b\nc")).toBe("a\r\n..b\r\nc")
  })

  it("normalizes bare newlines to CRLF", () => {
    expect(dotStuff("a\nb")).toBe("a\r\nb")
  })

  it("leaves a dot that is not at the start of a line alone", () => {
    expect(dotStuff("a.b")).toBe("a.b")
  })
})

describe("resolveMessageId", () => {
  it("uses the caller's Message-ID whatever its casing", () => {
    const msg = normalizeMessage({
      from: "a@b.com",
      ...base,
      text: "x",
      headers: { "message-id": "<mine@x>" },
    })
    expect(resolveMessageId(msg, "fallback.com")).toBe("<mine@x>")
  })

  it("mints one in the given domain otherwise", () => {
    const msg = normalizeMessage({ from: "a@b.com", ...base, text: "x" })
    expect(resolveMessageId(msg, "acme.com")).toMatch(/^<[a-z0-9.]+@acme\.com>$/)
  })
})
