import type {
  Attachment,
  DriverFactory,
  DriverFeatures,
  EmailResult,
  NormalizedMessage,
} from "../core/types.ts"
import type { Classification } from "./_fetch.ts"
import { defineDriver } from "../core/define.ts"
import { createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64, stringToBase64 } from "./_base64.ts"
import { httpJson, resolveFetch } from "./_fetch.ts"

/** Credentials, so the common three shapes do not have to be spelled out
 *  as a header by hand. */
export type HttpAuth =
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "basic"; readonly username: string; readonly password: string }
  | { readonly type: "header"; readonly name: string; readonly value: string }

export interface HttpDriverOptions {
  /** Where to send. */
  endpoint: string
  /** Default: `POST`. */
  method?: string
  auth?: HttpAuth
  /** Sent on every request. A function is called per message, for a header
   *  derived from it — an idempotency key, a tenant id. */
  headers?: Readonly<Record<string, string>> | ((msg: NormalizedMessage) => Record<string, string>)
  /** The request payload. Default: the normalized message, JSON-safe (see
   *  `defaultBody`). Return a string to send it verbatim — set a
   *  `content-type` in `headers` when it is not JSON. */
  body?: (msg: NormalizedMessage) => unknown
  /** Pull the provider's own id out of the response. Default: the first
   *  string among `id`, `messageId`, `message_id`, `MessageID`, the same
   *  keys under `data`, or a body that is itself a string. */
  extractId?: (body: unknown, msg: NormalizedMessage) => string | null | undefined
  /** Map a failure response onto the shared taxonomy, so `error.code` and
   *  `error.retryable` mean the same here as anywhere else. Returning
   *  `null` falls back to the status-code default. */
  classify?: (status: number, body: unknown) => Classification | null
  /** What the endpoint can do. Left unset the core refuses nothing and
   *  every message reaches `body` — see the note on the driver. */
  features?: DriverFeatures
  /** Name reported on results and errors. Default: `http`. */
  name?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

const DRIVER = "http"

/**
 * Any JSON endpoint: an internal mail gateway, a self-hosted relay, a
 * webhook that fans out to something else.
 *
 * The caller owns the request; the driver owns the plumbing. That is the
 * trade — supply `body`, `extractId` and `classify` and the send inherits
 * retry, rate limiting and the circuit breaker, because `error.retryable`
 * and `error.code` come out of the same taxonomy every other driver uses.
 *
 * ```ts
 * http({
 *   endpoint: "https://mail.internal/v1/send",
 *   auth: { type: "bearer", token: process.env.GATEWAY_TOKEN! },
 *   body: (msg) => ({ rcpt: msg.to.map((a) => a.email), subj: msg.subject, body: msg.html }),
 *   extractId: (res) => (res as { ref: string }).ref,
 *   classify: (status) => (status === 409 ? { code: "RATE_LIMIT", retryable: true } : null),
 * })
 * ```
 *
 * `features` is unset by default on purpose: this driver cannot know what
 * an arbitrary endpoint supports, and guessing would either refuse
 * messages the gateway handles fine or let through ones it silently drops.
 * Declare it when you do know, and the core will refuse early.
 */
const http: DriverFactory<HttpDriverOptions> = defineDriver<HttpDriverOptions>((options) => {
  if (!options?.endpoint) throw createRequiredError(DRIVER, "endpoint")
  const name = options.name ?? DRIVER
  const fetchImpl = resolveFetch(name, options.fetch)
  const buildBody = options.body ?? defaultBody
  const extractId: NonNullable<HttpDriverOptions["extractId"]> =
    options.extractId ?? defaultExtractId
  const authHeader = toAuthHeader(options.auth)

  function headersFor(msg: NormalizedMessage): Record<string, string> {
    const supplied = typeof options.headers === "function" ? options.headers(msg) : options.headers
    return { ...authHeader, ...supplied }
  }

  return {
    name,
    ...(options.features ? { features: options.features } : {}),

    // No `sendBatch`: an unknown endpoint gives no way to tell which of N
    // messages an answer refers to, and a wrong mapping is worse than N
    // requests. The core sends them one at a time, so every message keeps
    // its own result.
    async send(msg, ctx) {
      const response = await httpJson({
        fetch: fetchImpl,
        driver: name,
        url: options.endpoint,
        method: options.method ?? "POST",
        headers: headersFor(msg),
        body: buildBody(msg),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.classify ? { classify: options.classify } : {}),
      })
      if (response.error) return err(response.error)

      const provider = toProviderRecord(response.data)
      const result: EmailResult = {
        id: extractId(response.data, msg) ?? localId(name),
        driver: name,
        ...(msg.stream ? { stream: msg.stream } : {}),
        at: new Date(),
        ...(provider ? { provider } : {}),
      }
      return ok<EmailResult>(result)
    },
  }
})

