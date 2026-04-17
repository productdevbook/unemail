/**
 * Public entry point for `unemail` — a driver-based, cross-runtime
 * TypeScript email library inspired by `unjs/unstorage`.
 *
 * Transports (SMTP, Resend, SES, Postmark, …) live under
 * `unemail/drivers/<name>`. Rendering and inbound adapters live under
 * their own sub-paths (shipped incrementally).
 *
 * @module
 */
export { createEmail, type CreateEmailOptions, type Email } from "./email.ts"
export { defineDriver } from "./_define.ts"
export { memoryIdempotencyStore } from "./_idempotency.ts"
export { formatAddress, isValidEmail, normalizeAddresses, parseAddress } from "./_normalize.ts"
export { createError, createRequiredError, EmailError, toEmailError } from "./errors.ts"
export {
  type CircuitBreakerOptions,
  type CircuitState,
  type LogEntry,
  type LoggerOptions,
  type OtelSpan,
  type OtelTracer,
  type RateLimitOptions,
  type RetryOptions,
  type TelemetryOptions,
  withCircuitBreaker,
  withLogger,
  withRateLimit,
  withRetry,
  withTelemetry,
} from "./middleware/index.ts"
export {
  defineTemplate,
  htmlToText,
  type Renderer,
  type TemplateFn,
  withRender,
  type WithRenderOptions,
} from "./render/index.ts"
export type {
  Attachment,
  DriverFactory,
  DriverFlags,
  EmailAddress,
  EmailAddressInput,
  EmailDriver,
  EmailErrorCode,
  EmailMessage,
  EmailResult,
  EmailTag,
  IdempotencyStore,
  MaybePromise,
  Middleware,
  Result,
  SendContext,
} from "./types.ts"

/** Library version string — bumped automatically on release. */
export const version = "1.0.0-alpha.0"
