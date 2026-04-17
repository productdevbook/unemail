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
  /** Short preview text shown by most mail clients alongside the
   *  subject. Injected into the rendered HTML by the render
   *  pipeline's `withPreheader()` transform. */
  preheader?: string
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

  /** Provider-side template. `id` is the provider's template id (or alias
   *  for Postmark). `variables` are passed to the template engine under
   *  provider-specific names (`dynamic_template_data`, `TemplateModel`,
   *  `params`, `dataVariables`, …). Drivers without templating raise
   *  `UNSUPPORTED`. */
  template?: TemplateOptions

  /** Per-message tracking overrides. Drivers that don't expose granular
   *  tracking fall back to their global setting. */
  tracking?: TrackingOptions

  /** Run this send in sandbox / test mode. Mapped per-driver:
   *  - Mailgun `o:testmode`, SendGrid `mail_settings.sandbox_mode`,
   *    SES configuration sets, Postmark test-stream.
   *  Drivers without sandbox support raise `UNSUPPORTED`. */
  sandbox?: boolean

  /** Provider-agnostic metadata echoed back in webhook events. SendGrid
   *  maps to `custom_args`, Postmark to `Metadata`, Mailgun to
   *  `v:key=value`, Resend to `headers["X-Metadata-*"]`. */
  metadata?: Record<string, string>

  /** SendGrid-style per-recipient personalizations. When set, drivers
   *  that support it (SendGrid, Mailgun recipient-variables) dispatch
   *  a single batched request; others loop. */
  personalizations?: ReadonlyArray<Personalization>

  /** AMP4Email alternative part. Providers without AMP support ignore. */
  amp?: string

  /** RFC 3461 Delivery Status Notification requests. SMTP-only. */
  dsn?: DsnOptions

  /** Pre-built raw RFC 5322 message body. Bypasses the MIME builder
   *  entirely — useful for replay, forwarding, or when you've composed
   *  the message yourself. SMTP-only. */
  raw?: string | Uint8Array

  /** Unrendered React element — resolved to `html` by the `withRender`
   *  middleware from `unemail/render/react`. Ignored by drivers. */
  react?: unknown
  /** Unrendered jsx-email element — resolved to `html` by the
   *  `withRender` middleware from `unemail/render/jsx-email`. */
  jsx?: unknown
  /** MJML source — compiled to `html` by the `withRender` middleware
   *  from `unemail/render/mjml`. */
  mjml?: string
  /** Handlebars template source — rendered by
   *  `unemail/render/handlebars` using `handlebarsVars` as the
   *  context. */
  handlebars?: string
  handlebarsVars?: Record<string, unknown>
  /** Liquid template source — rendered by `unemail/render/liquid`
   *  using `liquidVars` as the context. */
  liquid?: string
  liquidVars?: Record<string, unknown>
  /** Locale hint consumed by `unemail/render/i18n` to dispatch to the
   *  right sub-renderer. */
  locale?: string
}

/** Per-recipient personalization (SendGrid-native). Loops fall back
 *  to copies of the message for providers without native support. */
export interface Personalization {
  to: EmailAddressInput
  cc?: EmailAddressInput
  bcc?: EmailAddressInput
  subject?: string
  variables?: Record<string, unknown>
  sendAt?: Date | string
  customArgs?: Record<string, string>
}

/** RFC 3461 DSN (Delivery Status Notification) request. SMTP only. */
export interface DsnOptions {
  notify?: ReadonlyArray<"SUCCESS" | "FAILURE" | "DELAY" | "NEVER">
  ret?: "FULL" | "HDRS"
  envid?: string
  orcpt?: string
}

/** Provider-side template settings. `id` is required when the provider
 *  addresses templates by id; `alias` is used when they address by
 *  name (Postmark). `variables` is a plain object — drivers stringify
 *  or serialize as their API demands. */
export interface TemplateOptions {
  id?: string
  alias?: string
  variables?: Record<string, unknown>
  /** Override locale for multi-locale template systems. */
  locale?: string
}

/** Per-message tracking overrides. Unset fields defer to driver defaults. */
export interface TrackingOptions {
  opens?: boolean
  clicks?: boolean
  unsubscribes?: boolean
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
  cancelable?: boolean
  retrievable?: boolean
  personalizations?: boolean
}

/** Status returned by `driver.retrieve(id)`. Mirrors the provider state
 *  where possible; `unknown` covers providers that don't expose it. */
export type SendStatusState =
  | "scheduled"
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "cancelled"
  | "failed"
  | "unknown"

export interface SendStatus {
  id: string
  driver: string
  state: SendStatusState
  /** Last-observed event timestamp if provided. */
  at?: Date
  /** Raw provider-specific payload. */
  provider?: Record<string, unknown>
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
  /** Cancel a scheduled send. Optional — drivers without support are
   *  gated by `flags.cancelable`. */
  cancel?: (id: string) => MaybePromise<Result<void>>
  /** Retrieve the current state of a previously-sent message. Optional
   *  — drivers without support are gated by `flags.retrievable`. */
  retrieve?: (id: string) => MaybePromise<Result<SendStatus>>
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
