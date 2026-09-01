/**
 * Every type in the public surface. Runtime-free by construction — this
 * module compiles to nothing, so importing it costs no bytes in a Worker
 * bundle.
 *
 * @module
 */

import type { EmailError } from "./error.ts"

/** A value that may be returned synchronously or as a promise. */
export type MaybePromise<T> = T | Promise<T>

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** A contact: an address plus an optional display name. */
export interface EmailAddress {
  readonly email: string
  readonly name?: string
}

/** Anything accepted where an address is expected — `"ada@acme.com"`,
 *  `"Ada <ada@acme.com>"`, `{ email, name }`, or a list of those. */
export type AddressInput = string | EmailAddress | readonly (string | EmailAddress)[]

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/** A file part. `content` is either raw bytes or a base64 string; set
 *  `cid` to reference it from HTML as `<img src="cid:...">`. */
export interface Attachment {
  readonly filename: string
  readonly content: string | Uint8Array
  readonly contentType?: string
  readonly disposition?: "attachment" | "inline"
  readonly cid?: string
}

/** Key-value pair forwarded to provider analytics. */
export interface EmailTag {
  readonly name: string
  readonly value: string
}

/** RFC 2369 + RFC 8058 unsubscribe configuration. Gmail and Yahoo require
 *  a one-click unsubscribe on bulk mail; setting `url` turns it on. */
export interface UnsubscribeOptions {
  readonly url?: string
  readonly mailto?: string
  /** Emit `List-Unsubscribe-Post`. Defaults to `true` when `url` is set. */
  readonly oneClick?: boolean
}

/** A provider-hosted template. Use `id` where the provider addresses
 *  templates numerically, `alias` where it addresses them by name. */
export interface TemplateOptions {
  readonly id?: string
  readonly alias?: string
  readonly variables?: Readonly<Record<string, unknown>>
}

/** Per-message open/click tracking. Unset fields defer to the provider's
 *  account-level setting. */
export interface TrackingOptions {
  readonly opens?: boolean
  readonly clicks?: boolean
}

/** Unrendered body handed to a `Renderer`. The core never inspects
 *  anything but `type`, which is how a renderer claims a message —
 *  so a new template language is a package, not a core change. */
export interface MessageContent {
  readonly type: string
  readonly [key: string]: unknown
}

/** What you pass to `email.send()`. Every address field is loose; the core
 *  normalizes and validates before a driver sees it. */
export interface EmailMessage {
  /** Route to a driver registered with `mount(stream, driver)`. */
  readonly stream?: string

  readonly from?: AddressInput
  readonly to: AddressInput
  readonly cc?: AddressInput
  readonly bcc?: AddressInput
  readonly replyTo?: AddressInput

  readonly subject: string
  /** Preview line most clients show next to the subject. */
  readonly preheader?: string
  readonly text?: string
  readonly html?: string
  /** Unrendered body — a `Renderer` turns this into `html`. */
  readonly content?: MessageContent

  readonly headers?: Readonly<Record<string, string>>
  readonly attachments?: readonly Attachment[]
  readonly tags?: readonly EmailTag[]
  /** Provider-agnostic metadata, echoed back on webhook events. */
  readonly metadata?: Readonly<Record<string, string>>

  readonly idempotencyKey?: string
  readonly scheduledAt?: string | Date
  readonly unsubscribe?: UnsubscribeOptions
  readonly template?: TemplateOptions
  readonly tracking?: TrackingOptions
  /** Route to the provider's sandbox instead of real delivery. */
  readonly sandbox?: boolean
  /** A pre-composed RFC 5322 message. Bypasses the MIME builder; SMTP only. */
  readonly raw?: string | Uint8Array
}

/** What a driver receives: validated, address-parsed, header-folded. Lists
 *  are always present (empty rather than `undefined`) so drivers never
 *  branch on nullish, and `from` is guaranteed. */
export interface NormalizedMessage {
  readonly stream?: string

  readonly from: EmailAddress
  readonly to: readonly EmailAddress[]
  readonly cc: readonly EmailAddress[]
  readonly bcc: readonly EmailAddress[]
  readonly replyTo: readonly EmailAddress[]

  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly content?: MessageContent

  /** Header names are as-cased by the caller; `hasHeader()` compares
   *  case-insensitively. Already includes derived `List-Unsubscribe`. */
  readonly headers: Readonly<Record<string, string>>
  readonly attachments: readonly Attachment[]
  readonly tags: readonly EmailTag[]
  readonly metadata: Readonly<Record<string, string>>

