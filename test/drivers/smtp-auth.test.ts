import { describe, expect, it } from "vitest"
import type { AuthContext, SmtpReply } from "../../src/drivers/_smtp/auth.ts"
import {
  authCramMd5,
  authLogin,
  authPlain,
  authXoauth2,
  pickAuthMethod,
} from "../../src/drivers/_smtp/auth.ts"

const ok: SmtpReply = { code: 235, lines: ["ok"], raw: "ok" }

/** Records what the client sends and replays scripted server replies. */
function conversation(replies: SmtpReply[] = []): AuthContext & { sent: string[] } {
  const sent: string[] = []
  const queue = [...replies]
  return {
    sent,
    async send(line) {
      sent.push(line)
    },
    async recv() {
      return queue.shift() ?? ok
    },
  }
}

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64")

describe("pickAuthMethod", () => {
  it("honours an explicit preference the server advertises", () => {
    expect(pickAuthMethod(new Set(["PLAIN", "LOGIN"]), "LOGIN")).toBe("LOGIN")
  })

  it("ignores a preference the server does not advertise, and falls back", () => {
    expect(pickAuthMethod(new Set(["PLAIN"]), "CRAM-MD5")).toBe("PLAIN")
  })

  it("prefers PLAIN, then LOGIN, then CRAM-MD5, then XOAUTH2", () => {
    expect(pickAuthMethod(new Set(["XOAUTH2", "CRAM-MD5", "LOGIN", "PLAIN"]))).toBe("PLAIN")
    expect(pickAuthMethod(new Set(["XOAUTH2", "CRAM-MD5", "LOGIN"]))).toBe("LOGIN")
    expect(pickAuthMethod(new Set(["XOAUTH2", "CRAM-MD5"]))).toBe("CRAM-MD5")
    expect(pickAuthMethod(new Set(["XOAUTH2"]))).toBe("XOAUTH2")
  })

  it("returns null when the server advertises nothing we speak", () => {
    expect(pickAuthMethod(new Set(["GSSAPI", "NTLM"]))).toBeNull()
  })

  it("returns null when the server advertises nothing at all", () => {
    expect(pickAuthMethod(new Set())).toBeNull()
  })
})

describe("AUTH PLAIN (RFC 4616)", () => {
  it("sends authzid, authcid and password separated by NUL", async () => {
    const ctx = conversation()
    await authPlain(ctx, "ada@acme.com", "s3cret")

    expect(ctx.sent).toHaveLength(1)
    const payload = ctx.sent[0]!.replace("AUTH PLAIN ", "")
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("\0ada@acme.com\0s3cret")
  })

  it("does not leak the password into the command line itself", async () => {
    const ctx = conversation()
    await authPlain(ctx, "u", "hunter2")
    expect(ctx.sent[0]).not.toContain("hunter2")
  })
})

describe("AUTH LOGIN", () => {
  it("sends the username and password base64 on separate turns", async () => {
    const ctx = conversation([
      { code: 334, lines: [b64("Username:")], raw: b64("Username:") },
      { code: 334, lines: [b64("Password:")], raw: b64("Password:") },
      ok,
    ])
    const reply = await authLogin(ctx, "ada", "s3cret")

    expect(ctx.sent).toEqual(["AUTH LOGIN", b64("ada"), b64("s3cret")])
    expect(reply.code).toBe(235)
  })
})

describe("AUTH CRAM-MD5 (RFC 2195)", () => {
  it("decodes the challenge, HMACs it with the password, and replies `user digest`", async () => {
    // The example challenge from RFC 2195 §2.
    const challenge = "<1896.697170952@postoffice.reston.mci.net>"
    const ctx = conversation([{ code: 334, lines: [b64(challenge)], raw: b64(challenge) }, ok])

    const seen: { key: string; data: string }[] = []
    const hmac = (key: string, data: string) => {
      seen.push({ key, data })
      return "b913a602c7eda7a495b4e6e7334d3890"
    }

    await authCramMd5(ctx, "tim", "tanstaaftanstaaf", hmac)

    // The challenge must reach the HMAC decoded, not as base64.
    expect(seen).toEqual([{ key: "tanstaaftanstaaf", data: challenge }])
    expect(ctx.sent[0]).toBe("AUTH CRAM-MD5")
    expect(Buffer.from(ctx.sent[1]!, "base64").toString("utf8")).toBe(
      "tim b913a602c7eda7a495b4e6e7334d3890",
    )
  })
})

describe("AUTH XOAUTH2", () => {
  it("builds the ctrl-A delimited bearer payload Google and Microsoft expect", async () => {
    const ctx = conversation()
    await authXoauth2(ctx, "ada@acme.com", "ya29.token")

    const payload = ctx.sent[0]!.replace("AUTH XOAUTH2 ", "")
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(
      "user=ada@acme.com\x01auth=Bearer ya29.token\x01\x01",
    )
  })

  it("does not leak the token into the command line itself", async () => {
    const ctx = conversation()
    await authXoauth2(ctx, "u", "ya29.secret")
    expect(ctx.sent[0]).not.toContain("ya29.secret")
  })
})
