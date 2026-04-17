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
  /** When true, the limiter also honours `Retry-After` from 429
   *  responses by delaying the next attempt by that long. */
  respectRetryAfter?: boolean
  /** Injected for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Provider-aware preset limits. Numbers are conservative — override
 *  when your tier is higher. */
export const rateLimitPresets = {
  sendgrid: (): RateLimitOptions => ({ perSecond: 30, respectRetryAfter: true }),
  mailgun: (): RateLimitOptions => ({ perSecond: 10, respectRetryAfter: true }),
  resend: (): RateLimitOptions => ({ perSecond: 10, respectRetryAfter: true }),
  postmark: (): RateLimitOptions => ({ perSecond: 50, respectRetryAfter: true }),
  ses: (): RateLimitOptions => ({ perSecond: 14, respectRetryAfter: true }),
  brevo: (): RateLimitOptions => ({ perSecond: 5, respectRetryAfter: true }),
}

/** Wrap a driver so `send()` respects a rate limit. */
export function withRateLimit(driver: EmailDriver, options: RateLimitOptions): EmailDriver {
  const perSecond = options.perSecond ?? 10
  const windowMs = options.windowMs ?? 1000
  const maxQueue = options.maxQueue ?? 1000
  const respectRetryAfter = options.respectRetryAfter ?? false
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

  const timestamps: number[] = []
  let queued = 0
  let blockedUntil = 0

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
          if (ts < blockedUntil) {
            await sleep(blockedUntil - ts)
            continue
          }
          const cutoff = ts - windowMs
          while (timestamps.length && timestamps[0]! <= cutoff) timestamps.shift()
          if (timestamps.length < perSecond) {
            timestamps.push(ts)
            break
          }
          const wait = timestamps[0]! + windowMs - ts
          await sleep(Math.max(wait, 1))
        }
        const result = await driver.send(msg, ctx)
        if (respectRetryAfter && result.error?.status === 429) {
          const after = extractRetryAfter(result.error.cause)
          if (after != null) blockedUntil = now() + after * 1000
        }
        return result
      } finally {
        queued--
      }
    },
  }
}

function extractRetryAfter(cause: unknown): number | null {
  if (!cause || typeof cause !== "object") return null
  const rec = cause as Record<string, unknown>
  const headers = rec.headers as { get?: (name: string) => string | null } | undefined
  const raw = headers?.get?.("retry-after") ?? (rec["retry-after"] as string | undefined)
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? seconds : null
}
