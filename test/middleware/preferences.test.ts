import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { withPreferences } from "../../src/middleware/preferences.ts"
import { memoryPreferenceStore } from "../../src/preferences/index.ts"
import type { EmailDriver } from "../../src/types.ts"

function capturing(): { driver: EmailDriver; calls: () => number } {
  let n = 0
  return {
    driver: {
      name: "probe",
      send() {
        n++
        return { data: { id: "ok", driver: "probe", at: new Date() }, error: null }
      },
    },
    calls: () => n,
  }
}

describe("withPreferences", () => {
  it("drops recipients who opted out of the tag category", async () => {
    const store = memoryPreferenceStore()
    await store.set("bob@x.com", "marketing", false)
    const cap = capturing()
    const email = createEmail({ driver: withPreferences(cap.driver, { store }) })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: ["ada@x.com", "bob@x.com"],
      subject: "hi",
      text: "x",
      tags: [{ name: "category", value: "marketing" }],
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("ok")
    expect(cap.calls()).toBe(1)
  })

  it("blocks the send when every recipient opted out", async () => {
    const store = memoryPreferenceStore()
    await store.set("ada@x.com", "marketing", false)
    const cap = capturing()
    const email = createEmail({ driver: withPreferences(cap.driver, { store }) })
    const { error } = await email.send({
      from: "a@b.com",
      to: "ada@x.com",
      subject: "hi",
      text: "x",
      tags: [{ name: "category", value: "marketing" }],
    })
    expect(error?.code).toBe("PROVIDER")
    expect(cap.calls()).toBe(0)
  })

  it("passes through when no category resolves", async () => {
    const cap = capturing()
    const email = createEmail({
      driver: withPreferences(cap.driver, { store: memoryPreferenceStore() }),
    })
    await email.send({ from: "a@b.com", to: "x@y.com", subject: "hi", text: "x" })
    expect(cap.calls()).toBe(1)
  })
})
