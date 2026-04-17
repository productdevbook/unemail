import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { EventBus, memoryEventStore, withEvents } from "../../src/events/index.ts"
import mock from "../../src/drivers/mock.ts"
import type { EmailEvent } from "../../src/events/index.ts"

describe("unified event stream", () => {
  it("withEvents emits send.queued/attempt/success around a driver send", async () => {
    const bus = new EventBus()
    const events: EmailEvent[] = []
    bus.on((e) => events.push(e))

    const email = createEmail({ driver: withEvents(mock(), bus) })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })

    expect(events.map((e) => e.type)).toEqual(["send.queued", "send.attempt", "send.success"])
    expect(events[2]!.messageId).toMatch(/^mock_/)
  })

  it("memoryEventStore captures events by messageId", async () => {
    const store = memoryEventStore()
    store.append({ type: "send.success", messageId: "m1", provider: "x", at: new Date() })
    store.append({ type: "delivered", messageId: "m1", provider: "x", at: new Date() })
    store.append({ type: "send.success", messageId: "m2", provider: "x", at: new Date() })
    const events = await store.list!("m1")
    expect(events).toHaveLength(2)
  })
})
