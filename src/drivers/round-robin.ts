import type { DriverFactory, EmailDriver } from "../types.ts"
import { defineDriver } from "../_define.ts"
import { createError } from "../errors.ts"

export interface RoundRobinOptions {
  drivers: ReadonlyArray<EmailDriver>
  /** Optional integer weights — `[2, 1, 1]` sends 2 messages to `drivers[0]`
   *  for every 1 sent to the others. Defaults to equal weighting. */
  weights?: ReadonlyArray<number>
}

/** Cycle through drivers per-send. Unlike `fallback`, errors are *not*
 *  retried on another driver — use `fallback` (or `withRetry`) for that. */
const roundRobin: DriverFactory<RoundRobinOptions> = defineDriver<RoundRobinOptions>((options) => {
  if (!options || options.drivers.length === 0)
    throw createError("round-robin", "INVALID_OPTIONS", "at least one driver is required")

  const drivers = options.drivers
  const weights = options.weights ?? drivers.map(() => 1)
  if (weights.length !== drivers.length)
    throw createError("round-robin", "INVALID_OPTIONS", "weights length must match drivers")

  const schedule: EmailDriver[] = []
  for (let i = 0; i < drivers.length; i++) {
    for (let n = 0; n < (weights[i] ?? 1); n++) schedule.push(drivers[i]!)
  }
  let cursor = 0

  return {
    name: "round-robin",
    options,
    send(msg, ctx) {
      const driver = schedule[cursor % schedule.length]!
      cursor++
      ctx.driver = driver.name
      return driver.send(msg, ctx)
    },
    async initialize() {
      await Promise.all(drivers.map((d) => d.initialize?.()))
    },
    async dispose() {
      await Promise.all(drivers.map((d) => d.dispose?.()))
    },
  }
})

export default roundRobin
