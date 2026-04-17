import type { EmailDriver, EmailResult, Result } from "../types.ts"
import { toEmailError } from "../errors.ts"

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
  /** Backoff strategy. `exponential` doubles; `constant` keeps `initialDelay`. */
  backoff?: "exponential" | "constant"
  /** Honor a `Retry-After` seconds value when present on 429. Default: true. */
  respectRetryAfter?: boolean
  /** Override default retryability — by default only `error.retryable === true`. */
  shouldRetry?: (error: NonNullable<Result<never>["error"]>, attempt: number) => boolean
  /** Injected for tests. Default: `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
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

  return {
    ...driver,
    name: driver.name,
    async send(msg, ctx) {
      let lastError: NonNullable<Result<EmailResult>["error"]> | null = null
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
        if (attempt === retries || !shouldRetry(result.error, attempt + 1)) return result
        await sleep(
          computeDelay({
            attempt,
            initialDelay,
            maxDelay,
            backoff,
            respectRetryAfter,
            error: result.error,
          }),
          ctx.signal,
        )
      }
      return { data: null, error: lastError! }
    },
  }
}

interface DelayInput {
  attempt: number
  initialDelay: number
  maxDelay: number
  backoff: "exponential" | "constant"
  respectRetryAfter: boolean
  error: NonNullable<Result<EmailResult>["error"]>
}

function computeDelay(input: DelayInput): number {
  if (input.respectRetryAfter && input.error.status === 429) {
    const retryAfter = extractRetryAfter(input.error.cause)
    if (retryAfter != null) return Math.min(retryAfter * 1000, input.maxDelay)
  }
  const base =
    input.backoff === "exponential" ? input.initialDelay * 2 ** input.attempt : input.initialDelay
  return Math.min(base, input.maxDelay)
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
