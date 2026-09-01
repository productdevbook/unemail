import type { EmailError } from "../core/error.ts"
import type { Middleware } from "../core/types.ts"
import { defineMiddleware } from "../core/define.ts"
import { createError } from "../core/error.ts"
import { err } from "../core/result.ts"
import { scoped } from "./_scope.ts"

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
  /** Called on every state change, with the destination that changed. */
  onStateChange?: (state: CircuitState, driver: string) => void
  /** Injected for deterministic tests. */
  now?: () => number
}

interface Circuit {
  state: CircuitState
  failures: number
  openedAt: number
}

/**
 * Stop hammering a provider that is down.
 *
 * State is kept per destination, so a failing Resend opens Resend's circuit
 * and leaves a mounted SES free to send. A single shared circuit would
 * widen the outage instead of containing it.
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

  const circuits = new Map<string, Circuit>()

  return defineMiddleware("circuit-breaker", (next) => async (msgs, ctx) => {
    const circuit = scoped(circuits, ctx, () => ({
      state: "closed" as CircuitState,
      failures: 0,
      openedAt: 0,
    }))

    function transition(to: CircuitState) {
      if (circuit.state === to) return
      circuit.state = to
      options.onStateChange?.(to, ctx.driver)
    }

    if (circuit.state === "open") {
      if (now() - circuit.openedAt < resetTimeoutMs) {
        const failure = err<never>(
          createError(ctx.driver, "NETWORK", "circuit is open — provider is failing", {
            retryable: true,
          }),
        )
        return msgs.map(() => failure)
      }
      transition("half-open")
    }

    const results = await next(msgs, ctx)
    const counted = results.filter((result) => result.error && isFailure(result.error))

    if (counted.length === 0) {
      circuit.failures = 0
      transition("closed")
      return results
    }

    // A half-open probe that fails at all goes straight back to open;
    // waiting for the full threshold again would replay the outage.
    circuit.failures = circuit.state === "half-open" ? threshold : circuit.failures + counted.length
    if (circuit.failures >= threshold) {
      circuit.openedAt = now()
      transition("open")
    }
    return results
  })
}

function defaultIsFailure(error: EmailError): boolean {
  return error.code !== "INVALID_OPTIONS" && error.code !== "UNSUPPORTED"
}
