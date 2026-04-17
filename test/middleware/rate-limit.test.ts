import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { withRateLimit } from "../../src/middleware/rate-limit.ts"
import mock from "../../src/drivers/mock.ts"

describe("withRateLimit", () => {
  it("passes immediate calls under the budget through without sleeping", async () => {
    let clock = 1000
    const sleeps: number[] = []
    const driver = mock()
    const email = createEmail({
      driver: withRateLimit(driver, {
        perSecond: 5,
        windowMs: 1000,
        now: () => clock,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          clock += ms
        },
      }),
    })
    for (let i = 0; i < 5; i++) {
      await email.send({ from: "a@b.com", to: "c@d.com", subject: `${i}`, text: "x" })
    }
    expect(sleeps).toEqual([])
    expect(driver.getInstance?.()).toHaveLength(5)
  })

  it("sleeps when the budget is exhausted and advances the clock", async () => {
    let clock = 1000
    const sleeps: number[] = []
    const driver = mock()
    const email = createEmail({
      driver: withRateLimit(driver, {
        perSecond: 2,
        windowMs: 1000,
        now: () => clock,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          clock += ms
        },
      }),
    })
    for (let i = 0; i < 5; i++) {
      await email.send({ from: "a@b.com", to: "c@d.com", subject: `${i}`, text: "x" })
    }
    expect(sleeps.length).toBeGreaterThan(0)
    expect(driver.getInstance?.()).toHaveLength(5)
  })
})
