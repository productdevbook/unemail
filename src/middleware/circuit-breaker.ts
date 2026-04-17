import type { EmailDriver } from "../types.ts"
import { createError } from "../errors.ts"

/** Circuit-breaker states:
 *   - `closed` — requests pass through
 *   - `open` — requests short-circuit with a CANCELLED error
 *   - `half-open` — a probe request is allowed; success closes, failure re-opens */
export type CircuitState = "closed" | "open" | "half-open"

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. Default: 5. */
  threshold?: number
  /** How long to stay `open` before transitioning to `half-open`. Default: 30s. */
  cooldownMs?: number
  /** Called on state transitions — useful for telemetry. */
  onStateChange?: (state: CircuitState) => void
  /** Injected for tests. */
  now?: () => number
}

/** Wrap a driver in a circuit breaker. Prevents cascading failures when a
 *  provider is down by short-circuiting after `threshold` consecutive
 *  errors. */
export function withCircuitBreaker(
  driver: EmailDriver,
  options: CircuitBreakerOptions = {},
): EmailDriver {
  const threshold = options.threshold ?? 5
  const cooldownMs = options.cooldownMs ?? 30_000
  const now = options.now ?? Date.now

  let state: CircuitState = "closed"
  let failures = 0
  let openedAt = 0

  const transition = (next: CircuitState) => {
    if (state === next) return
    state = next
    options.onStateChange?.(next)
  }

  return {
    ...driver,
    async send(msg, ctx) {
      if (state === "open") {
        if (now() - openedAt >= cooldownMs) transition("half-open")
        else {
          return {
            data: null,
            error: createError(driver.name, "CANCELLED", "circuit breaker open", {
              retryable: false,
            }),
          }
        }
      }

      const result = await driver.send(msg, ctx)
      if (result.error) {
        failures++
        if (state === "half-open" || failures >= threshold) {
          openedAt = now()
          transition("open")
        }
      } else {
        failures = 0
        transition("closed")
      }
      return result
    },
  }
}
