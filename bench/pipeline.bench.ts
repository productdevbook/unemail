import { bench, describe } from "vitest"
import type { Email } from "../src/core/email.ts"
import { createEmail } from "../src/core/email.ts"
import { defineMiddleware } from "../src/core/define.ts"
import mock from "../src/drivers/mock.ts"
import { withCircuitBreaker } from "../src/middleware/circuit-breaker.ts"
import { withIdempotency } from "../src/middleware/idempotency.ts"
import { withLogger } from "../src/middleware/logger.ts"
import { withRateLimit } from "../src/middleware/rate-limit.ts"
import { withRetry } from "../src/middleware/retry.ts"

/**
 * What the pipeline costs on top of the driver.
 *
 * Every send here goes to the mock driver, so nothing is waiting on a
 * network and the numbers are the library's own overhead — the figure that
 * matters when deciding how much middleware to stack in a request path.
 *
 * @module
 */

const defaults = { from: "Acme <hi@acme.com>" }
const msg = { to: "ada@example.com", subject: "s", text: "t" } as const
const batch = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ...msg, to: `user${i}@example.com` }))

const noop = defineMiddleware("noop", (next) => next)

/** The mock driver accumulates every message it accepts, which would show
 *  up as growing memory rather than pipeline cost. Clear it each round. */
function fresh(...use: Parameters<Email["use"]>[0][]) {
  const driver = mock()
  const email = createEmail({ driver, defaults })
  for (const middleware of use) email.use(middleware)
  return { email, clear: () => driver.getInstance().clear() }
}

describe("send — middleware depth", () => {
  const bare = fresh()
  bench("no middleware", async () => {
    await bare.email.send(msg)
    bare.clear()
  })

  const one = fresh(noop)
  bench("1 middleware", async () => {
    await one.email.send(msg)
    one.clear()
  })

  const five = fresh(noop, noop, noop, noop, noop)
  bench("5 middleware", async () => {
    await five.email.send(msg)
    five.clear()
  })

  // The stack somebody actually ships: measured together, because the
  // interesting number is what the whole set costs, not each in isolation.
  const real = fresh(
    withLogger({ log: () => {} }),
    withCircuitBreaker(),
    withRetry(),
    withRateLimit({ limit: 1_000_000 }),
    withIdempotency(),
  )
  bench("logger + breaker + retry + rate limit + idempotency", async () => {
    await real.email.send(msg)
    real.clear()
  })
})

describe("sendBatch — scaling", () => {
  for (const size of [1, 10, 100, 1000]) {
    const messages = batch(size)
    const { email, clear } = fresh()
    bench(`${size} message${size === 1 ? "" : "s"}`, async () => {
      await email.sendBatch(messages)
      clear()
    })
  }
})

describe("sendStream — chunk size", () => {
  const messages = batch(1000)
  for (const chunkSize of [1, 50, 500]) {
    const { email, clear } = fresh()
    bench(`1000 messages, chunkSize ${chunkSize}`, async () => {
      for await (const _ of email.sendStream(messages, { chunkSize })) {
        // Drained rather than collected: the point of the stream is that
        // nothing larger than a chunk is held.
      }
      clear()
    })
  }
})

describe("routing", () => {
  const single = fresh()
  const messages = batch(100)
  bench("100 messages, one driver", async () => {
    await single.email.sendBatch(messages)
    single.clear()
  })

  // Grouping by destination costs a map lookup per message plus one
  // stitch-back at the end; this says how much.
  const a = mock()
  const b = mock()
  const routed = createEmail({ driver: a, mounts: { b }, defaults })
  const mixed = messages.map((m, i) => (i % 2 ? { ...m, stream: "b" } : m))
  bench("100 messages, split across two mounts", async () => {
    await routed.sendBatch(mixed)
    a.getInstance().clear()
    b.getInstance().clear()
  })
})