export default http

/**
 * The normalized message as JSON: the array and object fields are always
 * present, the optional ones only when set. Attachment content is base64
 * and says so; `scheduledAt` is an ISO string.
 *
 * `raw` is deliberately absent — a pre-composed MIME document has no
 * obvious place in a JSON envelope. An endpoint that takes one needs its
 * own `body`.
 */
export function defaultBody(msg: NormalizedMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    replyTo: msg.replyTo,
    subject: msg.subject,
    headers: msg.headers,
    metadata: msg.metadata,
    tags: msg.tags,
    attachments: msg.attachments.map(toAttachmentPayload),
  }
  if (msg.stream != null) payload.stream = msg.stream
  if (msg.text != null) payload.text = msg.text
  if (msg.html != null) payload.html = msg.html
  if (msg.content != null) payload.content = msg.content
  if (msg.idempotencyKey != null) payload.idempotencyKey = msg.idempotencyKey
  if (msg.scheduledAt) payload.scheduledAt = msg.scheduledAt.toISOString()
  if (msg.template != null) payload.template = msg.template
  if (msg.tracking != null) payload.tracking = msg.tracking
  if (msg.sandbox != null) payload.sandbox = msg.sandbox
  return payload
}

function toAttachmentPayload(attachment: Attachment): Record<string, unknown> {
  return {
    filename: attachment.filename,
    content: attachmentToBase64(attachment),
    encoding: "base64",
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
    ...(attachment.cid ? { cid: attachment.cid } : {}),
  }
}

const ID_KEYS = ["id", "messageId", "message_id", "MessageID"] as const

function defaultExtractId(body: unknown): string | null {
  if (typeof body === "string") return body.trim() || null
  const found = pickId(body)
  if (found) return found
  const record = asRecord(body)
  return record ? pickId(record.data) : null
}

function pickId(body: unknown): string | null {
  const record = asRecord(body)
  if (!record) return null
  for (const key of ID_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value) return value
    if (typeof value === "number") return String(value)
  }
  return null
}

/** A gateway that answers `202` with an empty body has still accepted the
 *  message, so failing the send would be wrong. The id is local in that
 *  case, and `extractId` is how the provider's own id gets here instead. */
function localId(driver: string): string {
  return `${driver}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** Keep the provider's answer on the result. A body that is not a plain
 *  object is nested rather than dropped, so nothing is lost. */
function toProviderRecord(body: unknown): Record<string, unknown> | null {
  if (body == null) return null
  const record = asRecord(body)
  return record ?? { response: body }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toAuthHeader(auth: HttpAuth | undefined): Record<string, string> {
  if (!auth) return {}
  switch (auth.type) {
    case "bearer":
      return { authorization: `Bearer ${auth.token}` }
    case "basic":
      return { authorization: `Basic ${stringToBase64(`${auth.username}:${auth.password}`)}` }
    case "header":
      return { [auth.name]: auth.value }
  }
}
