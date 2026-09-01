import type { EmailError } from "../core/error.ts"
import type { EmailResult, Middleware, Result, SendContext } from "../core/types.ts"
import { defineMiddleware } from "../core/define.ts"

/** How the delay grows between attempts.
 *  - `exponential` — `initialDelay * 2^attempt`
 *  - `constant` — `initialDelay` every time
 *  - `exponential-jitter` — exponential ±50%
 *  - `full-jitter` — uniform in `[0, exponential]` (AWS's recommendation)
 *  - `decorrelated-jitter` — uniform in `[initialDelay, previous * 3]` */
export type RetryBackoff =
  | "exponential"
  | "constant"
  | "exponential-jitter"
  | "full-jitter"
  | "decorrelated-jitter"

export interface RetryOptions {
  /** Attempts *after* the first. Default: 3. */
  retries?: number
  /** Milliseconds before the first retry. Default: 250. */
  initialDelay?: number
  /** Ceiling for any single delay, in milliseconds. Default: 10_000. */
  maxDelay?: number
  /** Default: `exponential-jitter` — plain exponential synchronizes every
   *  client that failed at the same moment into the same retry wave. */
  backoff?: RetryBackoff
  /** Honor a `Retry-After` header on 429. Default: true. */
  respectRetryAfter?: boolean
  /** Override which failures are retried. Default: `error.retryable`. */
  shouldRetry?: (error: EmailError, attempt: number) => boolean
  /** Injected for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injected for deterministic tests. */
  random?: () => number
}

/**
 * Re-send what failed, leave what succeeded.
 *
 * Because the pipeline's unit of work is the whole list, this retries only
 * the failed indices — including when the driver reached the provider in a
 * single batched request. A partial batch failure costs one small retry,
 * not a full re-send with duplicate deliveries.
 *
 * ```ts
 * email.use(withRetry({ retries: 5 }))
 * ```
 */
export function withRetry(options: RetryOptions = {}): Middleware {
  const retries = options.retries ?? 3
  const initialDelay = options.initialDelay ?? 250
  const maxDelay = options.maxDelay ?? 10_000
  const backoff = options.backoff ?? "exponential-jitter"
  const respectRetryAfter = options.respectRetryAfter ?? true
  const shouldRetry = options.shouldRetry ?? ((error) => error.retryable)
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random

  return defineMiddleware("retry", (next) => async (msgs, ctx) => {
    const results = [...(await next(msgs, ctx))]
    let previousDelay = initialDelay

    for (let attempt = 1; attempt <= retries; attempt++) {
      const pending = results.flatMap((result, index) =>
        result.error && shouldRetry(result.error, attempt) ? [index] : [],
      )
      if (pending.length === 0) break
      if (ctx.signal?.aborted) break

      const delay = computeDelay({
        attempt: attempt - 1,
        initialDelay,
        maxDelay,
        backoff,
        random,
        previousDelay,
        error: respectRetryAfter ? results[pending[0]!]!.error : null,
      })
      previousDelay = delay
      try {
        await sleep(delay, ctx.signal)
      } catch {
        break
      }

      const retryCtx: SendContext = { ...ctx, attempt: attempt + 1 }
      const redo = await next(
        pending.map((index) => msgs[index]!),
        retryCtx,
      )
      for (const [slot, index] of pending.entries()) {
        const replacement = redo[slot]
        if (replacement) results[index] = replacement
      }
    }

    return results as readonly Result<EmailResult>[]
  })
}

interface DelayInput {
  attempt: number
  initialDelay: number
  maxDelay: number
  backoff: RetryBackoff
  random: () => number
  previousDelay: number
  error: EmailError | null
}

function computeDelay(input: DelayInput): number {
  if (input.error?.status === 429) {
    const retryAfter = extractRetryAfter(input.error.cause)
    if (retryAfter != null) return Math.min(retryAfter * 1000, input.maxDelay)
  }
  const exponential = input.initialDelay * 2 ** input.attempt
  switch (input.backoff) {
    case "constant":
      return Math.min(input.initialDelay, input.maxDelay)
    case "exponential":
      return Math.min(exponential, input.maxDelay)
    case "exponential-jitter":
      return Math.min(Math.floor(exponential * (0.5 + input.random())), input.maxDelay)
    case "full-jitter":
      return Math.min(Math.floor(input.random() * exponential), input.maxDelay)
    case "decorrelated-jitter": {
      const high = Math.max(input.previousDelay * 3, input.initialDelay)
      const value = input.initialDelay + input.random() * (high - input.initialDelay)
      return Math.min(Math.floor(value), input.maxDelay)
    }
  }
}

/** Drivers stash the response headers on `error.cause`, so a provider's
 *  own backoff advice survives the trip out of the driver. */
function extractRetryAfter(cause: unknown): number | null {
  if (!cause || typeof cause !== "object") return null
  const record = cause as Record<string, unknown>
  const headers = record.headers as { get?: (name: string) => string | null } | undefined
  const raw = headers?.get?.("retry-after") ?? record["retry-after"]
  if (typeof raw !== "string" && typeof raw !== "number") return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal!.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
