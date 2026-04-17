import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { memorySuppressionStore } from "../../src/suppression/index.ts"
import { withSuppression } from "../../src/middleware/suppression.ts"
import type { EmailDriver, EmailMessage } from "../../src/types.ts"

function capturing(): {
  driver: EmailDriver
  last: () => EmailMessage | undefined
  count: () => number
} {
  let last: EmailMessage | undefined
  let count = 0
  return {
    driver: {
      name: "capture",
      send: (msg) => {
        count++
        last = msg
        return { data: { id: "1", driver: "capture", at: new Date() }, error: null }
      },
    },
    last: () => last,
    count: () => count,
  }
}

describe("withSuppression", () => {
  it("blocks sends to suppressed recipients (policy=error)", async () => {
    const store = memorySuppressionStore()
    await store.add("blocked@x.com", "bounce")
    const cap = capturing()
    const email = createEmail({ driver: withSuppression(cap.driver, { store }) })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "blocked@x.com",
      subject: "hi",
      text: "x",
    })
    expect(data).toBeNull()
    expect(error?.code).toBe("PROVIDER")
    expect(cap.count()).toBe(0)
  })

  it("passes through when recipient is not suppressed", async () => {
    const store = memorySuppressionStore()
    const cap = capturing()
    const email = createEmail({ driver: withSuppression(cap.driver, { store }) })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "ok@x.com",
      subject: "hi",
      text: "x",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("1")
  })

  it("policy=drop strips suppressed recipients and forwards the rest", async () => {
    const store = memorySuppressionStore()
    await store.add("blocked@x.com", "bounce")
    const cap = capturing()
    const email = createEmail({
      driver: withSuppression(cap.driver, { store, policy: "drop" }),
    })
    await email.send({
      from: "a@b.com",
      to: ["blocked@x.com", "ok@x.com"],
      subject: "hi",
      text: "x",
    })
    const last = cap.last()!
    const to = Array.isArray(last.to) ? last.to : [last.to]
    const emails = to.map((t: unknown) =>
      typeof t === "string" ? t : (t as { email: string }).email,
    )
    expect(emails).toEqual(["ok@x.com"])
  })

  it("policy=drop with all recipients suppressed still errors", async () => {
    const store = memorySuppressionStore()
    await store.add("a@x.com", "bounce")
    await store.add("b@x.com", "bounce")
    const cap = capturing()
    const email = createEmail({
      driver: withSuppression(cap.driver, { store, policy: "drop" }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: ["a@x.com", "b@x.com"],
      subject: "hi",
      text: "x",
    })
    expect(data).toBeNull()
    expect(error?.code).toBe("PROVIDER")
    expect(cap.count()).toBe(0)
  })

  it("fires onBlocked for each suppressed recipient", async () => {
    const store = memorySuppressionStore()
    await store.add("blocked@x.com", "complaint")
    const blocks: Array<[string, string]> = []
    const email = createEmail({
      driver: withSuppression(capturing().driver, {
        store,
        onBlocked: (r, reason) => blocks.push([r, reason]),
      }),
    })
    await email.send({
      from: "a@b.com",
      to: "blocked@x.com",
      subject: "hi",
      text: "x",
    })
    expect(blocks).toEqual([["blocked@x.com", "complaint"]])
  })
})
