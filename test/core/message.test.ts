import { describe, expect, it } from "vitest"
import { getHeader, hasHeader, normalizeMessage, patchMessage } from "../../src/core/message.ts"
import { EmailError } from "../../src/core/error.ts"

const base = { to: "ada@example.com", subject: "hi", text: "hello" } as const

describe("normalizeMessage", () => {
  it("parses every address form into a flat list", () => {
    const msg = normalizeMessage({
      ...base,
      from: "Acme <hi@acme.com>",
      to: ["a@x.com", { email: "b@x.com", name: "Bee" }, "Cee <c@x.com>"],
    })
    expect(msg.from).toEqual({ email: "hi@acme.com", name: "Acme" })
    expect(msg.to).toEqual([
      { email: "a@x.com" },
      { email: "b@x.com", name: "Bee" },
      { email: "c@x.com", name: "Cee" },
    ])
  })

  it("always presents lists, so drivers never branch on nullish", () => {
    const msg = normalizeMessage({ ...base, from: "a@b.com" })
    expect(msg.cc).toEqual([])
    expect(msg.bcc).toEqual([])
    expect(msg.replyTo).toEqual([])
    expect(msg.attachments).toEqual([])
    expect(msg.tags).toEqual([])
    expect(msg.metadata).toEqual({})
  })

  it("deduplicates recipients case-insensitively", () => {
    const msg = normalizeMessage({ ...base, from: "a@b.com", to: ["X@Y.com", "x@y.com"] })
    expect(msg.to).toHaveLength(1)
  })

  it("takes `from` from the defaults when the message omits it", () => {
    const msg = normalizeMessage(base, { from: "Default <d@x.com>" })
    expect(msg.from.email).toBe("d@x.com")
  })

  it("lets the message override a default", () => {
    const msg = normalizeMessage({ ...base, from: "own@x.com" }, { from: "d@x.com" })
    expect(msg.from.email).toBe("own@x.com")
  })

  it("merges default headers, tags and metadata", () => {
    const msg = normalizeMessage(
      { ...base, from: "a@b.com", headers: { "X-B": "2" }, tags: [{ name: "t2", value: "b" }] },
      { headers: { "X-A": "1" }, tags: [{ name: "t1", value: "a" }], metadata: { env: "prod" } },
    )
    expect(msg.headers).toMatchObject({ "X-A": "1", "X-B": "2" })
    expect(msg.tags.map((t) => t.name)).toEqual(["t1", "t2"])
    expect(msg.metadata).toEqual({ env: "prod" })
  })

  it("rejects a missing `from`", () => {
    expect(() => normalizeMessage(base)).toThrow(/`from` is required/)
  })

  it("rejects an empty `to`", () => {
    expect(() => normalizeMessage({ ...base, from: "a@b.com", to: [] })).toThrow(/at least one/)
  })

  it("rejects a malformed address and names the field", () => {
    expect(() => normalizeMessage({ ...base, from: "a@b.com", cc: "not-an-email" })).toThrow(
      /`cc` contains an invalid address/,
    )
  })

  it("rejects a message with no body at all", () => {
    expect(() => normalizeMessage({ from: "a@b.com", to: "c@d.com", subject: "x" })).toThrow(
      /no body/,
    )
  })

  it("accepts a body supplied only as content", () => {
    const msg = normalizeMessage({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      content: { type: "react", element: null },
    })
    expect(msg.content?.type).toBe("react")
  })

  it("refuses a header value containing a line break", () => {
    expect(() =>
      normalizeMessage({ ...base, from: "a@b.com", headers: { "X-Evil": "a\r\nBcc: v@x.com" } }),
    ).toThrow(/line break/)
  })

  it("refuses a header name containing a line break", () => {
    expect(() =>
      normalizeMessage({ ...base, from: "a@b.com", headers: { "X\nBcc": "v@x.com" } }),
    ).toThrow(/line break/)
  })

  it("throws an EmailError with the INVALID_OPTIONS code", () => {
    try {
      normalizeMessage(base)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(EmailError)
      expect((error as EmailError).code).toBe("INVALID_OPTIONS")
    }
  })

  it("parses scheduledAt and rejects nonsense", () => {
    const msg = normalizeMessage({ ...base, from: "a@b.com", scheduledAt: "2030-01-01T00:00:00Z" })
    expect(msg.scheduledAt?.toISOString()).toBe("2030-01-01T00:00:00.000Z")
    expect(() => normalizeMessage({ ...base, from: "a@b.com", scheduledAt: "later" })).toThrow(
      /not a valid date/,
    )
  })

  it("never mutates the caller's object", () => {
    const input = { ...base, from: "a@b.com", html: "<p>x</p>", preheader: "peek" }
    const snapshot = structuredClone(input)
    normalizeMessage(input)
    expect(input).toEqual(snapshot)
  })

  it("freezes the result so a driver cannot alter a shared message", () => {
    const msg = normalizeMessage({ ...base, from: "a@b.com" })
    expect(Object.isFrozen(msg)).toBe(true)
  })

  describe("unsubscribe headers", () => {
    it("derives List-Unsubscribe and the one-click post", () => {
      const msg = normalizeMessage({
        ...base,
        from: "a@b.com",
        unsubscribe: { url: "https://acme.com/u/1", mailto: "unsub@acme.com" },
      })
      expect(msg.headers["List-Unsubscribe"]).toBe(
        "<https://acme.com/u/1>, <mailto:unsub@acme.com>",
      )
      expect(msg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    })

    it("omits the one-click post for a mailto-only unsubscribe", () => {
      const msg = normalizeMessage({
        ...base,
        from: "a@b.com",
        unsubscribe: { mailto: "unsub@acme.com" },
      })
      expect(msg.headers["List-Unsubscribe"]).toBe("<mailto:unsub@acme.com>")
      expect(msg.headers["List-Unsubscribe-Post"]).toBeUndefined()
    })

    it("does not overwrite a header the caller set explicitly", () => {
      const msg = normalizeMessage({
        ...base,
        from: "a@b.com",
        headers: { "list-unsubscribe": "<https://mine>" },
        unsubscribe: { url: "https://derived" },
      })
      expect(msg.headers["list-unsubscribe"]).toBe("<https://mine>")
      expect(msg.headers["List-Unsubscribe"]).toBeUndefined()
    })
  })

  describe("preheader", () => {
    it("injects a hidden block just inside <body>", () => {
      const msg = normalizeMessage({
        ...base,
        from: "a@b.com",
        html: "<html><body><h1>Hi</h1></body></html>",
        preheader: "Your code is inside",
      })
      expect(msg.html).toMatch(/<body><div style="display:none[^"]*">Your code is inside/)
    })

    it("prepends when there is no body tag", () => {
      const msg = normalizeMessage({ ...base, from: "a@b.com", html: "<p>Hi</p>", preheader: "x" })
      expect(msg.html?.startsWith("<div style=")).toBe(true)
    })

    it("escapes the preheader so it cannot inject markup", () => {
      const msg = normalizeMessage({
        ...base,
        from: "a@b.com",
        html: "<p>Hi</p>",
        preheader: '<script>alert("x")</script>',
      })
      expect(msg.html).not.toContain("<script>")
      expect(msg.html).toContain("&lt;script&gt;")
    })

    it("does nothing without html", () => {
      const msg = normalizeMessage({ ...base, from: "a@b.com", preheader: "x" })
      expect(msg.html).toBeUndefined()
    })
  })
})

describe("patchMessage", () => {
  it("returns a new frozen message and leaves the original alone", () => {
    const msg = normalizeMessage({ ...base, from: "a@b.com" })
    const patched = patchMessage(msg, { subject: "changed" })
    expect(patched.subject).toBe("changed")
    expect(msg.subject).toBe("hi")
    expect(Object.isFrozen(patched)).toBe(true)
  })
})

describe("header lookup", () => {
  it("matches regardless of casing", () => {
    const headers = { "Message-ID": "<a@b>" }
    expect(getHeader(headers, "message-id")).toBe("<a@b>")
    expect(hasHeader(headers, "MESSAGE-ID")).toBe(true)
    expect(hasHeader(headers, "subject")).toBe(false)
  })
})
