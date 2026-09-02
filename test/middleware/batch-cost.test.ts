import { describe, expect, it } from "vitest"
import type { EmailDriver, EmailResult } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { createError } from "../../src/core/error.ts"
import { err, ok } from "../../src/core/result.ts"
import { fallback } from "../../src/drivers/fallback.ts"
import { withRetry } from "../../src/middleware/retry.ts"

/**
 * What partial-batch retry costs, counted rather than timed.
 *
 * The property worth stating about the batch-native pipeline is not that it
 * is faster — against an in-process driver it is not, because the whole
 * difference disappears under the fixed cost of normalizing the batch once.
 * It is that a transient failure in five hundred costs a handful of
 * re-sends instead of five hundred: five hundred fewer messages billed, and
 * on a provider without idempotency, five hundred fewer duplicate
 * deliveries.
 *
 * That is a count, so it is asserted as one. `bench/batch-retry.bench.ts`
 * measures what is genuinely time-bound; this file measures what matters.
 */

const defaults = { from: "Acme <hi@acme.com>" }
const SIZE = 500
const messages = Array.from({ length: SIZE }, (_, i) => ({
  to: `user${i}@example.com`,
  subject: "s",
  text: "t",
}))

/** Counts every message handed to the provider, across every attempt. */
function counting(failEvery: number | null) {
  const seen = new Set<string>()
  let delivered = 0
  let requests = 0

  const driver: EmailDriver = {
    name: "counting",
    features: { batch: true },
    send: (msg) => {
      requests++
      delivered++
      return ok({ id: msg.to[0]!.email, driver: "counting", at: new Date() })
    },
    sendBatch(msgs) {
      requests++
      delivered += msgs.length
      return msgs.map((msg, index) => {
        const key = msg.to[0]!.email
        const firstTime = !seen.has(key)
        seen.add(key)
        return firstTime && failEvery !== null && index % failEvery === 0
          ? err<EmailResult>(createError("counting", "NETWORK", "transient"))
          : ok({ id: key, driver: "counting", at: new Date() })
      })
    },
  }

  return { driver, delivered: () => delivered, requests: () => requests }
}

const noSleep = { sleep: async () => {} }

describe("partial-batch retry", () => {
  it("re-sends only what failed, so 5 failures cost 505 deliveries and not 1000", async () => {
    const provider = counting(100) // 1% fail: indices 0, 100, 200, 300, 400
    const batch = await createEmail({
      driver: provider.driver,
      defaults,
      use: [withRetry(noSleep)],
    }).sendBatch(messages)

    expect(batch.ok).toBe(true)
    expect(provider.delivered()).toBe(SIZE + 5)
    expect(provider.requests()).toBe(2)
  })

  it("scales with the failure count, not the batch size", async () => {
    const costs: Record<string, number> = {}
    for (const [label, failEvery] of [
      ["1%", 100],
      ["5%", 20],
      ["20%", 5],
    ] as const) {
      const provider = counting(failEvery)
      await createEmail({
        driver: provider.driver,
        defaults,
        use: [withRetry(noSleep)],
      }).sendBatch(messages)
      costs[label] = provider.delivered() - SIZE
    }

    expect(costs).toEqual({ "1%": 5, "5%": 25, "20%": 100 })
  })

  it("delivers nothing twice when nothing failed", async () => {
    const provider = counting(null)
    await createEmail({
      driver: provider.driver,
      defaults,
      use: [withRetry(noSleep)],
    }).sendBatch(messages)

    expect(provider.delivered()).toBe(SIZE)
    expect(provider.requests()).toBe(1)
  })
})

describe("failover", () => {
  it("sends only the failures to the standby", async () => {
    const primary = counting(20) // 5% fail
    const standby = counting(null)

    const batch = await createEmail({
      driver: fallback([primary.driver, standby.driver]),
      defaults,
    }).sendBatch(messages)

    expect(batch.ok).toBe(true)
    expect(primary.delivered()).toBe(SIZE)
    // 25 failures reached the standby; the other 475 were never re-sent, so
    // nobody received the message twice.
    expect(standby.delivered()).toBe(25)
  })

  it("never reaches the standby when the primary accepts everything", async () => {
    const primary = counting(null)
    const standby = counting(null)

    await createEmail({ driver: fallback([primary.driver, standby.driver]), defaults }).sendBatch(
      messages,
    )

    expect(standby.requests()).toBe(0)
  })
})