  readonly idempotencyKey?: string
  readonly scheduledAt?: Date
  readonly template?: TemplateOptions
  readonly tracking?: TrackingOptions
  readonly sandbox?: boolean
  readonly raw?: string | Uint8Array
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A delivery accepted by the provider. */
export interface EmailResult {
  readonly id: string
  readonly driver: string
  readonly stream?: string
  readonly at: Date
  /** The provider's own response, untouched. */
  readonly provider?: Readonly<Record<string, unknown>>
}

/** Discriminated union — narrowing on `error` yields typed `data`. */
export type Result<T> = { data: T; error: null } | { data: null; error: EmailError }

/** Outcome of `sendBatch()`. `results` is positional: `results[i]` is the
 *  outcome of `messages[i]`, always, even when some failed. */
export interface BatchResult {
  readonly results: readonly Result<EmailResult>[]
  readonly sent: readonly EmailResult[]
  readonly failed: readonly { readonly index: number; readonly error: EmailError }[]
  /** True when every message was accepted. */
  readonly ok: boolean
}

/** Lifecycle state of a message, as far as the provider will tell us. */
export type SendState =
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
  readonly id: string
  readonly driver: string
  readonly state: SendState
  readonly at?: Date
  readonly provider?: Readonly<Record<string, unknown>>
}

/** Machine-readable failure taxonomy. Stable across every driver. */
export type EmailErrorCode =
  | "INVALID_OPTIONS"
  | "NETWORK"
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROVIDER"
  | "UNSUPPORTED"
  | "CANCELLED"

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** Capabilities a driver advertises. Callers gate on these instead of
 *  string-matching `driver.name`. */
export interface DriverFeatures {
  readonly attachments?: boolean
  readonly html?: boolean
  readonly text?: boolean
  /** `sendBatch` reaches the provider in one request. */
  readonly batch?: boolean
  readonly scheduling?: boolean
  /** The provider itself deduplicates on `idempotencyKey`. */
  readonly idempotency?: boolean
  readonly tracking?: boolean
  readonly templates?: boolean
  readonly tagging?: boolean
  readonly replyTo?: boolean
  readonly customHeaders?: boolean
  readonly sandbox?: boolean
  readonly cancelable?: boolean
  readonly retrievable?: boolean
}

/** Everything a driver is asked to do. Only `name` and `send` are
 *  required; the rest is feature-gated and routed to `UNSUPPORTED`. */
export interface EmailDriver<TInstance = unknown> {
  readonly name: string
  readonly features?: DriverFeatures
  /** The underlying client (a pool, an inbox array, an SDK handle). */
  readonly getInstance?: () => TInstance
  readonly initialize?: () => MaybePromise<void>
  readonly dispose?: () => MaybePromise<void>
  readonly isAvailable?: () => MaybePromise<boolean>

  readonly send: (msg: NormalizedMessage, ctx: SendContext) => MaybePromise<Result<EmailResult>>
  /** One request for many messages. Must return one result per input, in
   *  order — the core checks this and fails loudly if it does not. */
  readonly sendBatch?: (
    msgs: readonly NormalizedMessage[],
    ctx: SendContext,
  ) => MaybePromise<readonly Result<EmailResult>[]>
  readonly cancel?: (id: string) => MaybePromise<Result<void>>
  readonly retrieve?: (id: string) => MaybePromise<Result<SendStatus>>
}

/** A driver that is guaranteed to expose its underlying client, so callers
 *  reach it without an optional-call guard. */
export type DriverWithInstance<TInstance> = EmailDriver<TInstance> & {
  readonly getInstance: () => TInstance
}

/** The driver shape implied by an instance type. Naming one obliges the
 *  driver to expose it and lets callers reach it unguarded; leaving it
 *  `unknown` keeps `getInstance` optional. */
export type DriverOf<TInstance> = unknown extends TInstance
  ? EmailDriver<TInstance>
  : DriverWithInstance<TInstance>

/** What `defineDriver` returns. Options are required when `TOpts` has a
 *  required field — `resend()` with no key is a type error, not a
 *  runtime surprise. */
export type DriverFactory<TOpts, TInstance = unknown> = (options: TOpts) => DriverOf<TInstance>

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Ambient state for one trip through the pipeline. `meta` is a shared
 *  mutable bag for middleware to leave notes in; everything else is
 *  replaced, not mutated, when a middleware derives a new context. */
export interface SendContext {
  readonly driver: string
  readonly stream?: string
  /** 1 on the first try. Retry middleware derives a context per attempt. */
  readonly attempt: number
  readonly signal?: AbortSignal
  readonly meta: Record<string, unknown>
}

/** The one unit of work in this library. Always a list, always one result
 *  per input, in order — `send()` is the single-element case. Making the
 *  list the primitive is what lets retry re-send only the failures even
 *  when the driver batches natively. */
export type SendHandler = (
  msgs: readonly NormalizedMessage[],
  ctx: SendContext,
) => Promise<readonly Result<EmailResult>[]>

/** The one composition primitive. Wrap the next handler, do work around
 *  it, return the results. Register with `email.use()` to cover a whole
 *  instance, or `wrap(driver, ...)` to cover one driver. */
export interface Middleware {
  readonly name: string
  readonly handle: (next: SendHandler) => SendHandler
}
