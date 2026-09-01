import type { Middleware } from "../core/types.ts"
import { defineMiddleware } from "../core/define.ts"
import { createError } from "../core/error.ts"
import { err } from "../core/result.ts"
import { scoped } from "./_scope.ts"

export interface RateLimitOptions {
  /** Sustained sends allowed per `intervalMs`. */
  limit: number
  /** Window the limit applies to, in milliseconds. Default: 1000. */
  intervalMs?: number
  /** Extra capacity for a cold start. Default: `limit`. */
  burst?: number
  /** What to do when the bucket is empty. `wait` blocks until tokens are
   *  available; `reject` fails fast with `RATE_LIMIT`. Default: `wait`. */
  onLimit?: "wait" | "reject"
  /** Give up waiting after this long. Default: 30_000. */
  maxWaitMs?: number
  /** Injected for deterministic tests. */
  now?: () => number
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
}

/** Provider defaults, so callers do not have to go looking them up. These
 *  are the documented free-tier limits; raise them to match your plan. */
export const rateLimitPresets: Record<"resend" | "postmark" | "ses" | "smtp", RateLimitOptions> = {
  resend: { limit: 2, intervalMs: 1000 },
  postmark: { limit: 300, intervalMs: 1000 },
  ses: { limit: 14, intervalMs: 1000 },
  smtp: { limit: 10, intervalMs: 1000 },
}

interface Bucket {
  tokens: number
  lastRefill: number
  /** Serializes waiters so they drain in arrival order instead of all
   *  waking on the same refill and stampeding the provider. */
  queue: Promise<void>
}

/**
 * Token bucket in front of the driver.
 *
 * A batch takes as many tokens as it has messages, so a 500-message
 * `sendBatch` is throttled like 500 sends rather than like one.
 *
 * Each destination gets its own bucket. Rate limits belong to providers —
 * and, on a provider like Postmark, to individual streams — so one shared
 * bucket would throttle capacity you are paying for elsewhere.
 *
 * ```ts
 * email.use(withRateLimit(rateLimitPresets.resend))
 * ```
 */
export function withRateLimit(options: RateLimitOptions): Middleware {
  const intervalMs = options.intervalMs ?? 1000
  const capacity = options.burst ?? options.limit
  const refillPerMs = options.limit / intervalMs
  const onLimit = options.onLimit ?? "wait"
  const maxWaitMs = options.maxWaitMs ?? 30_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  const buckets = new Map<string, Bucket>()

  async function acquire(bucket: Bucket, cost: number): Promise<boolean> {
    const deadline = now() + maxWaitMs
    for (;;) {
      const at = now()
      bucket.tokens = Math.min(capacity, bucket.tokens + (at - bucket.lastRefill) * refillPerMs)
      bucket.lastRefill = at
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost
        return true
      }
      if (onLimit === "reject") return false
      const waitMs = Math.ceil((cost - bucket.tokens) / refillPerMs)
      if (now() + waitMs > deadline) return false
      await sleep(waitMs)
    }
  }

  return defineMiddleware("rate-limit", (next) => async (msgs, ctx) => {
    const bucket = scoped(buckets, ctx, () => ({
      tokens: capacity,
      lastRefill: now(),
      queue: Promise.resolve(),
    }))

    const cost = Math.min(msgs.length, capacity)
    const turn = bucket.queue.then(() => acquire(bucket, cost))
    bucket.queue = turn.then(
      () => undefined,
      () => undefined,
    )
    const admitted = await turn

    if (!admitted) {
      const failure = err<never>(
        createError(
          ctx.driver,
          "RATE_LIMIT",
          `local rate limit reached (${options.limit}/${intervalMs}ms)`,
          { retryable: true },
        ),
      )
      return msgs.map(() => failure)
    }

    return next(msgs, ctx)
  })
}
