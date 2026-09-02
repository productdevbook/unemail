import { bench, describe } from "vitest"
import type { EmailDriver, EmailResult } from "../src/core/types.ts"
import { createEmail } from "../src/core/email.ts"
import { createError } from "../src/core/error.ts"
import { err, ok } from "../src/core/result.ts"
import { fallback } from "../src/drivers/fallback.ts"
import { withRetry } from "../src/middleware/retry.ts"

/**
 * What retry and failover cost in CPU.
 *
 * Note what is *not* here. The interesting property of partial-batch retry
 * — that a transient failure in five hundred costs five re-sends and not
 * five hundred — is not a CPU property at all. It is provider quota and
 * duplicate deliveries, and timing it against an in-process driver measures
 * neither: the whole difference disappears under the fixed cost of
 * normalizing the batch once. That claim is counted rather than timed, in
 * `test/middleware/batch-cost.test.ts`, where the number is exact.
 *
 * @module
 */

const defaults = { from: "Acme <hi@acme.com>" }
const SIZE = 500
const messages = Array.from({ length: SIZE }, (_, i) => ({
  to: `user${i}@example.com`,
  subject: "s",
  text: "t",
}))

/** Fails a fixed fraction on the first attempt, accepts everything after.
 *  The per-message cost is a payload serialization — what a real HTTP driver
 *  spends before the socket — so this reflects work done. */
function flaky(failEvery: number | null): EmailDriver {
  const seen = new Set<string>()
  return {
    name: "flaky",
    features: { batch: true },
    send: () => ok({ id: "x", driver: "flaky", at: new Date() }),
    sendBatch(msgs) {
      return msgs.map((msg, index) => {
        JSON.stringify({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text })
        const key = msg.to[0]!.email
        const firstTime = !seen.has(key)
        seen.add(key)
        return firstTime && failEvery !== null && index % failEvery === 0
          ? err<EmailResult>(createError("flaky", "NETWORK", "transient"))
          : ok({ id: key, driver: "flaky", at: new Date() })
      })
    },
  }
}

const noSleep = { sleep: async () => {} }

describe(`a ${SIZE}-message batch`, () => {
  bench("no failures, no retry middleware", async () => {
    await createEmail({
      driver: flaky(null),
      defaults,
    }).sendBatch(messages)
  })

  bench("no failures, retry middleware installed", async () => {
    await createEmail({
      driver: flaky(null),
      defaults,
      use: [withRetry(noSleep)],
    }).sendBatch(messages)
  })

  for (const [label, failEvery] of [
    ["1% fail", 100],
    ["5% fail", 20],
    ["20% fail", 5],
  ] as const) {
    bench(`${label}, retried`, async () => {
      await createEmail({
        driver: flaky(failEvery),
        defaults,
        use: [withRetry(noSleep)],
      }).sendBatch(messages)
    })
  }
})

describe("failover", () => {
  bench("no failures — the standby is never reached", async () => {
    await createEmail({
      driver: fallback([flaky(null), flaky(null)]),
      defaults,
    }).sendBatch(messages)
  })

  bench("5% fails over to the standby", async () => {
    await createEmail({
      driver: fallback([flaky(20), flaky(null)]),
      defaults,
    }).sendBatch(messages)
  })
})
