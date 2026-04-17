import type { EmailDriver } from "../types.ts"
import { createError } from "../errors.ts"

/** Sliding-window rate limiter — queues calls until they fit in the
 *  per-second budget. Intentionally simple: single-process only, no
 *  cross-instance coordination. For distributed limits, plug a driver
 *  that delegates to Redis/QStash. */
export interface RateLimitOptions {
  /** Maximum calls per `windowMs`. */
  perSecond?: number
  /** Alternative window in milliseconds — defaults to 1000. */
  windowMs?: number
  /** Hard cap on queued sends before rejecting fast. Default: 1000. */
  maxQueue?: number
  /** Injected for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Wrap a driver so `send()` respects a rate limit. */
export function withRateLimit(driver: EmailDriver, options: RateLimitOptions): EmailDriver {
  const perSecond = options.perSecond ?? 10
  const windowMs = options.windowMs ?? 1000
  const maxQueue = options.maxQueue ?? 1000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

  const timestamps: number[] = []
  let queued = 0

  return {
    ...driver,
    async send(msg, ctx) {
      if (queued >= maxQueue) {
        return {
          data: null,
          error: createError(driver.name, "RATE_LIMIT", "rate-limit queue full", {
            status: 429,
            retryable: true,
          }),
        }
      }
      queued++
      try {
        while (true) {
          const ts = now()
          const cutoff = ts - windowMs
          while (timestamps.length && timestamps[0]! <= cutoff) timestamps.shift()
          if (timestamps.length < perSecond) {
            timestamps.push(ts)
            break
          }
          const wait = timestamps[0]! + windowMs - ts
          await sleep(Math.max(wait, 1))
        }
        return await driver.send(msg, ctx)
      } finally {
        queued--
      }
    },
  }
}
