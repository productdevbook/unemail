import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { withDedupe } from "../../src/middleware/dedupe.ts"
import { memoryIdempotencyStore } from "../../src/_idempotency.ts"
import type { EmailDriver } from "../../src/types.ts"

function counting(): EmailDriver & { count: () => number } {
  let n = 0
  return {
    name: "count",
    send() {
      n++
      return { data: { id: `c_${n}`, driver: "count", at: new Date() }, error: null }
    },
    count: () => n,
  } as EmailDriver & { count: () => number }
}

describe("withDedupe", () => {
  it("returns cached result for same idempotencyKey within TTL", async () => {
    const driver = counting()
    const store = memoryIdempotencyStore()
    const email = createEmail({
      driver: withDedupe(driver, { store, ttlSeconds: 60 }),
    })
    const msg = {
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
      idempotencyKey: "k1",
    }
    const a = await email.send(msg)
    const b = await email.send(msg)
    expect(driver.count()).toBe(1)
    expect(a.data?.id).toBe(b.data?.id)
  })

  it("contentHash strategy dedupes identical send(msg) calls", async () => {
    const driver = counting()
    const email = createEmail({
      driver: withDedupe(driver, { strategy: "contentHash" }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "body" })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "body" })
    expect(driver.count()).toBe(1)
  })

  it("passes through when no key is available", async () => {
    const driver = counting()
    const email = createEmail({
      driver: withDedupe(driver, { strategy: "idempotencyKey" }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    expect(driver.count()).toBe(2)
  })
})
