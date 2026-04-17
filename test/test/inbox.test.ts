import { describe, expect, it } from "vitest"
import { createTestEmail } from "../../src/test/index.ts"

describe("createTestEmail", () => {
  it("records sends in the inbox", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    expect(email.inbox).toHaveLength(1)
    expect(email.last?.subject).toBe("hi")
  })

  it("supports find / filter", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "one@x.com", subject: "welcome", text: "" })
    await email.send({ from: "a@b.com", to: "two@x.com", subject: "reminder", text: "" })
    await email.send({ from: "a@b.com", to: "three@x.com", subject: "welcome", text: "" })
    expect(email.filter((m) => m.subject === "welcome")).toHaveLength(2)
    expect(email.find((m) => m.subject === "reminder")?.to).toBe("two@x.com")
  })

  it("clears inbox without disposing", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    email.clear()
    expect(email.inbox).toHaveLength(0)
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi2", text: "x" })
    expect(email.inbox).toHaveLength(1)
  })

  it("waitFor resolves when a matching message arrives", async () => {
    const email = createTestEmail()
    const pending = email.waitFor((m) => m.subject === "target", { timeout: 500, interval: 5 })
    setTimeout(() => {
      email.send({ from: "a@b.com", to: "c@d.com", subject: "noise", text: "" }).catch(() => {})
      email.send({ from: "a@b.com", to: "c@d.com", subject: "target", text: "" }).catch(() => {})
    }, 20)
    const msg = await pending
    expect(msg.subject).toBe("target")
  })

  it("waitFor rejects on timeout", async () => {
    const email = createTestEmail()
    await expect(
      email.waitFor((m) => m.subject === "never", { timeout: 50, interval: 5 }),
    ).rejects.toThrow(/waitFor timed out/)
  })
})
