import { describe, expect, it } from "vitest"
import { createTestEmail, emailMatchers, matchesEmail } from "../../src/test/index.ts"

expect.extend(emailMatchers)

describe("emailMatchers", () => {
  it("matches by subject regex", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "Welcome Ada", text: "" })
    expect(emailMatchers.toHaveSent(email, { subject: /welcome/i }).pass).toBe(true)
  })

  it("matches by recipient email", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "Ada <ada@acme.com>", subject: "hi", text: "" })
    expect(emailMatchers.toHaveSent(email, { to: "ada@acme.com" }).pass).toBe(true)
  })

  it("fails cleanly when no message matches", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "" })
    const result = emailMatchers.toHaveSent(email, { subject: "missing" })
    expect(result.pass).toBe(false)
    expect(result.message()).toMatch(/expected an email to match/)
  })
})

describe("matchesEmail", () => {
  it("matches string fields", () => {
    const match = matchesEmail({ from: "a@b.com", to: "c@d.com", subject: "hi" }, { subject: "hi" })
    expect(match.pass).toBe(true)
  })
  it("rejects mismatches with a diff", () => {
    const match = matchesEmail(
      { from: "a@b.com", to: "c@d.com", subject: "hi" },
      { subject: "not-hi" },
    )
    expect(match.pass).toBe(false)
    expect(match.diff).toMatch(/expected subject/)
  })
})
