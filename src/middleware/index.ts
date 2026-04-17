export {
  withCircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from "./circuit-breaker.ts"
export { type LogEntry, type LoggerOptions, withLogger } from "./logger.ts"
export { type DedupeOptions, type DedupeStrategy, withDedupe } from "./dedupe.ts"
export { withRateLimit, type RateLimitOptions } from "./rate-limit.ts"
export { withRetry, type RetryOptions } from "./retry.ts"
export { type SuppressionOptions, type SuppressionPolicy, withSuppression } from "./suppression.ts"
export {
  type OtelSpan,
  type OtelTracer,
  type TelemetryOptions,
  withTelemetry,
} from "./telemetry.ts"
