import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import {
  defineUnsubscribeHandler,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../../src/compliance/index.ts"
import { memorySuppressionStore } from "../../src/suppression/index.ts"
import type { EmailDriver, EmailMessage } from "../../src/types.ts"

function capturing(): { driver: EmailDriver; last: () => EmailMessage | undefined } {
  let last: EmailMessage | undefined
  return {
    driver: {
      name: "capture",
      send: (msg) => {
        last = msg
        return { data: { id: "1", driver: "capture", at: new Date() }, error: null }
      },
    },
    last: () => last,
  }
}

describe("List-Unsubscribe auto-injection", () => {
  it("injects both RFC 2369 and RFC 8058 headers when a URL is provided", async () => {
    const cap = capturing()
    const email = createEmail({ driver: cap.driver })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
      unsubscribe: { url: "https://example.com/u?t=abc" },
    })
    const headers = cap.last()!.headers!
    expect(headers["List-Unsubscribe"]).toBe("<https://example.com/u?t=abc>")
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
  })

  it("supports mailto-only unsubscribe (RFC 2369 without one-click)", async () => {
    const cap = capturing()
    const email = createEmail({ driver: cap.driver })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
      unsubscribe: { mailto: "unsubscribe@example.com" },
    })
    const headers = cap.last()!.headers!
    expect(headers["List-Unsubscribe"]).toBe("<mailto:unsubscribe@example.com>")
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined()
  })

  it("honours existing user-supplied headers without duplication", async () => {
    const cap = capturing()
    const email = createEmail({ driver: cap.driver })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
      headers: { "List-Unsubscribe": "<https://manual>" },
      unsubscribe: { url: "https://example.com/u" },
    })
    const headers = cap.last()!.headers!
    expect(headers["List-Unsubscribe"]).toBe("<https://manual>")
  })

  it("emits both url + mailto when both are provided", async () => {
    const cap = capturing()
    const email = createEmail({ driver: cap.driver })
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
      unsubscribe: { url: "https://example.com/u", mailto: "u@example.com" },
    })
    const headers = cap.last()!.headers!
    expect(headers["List-Unsubscribe"]).toBe("<https://example.com/u>, <mailto:u@example.com>")
  })
})

describe("unsubscribe token", () => {
  it("signs and verifies round-trip", async () => {
    const token = await signUnsubscribeToken(
      { recipient: "ada@acme.com", campaign: "welcome" },
      "s3cret",
    )
    const payload = await verifyUnsubscribeToken(token, "s3cret")
    expect(payload).toEqual({ recipient: "ada@acme.com", campaign: "welcome" })
  })

  it("rejects tampered tokens (body edited after signing)", async () => {
    const token = await signUnsubscribeToken({ recipient: "ada@acme.com" }, "s3cret")
    const [body, sig] = token.split(".")
    const tamperedBody = body!.slice(0, -2) + "AA"
    expect(await verifyUnsubscribeToken(`${tamperedBody}.${sig}`, "s3cret")).toBeNull()
  })

  it("rejects tokens signed with a different secret", async () => {
    const token = await signUnsubscribeToken({ recipient: "ada@acme.com" }, "s3cret")
    expect(await verifyUnsubscribeToken(token, "different")).toBeNull()
  })

  it("rejects expired tokens", async () => {
    const token = await signUnsubscribeToken({ recipient: "ada@acme.com", exp: 1000 }, "s3cret")
    expect(await verifyUnsubscribeToken(token, "s3cret", () => 2_000_000)).toBeNull()
  })
})

describe("defineUnsubscribeHandler", () => {
  it("adds the recipient to the store on a valid POST", async () => {
    const store = memorySuppressionStore()
    const handler = defineUnsubscribeHandler({ secret: "sk", store })
    const token = await signUnsubscribeToken({ recipient: "ada@acme.com" }, "sk")
    const res = await handler(
      new Request(`https://app/u?t=${encodeURIComponent(token)}`, { method: "POST" }),
    )
    expect(res.status).toBe(200)
    const rec = await store.has("ada@acme.com")
    expect(rec?.reason).toBe("unsubscribed")
  })

  it("rejects invalid tokens with 400", async () => {
    const handler = defineUnsubscribeHandler({ secret: "sk" })
    const res = await handler(new Request("https://app/u?t=garbage"))
    expect(res.status).toBe(400)
  })
})
