/**
 * Middleware shipped with `unemail`. Every one is built with
 * `defineMiddleware` — there is nothing privileged about them, and yours
 * composes exactly the same way.
 *
 * Order matters: the first registered is the outermost.
 *
 * ```ts
 * email
 *   .use(withLogger())          // measures everything below, retries included
 *   .use(withCircuitBreaker())  // stops calling a provider that is down
 *   .use(withRetry())           // re-sends only the failures
 *   .use(withRateLimit(rateLimitPresets.resend))
 * ```
 *
 * @module
 */

export {
  type CircuitBreakerOptions,
  type CircuitState,
  withCircuitBreaker,
} from "./circuit-breaker.ts"
export {
  type IdempotencyOptions,
  type IdempotencyStore,
  type MemoryStoreOptions,
  memoryIdempotencyStore,
  withIdempotency,
} from "./idempotency.ts"
export { type LogEntry, type LoggerOptions, withLogger } from "./logger.ts"
export { rateLimitPresets, type RateLimitOptions, withRateLimit } from "./rate-limit.ts"
export { type RetryBackoff, type RetryOptions, withRetry } from "./retry.ts"
