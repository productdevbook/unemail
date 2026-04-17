import type { EmailDriver, EmailResult, Result } from "../types.ts"
import { toEmailError } from "../errors.ts"

/** Backoff strategies.
 *  - `exponential` — `initialDelay * 2^attempt` (default).
 *  - `constant` — `initialDelay` every time.
 *  - `exponential-jitter` — exponential with ±50% uniform noise.
 *  - `full-jitter` — random in `[0, exponential]` (AWS recommendation).
 *  - `decorrelated-jitter` — `random(initialDelay, prev * 3)`. */
export type RetryBackoff =
  | "exponential"
  | "constant"
  | "exponential-jitter"
  | "full-jitter"
  | "decorrelated-jitter"

/** Options for `withRetry`. All numeric values are milliseconds unless
 *  noted. `respectRetryAfter` honors `error.status === 429` with the
 *  matching `Retry-After` surfaced via `error.cause`. */
export interface RetryOptions {
  /** Number of *retry* attempts on top of the initial send. Default: 3. */
  retries?: number
  /** Initial backoff delay. Default: 250ms. */
  initialDelay?: number
  /** Maximum backoff delay between attempts. Default: 10_000ms. */
  maxDelay?: number
  /** Backoff strategy. See `RetryBackoff`. */
  backoff?: RetryBackoff
  /** Honor a `Retry-After` seconds value when present on 429. Default: true. */
  respectRetryAfter?: boolean
  /** Override default retryability — by default only `error.retryable === true`. */
  shouldRetry?: (error: NonNullable<Result<never>["error"]>, attempt: number) => boolean
  /** Route exhausted sends to this driver (dead-letter). Original error
   *  is preserved on `ctx.meta.deadLetterReason`. */
  deadLetter?: EmailDriver
  /** Injected for tests. Default: `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injected for deterministic jitter in tests. Default: `Math.random`. */
  random?: () => number
}

/** Wrap a driver so every send is retried on transient failures. Returns a
 *  regular `EmailDriver` — compose it with `fallback`, `roundRobin`, etc.
 *
 *  ```ts
 *  const driver = withRetry(resend({ apiKey }), { retries: 3 })
 *  ```
 */
export function withRetry(driver: EmailDriver, options: RetryOptions = {}): EmailDriver {
  const retries = options.retries ?? 3
  const initialDelay = options.initialDelay ?? 250
  const maxDelay = options.maxDelay ?? 10_000
  const backoff = options.backoff ?? "exponential"
  const respectRetryAfter = options.respectRetryAfter ?? true
  const sleep = options.sleep ?? defaultSleep
  const shouldRetry = options.shouldRetry ?? ((err) => err.retryable)
  const random = options.random ?? Math.random
  const deadLetter = options.deadLetter

  return {
    ...driver,
    name: driver.name,
    async send(msg, ctx) {
      let lastError: NonNullable<Result<EmailResult>["error"]> | null = null
      let lastDelay = initialDelay
      for (let attempt = 0; attempt <= retries; attempt++) {
        ctx.attempt = attempt + 1
        if (ctx.signal?.aborted) {
          return {
            data: null,
            error: toEmailError(driver.name, ctx.signal.reason ?? new Error("aborted")),
          }
        }
        let result: Result<EmailResult>
        try {
          result = await driver.send(msg, ctx)
        } catch (thrown) {
          result = { data: null, error: toEmailError(driver.name, thrown) }
        }
        if (result.data) return result
        lastError = result.error
        if (attempt === retries || !shouldRetry(result.error, attempt + 1)) {
          return deadLetter ? routeToDeadLetter(deadLetter, msg, ctx, result.error) : result
        }
        const delay = computeDelay({
          attempt,
          initialDelay,
          maxDelay,
          backoff,
          respectRetryAfter,
          error: result.error,
          random,
          previousDelay: lastDelay,
        })
        lastDelay = delay
        await sleep(delay, ctx.signal)
      }
      return deadLetter && lastError
        ? routeToDeadLetter(deadLetter, msg, ctx, lastError)
        : { data: null, error: lastError! }
    },
  }
}

async function routeToDeadLetter(
  dlq: EmailDriver,
  msg: Parameters<EmailDriver["send"]>[0],
  ctx: Parameters<EmailDriver["send"]>[1],
  error: NonNullable<Result<EmailResult>["error"]>,
): Promise<Result<EmailResult>> {
  ctx.meta.deadLetterReason = error.message
  ctx.meta.deadLetterCode = error.code
  return dlq.send(msg, ctx)
}

interface DelayInput {
  attempt: number
  initialDelay: number
  maxDelay: number
  backoff: RetryBackoff
  respectRetryAfter: boolean
  error: NonNullable<Result<EmailResult>["error"]>
  random: () => number
  previousDelay: number
}

function computeDelay(input: DelayInput): number {
  if (input.respectRetryAfter && input.error.status === 429) {
    const retryAfter = extractRetryAfter(input.error.cause)
    if (retryAfter != null) return Math.min(retryAfter * 1000, input.maxDelay)
  }
  const exp = input.initialDelay * 2 ** input.attempt
  switch (input.backoff) {
    case "constant":
      return Math.min(input.initialDelay, input.maxDelay)
    case "exponential":
      return Math.min(exp, input.maxDelay)
    case "exponential-jitter": {
      const jitter = 0.5 + input.random()
      return Math.min(Math.floor(exp * jitter), input.maxDelay)
    }
    case "full-jitter":
      return Math.min(Math.floor(input.random() * exp), input.maxDelay)
    case "decorrelated-jitter": {
      const high = Math.max(input.previousDelay * 3, input.initialDelay)
      const value = input.initialDelay + input.random() * (high - input.initialDelay)
      return Math.min(Math.floor(value), input.maxDelay)
    }
  }
}

function extractRetryAfter(cause: unknown): number | null {
  if (!cause || typeof cause !== "object") return null
  const record = cause as Record<string, unknown>
  const headers = record.headers as { get?: (name: string) => string | null } | undefined
  const raw = headers?.get?.("retry-after") ?? (record["retry-after"] as string | undefined)
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? seconds : null
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal!.reason ?? new Error("aborted"))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(signal.reason ?? new Error("aborted"))
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
