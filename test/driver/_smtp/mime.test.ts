import { describe, expect, it } from "vitest"
import { buildMime, dotStuff, normalizeMimeInput } from "../../../src/driver/_smtp/mime.ts"

describe("mime/dotStuff", () => {
  it("doubles dots that begin a line", () => {
    expect(dotStuff(".hidden")).toBe("..hidden")
    expect(dotStuff("body\n.ok")).toBe("body\r\n..ok")
    expect(dotStuff("body\r\n.ok")).toBe("body\r\n..ok")
  })
  it("leaves non-dot starts alone", () => {
    expect(dotStuff("hi\nthere")).toBe("hi\r\nthere")
  })
})

describe("buildMime", () => {
  it("produces a single text/plain part for plain text", () => {
    const out = buildMime(
      normalizeMimeInput(
        {
          from: "a@b.com",
          to: "c@d.com",
          subject: "hi",
          text: "hello world",
        },
        "<id@host>",
      ),
    )
    expect(out.headers["Content-Type"]).toBe("text/plain; charset=utf-8")
    expect(out.body).toContain("hello world")
    expect(out.envelope.rcpt).toEqual(["c@d.com"])
  })

  it("produces multipart/alternative when both text and html present", () => {
    const out = buildMime(
      normalizeMimeInput(
        {
          from: "a@b.com",
          to: "c@d.com",
          subject: "hi",
          text: "plain",
          html: "<p>rich</p>",
        },
        "<id@host>",
      ),
    )
    expect(out.headers["Content-Type"]).toMatch(/multipart\/alternative/)
    expect(out.body).toContain("plain")
    expect(out.body).toContain("<p>rich</p>")
  })

  it("produces multipart/mixed when attachments are attached", () => {
    const out = buildMime(
      normalizeMimeInput(
        {
          from: "a@b.com",
          to: "c@d.com",
          subject: "hi",
          text: "hey",
          attachments: [{ filename: "note.txt", content: "hello" }],
        },
        "<id@host>",
      ),
    )
    expect(out.headers["Content-Type"]).toMatch(/multipart\/mixed/)
    expect(out.body).toContain('filename="note.txt"')
  })

  it("merges cc and bcc into the envelope but keeps bcc out of headers", () => {
    const out = buildMime(
      normalizeMimeInput(
        {
          from: "a@b.com",
          to: "c@d.com",
          cc: "cc@d.com",
          bcc: "bcc@d.com",
          subject: "hi",
          text: "x",
        },
        "<id@host>",
      ),
    )
    expect(out.envelope.rcpt).toEqual(["c@d.com", "cc@d.com", "bcc@d.com"])
    expect(out.headers.Cc).toBe("cc@d.com")
    expect(out.headers.Bcc).toBeUndefined()
  })
})
