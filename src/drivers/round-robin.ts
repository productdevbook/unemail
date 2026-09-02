import type { EmailDriver, EmailResult, SendContext } from "../core/types.ts"
import { driverHandler } from "../core/define.ts"
import { createInitializer } from "./_lazy-init.ts"
import { createError } from "../core/error.ts"
import { err } from "../core/result.ts"

export interface RoundRobinOptions {
  /** Relative share per driver, positionally. `[3, 1]` sends three times
   *  as much through the first. Default: equal weights. */
  weights?: readonly number[]
  /** Name reported on results and errors. Default: `round-robin`. */
  name?: string
}

/**
 * Spread sends across providers to stay under each one's rate limit, or to
 * warm a second sending domain.
 *
 * A batch is partitioned and each partition goes to its driver in one
 * request, so native batching survives the split. This does not fail over —
 * wrap it in `fallback()` if you need that.
 *
 * ```ts
 * roundRobin([resend({ apiKey }), ses({ region })], { weights: [3, 1] })
 * ```
 */
export function roundRobin(
  drivers: readonly EmailDriver[],
  options: RoundRobinOptions = {},
): EmailDriver {
  if (drivers.length === 0) throw createError("round-robin", "INVALID_OPTIONS", "no drivers given")
  const name = options.name ?? "round-robin"
  const handlers = drivers.map((driver) => ({ driver, handle: driverHandler(driver) }))
  const initialize = createInitializer()
  // The weights are expanded into a fixed schedule once, so picking the
  // next driver is an array index rather than a weighted draw per send.
  const schedule = buildSchedule(drivers.length, options.weights)
  let cursor = 0

  function nextIndex(): number {
    const index = schedule[cursor % schedule.length]!
    cursor = (cursor + 1) % schedule.length
    return index
  }

  return {
    name,
    features: drivers[0]?.features,
    getInstance: () => drivers,
    async dispose() {
      await Promise.all(drivers.map((driver) => driver.dispose?.()))
    },
    async isAvailable() {
      const checks = await Promise.all(
        drivers.map(async (driver) => {
          try {
            return (await driver.isAvailable?.()) ?? true
          } catch {
            return false
          }
        }),
      )
      return checks.some(Boolean)
    },

    async send(msg, ctx) {
      const { driver, handle } = handlers[nextIndex()]!
      await initialize(driver)
      const produced = await handle([msg], { ...ctx, driver: driver.name })
      return produced[0] ?? err<EmailResult>(noResult(driver.name))
    },

    async sendBatch(msgs, ctx) {
      const partitions = new Map<number, number[]>()
      for (const index of msgs.keys()) {
        const target = nextIndex()
        const bucket = partitions.get(target)
        if (bucket) bucket.push(index)
        else partitions.set(target, [index])
      }

      const results = Array.from({ length: msgs.length }, () => err<EmailResult>(noResult(name)))
      await Promise.all(
        [...partitions].map(async ([target, indices]) => {
          const { driver, handle } = handlers[target]!
          const ctxForLeg: SendContext = { ...ctx, driver: driver.name }
          await initialize(driver)
          const produced = await handle(
            indices.map((index) => msgs[index]!),
            ctxForLeg,
          )
          for (const [slot, index] of indices.entries()) {
            results[index] = produced[slot] ?? err<EmailResult>(noResult(driver.name))
          }
        }),
      )
      return results
    },
  }
}

function buildSchedule(count: number, weights?: readonly number[]): number[] {
  if (!weights) return Array.from({ length: count }, (_, index) => index)
  const schedule: number[] = []
  for (let index = 0; index < count; index++) {
    const repeat = Math.max(0, Math.floor(weights[index] ?? 1))
    for (let n = 0; n < repeat; n++) schedule.push(index)
  }
  if (schedule.length === 0) {
    throw createError("round-robin", "INVALID_OPTIONS", "every weight was zero")
  }
  return schedule
}

function noResult(driver: string) {
  return createError(driver, "PROVIDER", "no result for message")
}
