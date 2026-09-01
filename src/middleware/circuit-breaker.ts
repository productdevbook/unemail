import type { EmailError } from "../core/error.ts"
import type { Middleware } from "../core/types.ts"
import { defineMiddleware } from "../core/define.ts"
import { createError } from "../core/error.ts"
import { err } from "../core/result.ts"

/** `closed` passes traffic, `open` rejects it, `half-open` lets a single
 *  probe through to see whether the provider recovered. */
export type CircuitState = "closed" | "open" | "half-open"

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the circuit. Default: 5. */
  threshold?: number
  /** How long to stay open before probing, in milliseconds. Default: 30_000. */
  resetTimeoutMs?: number
  /** Which failures count. Default: everything except `INVALID_OPTIONS`
   *  and `UNSUPPORTED` — a malformed message says nothing about the
   *  provider's health. */
  isFailure?: (error: EmailError) => boolean
  /** Called on every state change. */
  onStateChange?: (state: CircuitState, driver: string) => void
  /** Injected for deterministic tests. */
  now?: () => number
}

/**
 * Stop hammering a provider that is down.
 *
 * ```ts
 * email.use(withCircuitBreaker({ threshold: 5 }))
 * ```
 */
export function withCircuitBreaker(options: CircuitBreakerOptions = {}): Middleware {
  const threshold = options.threshold ?? 5
  const resetTimeoutMs = options.resetTimeoutMs ?? 30_000
  const isFailure = options.isFailure ?? defaultIsFailure
  const now = options.now ?? Date.now

  let state: CircuitState = "closed"
  let failures = 0
  let openedAt = 0

  function transition(to: CircuitState, driver: string) {
    if (state === to) return
    state = to
    options.onStateChange?.(to, driver)
  }

  return defineMiddleware("circuit-breaker", (next) => async (msgs, ctx) => {
    if (state === "open") {
      if (now() - openedAt < resetTimeoutMs) {
        const failure = err<never>(
          createError(ctx.driver, "NETWORK", "circuit is open — provider is failing", {
            retryable: true,
          }),
        )
        return msgs.map(() => failure)
      }
      transition("half-open", ctx.driver)
    }

    const results = await next(msgs, ctx)
    const counted = results.filter((result) => result.error && isFailure(result.error))

    if (counted.length === 0) {
      failures = 0
      transition("closed", ctx.driver)
      return results
    }

    // A half-open probe that fails at all goes straight back to open;
    // waiting for the full threshold again would replay the outage.
    failures = state === "half-open" ? threshold : failures + counted.length
    if (failures >= threshold) {
      openedAt = now()
      transition("open", ctx.driver)
    }
    return results
  })
}

function defaultIsFailure(error: EmailError): boolean {
  return error.code !== "INVALID_OPTIONS" && error.code !== "UNSUPPORTED"
}
