import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { withLogger } from "../../src/middleware/logger.ts"
import mock from "../../src/driver/mock.ts"
import type { LogEntry } from "../../src/middleware/logger.ts"

describe("withLogger", () => {
  it("emits send.start and send.success entries around a successful send", async () => {
    const log: LogEntry[] = []
    const email = createEmail({ driver: mock() })
    email.use(withLogger({ sink: (e) => log.push(e) }))

    const { data } = await email.send({
      from: "a@b.com",
      to: "Ada <ada@acme.com>",
      subject: "Welcome",
      text: "hi",
    })

    expect(log.map((e) => e.event)).toEqual(["send.start", "send.success"])
    expect(log[0]!.recipient).toBe("ada@acme.com")
    expect(log[0]!.subject).toBe("Welcome")
    expect(log[1]!.messageId).toBe(data!.id)
    expect(log[1]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("emits send.error on driver failure", async () => {
    const log: LogEntry[] = []
    const email = createEmail({ driver: mock({ fail: true }) })
    email.use(withLogger({ sink: (e) => log.push(e) }))
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    const events = log.map((e) => e.event)
    expect(events).toContain("send.error")
  })

  it("redacts the local-part when redactLocalPart is set", async () => {
    const log: LogEntry[] = []
    const email = createEmail({ driver: mock() })
    email.use(withLogger({ sink: (e) => log.push(e), redactLocalPart: true }))
    await email.send({ from: "a@b.com", to: "ada@acme.com", subject: "hi", text: "x" })
    expect(log[0]!.recipient).toBe("a***@acme.com")
  })
})
