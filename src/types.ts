/**
 * Core types shared by every `unemail` driver, middleware, and adapter.
 *
 * The public surface is designed to stay runtime-agnostic (Node, Bun, Deno,
 * Cloudflare Workers, browser), so all types here are plain structural
 * shapes with no host dependencies.
 *
 * @module
 */

/** A value that may be returned synchronously or as a promise. */
export type MaybePromise<T> = T | Promise<T>

/** Basic contact shape — an address plus optional display name. */
export interface EmailAddress {
  email: string
  name?: string
}

/** Accepts a single string (`"Ada <ada@acme.com>"`), an `EmailAddress`, or a
 *  list of either. Drivers normalize to a flat array internally. */
export type EmailAddressInput = string | EmailAddress | ReadonlyArray<string | EmailAddress>

/** File-like payload — either encoded content or an inline `content-id`
 *  reference used by HTML `<img src="cid:...">` blocks. */
export interface Attachment {
  filename: string
  content: string | Uint8Array
  contentType?: string
  disposition?: "attachment" | "inline"
  cid?: string
}

/** Key-value tag (usually forwarded to provider analytics). */
export interface EmailTag {
  name: string
  value: string
}

/** User-supplied message before driver-specific normalization. */
export interface EmailMessage {
  /** Stream namespace — routed via `mount(stream, driver)`. Optional. */
  stream?: string

  from: EmailAddressInput
  to: EmailAddressInput
  cc?: EmailAddressInput
  bcc?: EmailAddressInput
  replyTo?: EmailAddressInput

  subject: string
  text?: string
  html?: string

  headers?: Record<string, string>
  attachments?: ReadonlyArray<Attachment>
  tags?: ReadonlyArray<EmailTag>

  /** Deduplication key — drivers pass through where supported, otherwise
   *  the core memoizes via the idempotency store. */
  idempotencyKey?: string

  /** Schedule future delivery. ISO string or `Date`. Drivers that do not
   *  support scheduling reject with `EmailErrorCode.UNSUPPORTED`. */
  scheduledAt?: string | Date

  /** Unsubscribe configuration — emits RFC 2369 `List-Unsubscribe` and,
   *  when `oneClick` is true, RFC 8058 `List-Unsubscribe-Post` headers.
   *  Required by Gmail + Yahoo bulk sender rules (Feb 2024). */
  unsubscribe?: UnsubscribeOptions

  /** Unrendered React element — resolved to `html` by the `withRender`
   *  middleware from `unemail/render/react`. Ignored by drivers. */
  react?: unknown
  /** Unrendered jsx-email element — resolved to `html` by the
   *  `withRender` middleware from `unemail/render/jsx-email`. */
  jsx?: unknown
  /** MJML source — compiled to `html` by the `withRender` middleware
   *  from `unemail/render/mjml`. */
  mjml?: string
}

/** RFC 2369 + RFC 8058 unsubscribe configuration. At least one of
 *  `url` or `mailto` must be provided. When `oneClick` defaults to
 *  `true` (when `url` is set), the core also emits
 *  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
export interface UnsubscribeOptions {
  url?: string
  mailto?: string
  oneClick?: boolean
}

/** Outcome of a successful send — at minimum the provider-assigned id. */
export interface EmailResult {
  id: string
  driver: string
  stream?: string
  at: Date
  provider?: Record<string, unknown>
}

/** Machine-readable error taxonomy. Stable across drivers. */
export type EmailErrorCode =
  | "INVALID_OPTIONS"
  | "NETWORK"
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROVIDER"
  | "UNSUPPORTED"
  | "CANCELLED"

/** Resend-style discriminated union — one of `data` or `error` is always
 *  non-null. Narrowing on `error` gives you typed success data. */
export type Result<T> = { data: T; error: null } | { data: null; error: EmailError }

/** Feature matrix advertised by each driver. Callers can gate behavior
 *  (e.g. skip attachments for drivers that do not support them). */
export interface DriverFlags {
  attachments?: boolean
  html?: boolean
  text?: boolean
  batch?: boolean
  scheduling?: boolean
  idempotency?: boolean
  tracking?: boolean
  templates?: boolean
  tagging?: boolean
  replyTo?: boolean
  customHeaders?: boolean
  inbound?: boolean
  webhooks?: boolean
}

/** Contract every driver implements. `send` is the only required method;
 *  everything else is optional and feature-gated via `flags`. */
export interface EmailDriver<TOpts = unknown, TInstance = unknown> {
  readonly name: string
  readonly flags?: DriverFlags
  readonly options?: TOpts
  getInstance?: () => TInstance
  initialize?: () => MaybePromise<void>
  dispose?: () => MaybePromise<void>
  isAvailable?: () => MaybePromise<boolean>
  send: (msg: EmailMessage, ctx: SendContext) => MaybePromise<Result<EmailResult>>
  sendBatch?: (
    msgs: ReadonlyArray<EmailMessage>,
    ctx: SendContext,
  ) => MaybePromise<Result<ReadonlyArray<EmailResult>>>
}

/** Factory that produces a driver from user options. Always returned via
 *  `defineDriver()` for type inference. */
export type DriverFactory<TOpts = unknown, TInstance = unknown> = (
  options?: TOpts,
) => EmailDriver<TOpts, TInstance>

/** Per-send context available to drivers and middleware. Extend via
 *  middleware by mutating `meta`. */
export interface SendContext {
  driver: string
  stream?: string
  attempt: number
  signal?: AbortSignal
  meta: Record<string, unknown>
}

/** Hook-based middleware. `onError` may recover and return a `Result`; the
 *  rest are observational. */
export interface Middleware {
  name?: string
  beforeSend?: (msg: EmailMessage, ctx: SendContext) => MaybePromise<void>
  afterSend?: (
    msg: EmailMessage,
    ctx: SendContext,
    result: Result<EmailResult>,
  ) => MaybePromise<void>
  onError?: (
    msg: EmailMessage,
    ctx: SendContext,
    error: EmailError,
  ) => MaybePromise<Result<EmailResult> | void>
}

/** Key-value store used for the idempotency cache. Intentionally minimal so
 *  an `unstorage` adapter or a custom KV implementation can plug in. */
export interface IdempotencyStore {
  get: (key: string) => MaybePromise<EmailResult | null>
  set: (key: string, value: EmailResult, ttlSeconds?: number) => MaybePromise<void>
}

/** Error raised by any part of the pipeline. Stable shape — drivers wrap
 *  unknown errors via `toEmailError()` in `./errors.ts`. */
export class EmailError extends Error {
  override readonly name: string = "EmailError"
  readonly driver: string
  readonly code: EmailErrorCode
  readonly status?: number
  readonly retryable: boolean
  override readonly cause?: unknown

  constructor(init: {
    driver: string
    code: EmailErrorCode
    message: string
    status?: number
    retryable?: boolean
    cause?: unknown
  }) {
    super(init.message)
    this.driver = init.driver
    this.code = init.code
    this.status = init.status
    this.retryable =
      init.retryable ??
      (init.code === "NETWORK" || init.code === "RATE_LIMIT" || init.code === "TIMEOUT")
    this.cause = init.cause
  }
}
