import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailResult,
  NormalizedMessage,
  SendState,
  SendStatus,
} from "../core/types.ts"
import type { Classification } from "./_fetch.ts"
import { formatAddressList } from "../core/address.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { httpJson, resolveFetch } from "./_fetch.ts"

export interface AhaSendOptions {
  /** API key from the dashboard. Starts with `aha-sk-`. */
  apiKey: string
  /** Account UUID. Every v2 route is scoped to one:
   *  `/v2/accounts/{accountId}/…`. */
  accountId: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Route to the sandbox when the message does not say. Default: false. */
  sandbox?: boolean
  /** What the sandbox should pretend happened. Only read for a sandbox
   *  send; AhaSend's default is `deliver`. */
  sandboxResult?: "deliver" | "bounce" | "defer" | "fail" | "suppress"
}

const DRIVER = "ahasend"
const DEFAULT_ENDPOINT = "https://api.ahasend.com"
/** `/messages/conversation` caps the combined To, Cc and Bcc at 50. */
const CONVERSATION_RECIPIENT_LIMIT = 50
/** Set on `result.meta` when AhaSend replayed a stored response instead of
 *  sending again. */
const REPLAYED_META_KEY = "idempotentReplayed"

interface AhaSendAddress {
  email: string
  name?: string
}

/** One entry of the `data` array a send answers with — AhaSend reports per
 *  recipient, even when the request was one message. */
interface AhaSendEntry {
  object?: string
  /** The generated `Message-ID`, e.g. `<uuid@example.com>`. Null when this
   *  recipient was not accepted. */
  id?: string | null
  recipient?: AhaSendAddress
  status?: "queued" | "scheduled" | "error"
  error?: string | null
}

interface AhaSendSendResponse {
  object?: string
  data?: AhaSendEntry[]
}

interface AhaSendMessage {
  id?: string | null
  message_id?: string
  status?: string
  created_at?: string
  sent_at?: string | null
  delivered_at?: string | null
}

/**
 * AhaSend, over its v2 REST API.
 *
 * The reason to reach for this one is idempotency: AhaSend takes an
 * `Idempotency-Key` on the send endpoints and replays the stored response
 * for 24 hours, so `EmailMessage.idempotencyKey` is enforced by the
 * provider rather than by a middleware holding state in this process. A
 * replayed send is reported on `result.meta.idempotentReplayed`.
 *
 * ```ts
 * createEmail({
 *   driver: ahasend({ apiKey: process.env.AHASEND_API_KEY!, accountId }),
 * })
 * ```
 */
const ahasend: DriverFactory<AhaSendOptions> = defineDriver<AhaSendOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  if (!options.accountId) throw createRequiredError(DRIVER, "accountId")
  if (!options.apiKey.startsWith("aha-sk-")) {
    throw createError(DRIVER, "INVALID_OPTIONS", "`apiKey` must start with 'aha-sk-'")
  }
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const account = `${endpoint}/v2/accounts/${encodeURIComponent(options.accountId)}`
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function request(
    url: string,
    method: string,
    body: unknown,
    extra: {
      idempotencyKey?: string
      signal?: AbortSignal
      onResponse?: (response: Response) => void
    } = {},
  ) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url,
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(extra.idempotencyKey ? { "idempotency-key": extra.idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(extra.onResponse ? { onResponse: extra.onResponse } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify,
    })
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      scheduling: true,
      idempotency: true,
      tracking: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      sandbox: true,
      cancelable: true,
      retrievable: true,
    },

    isAvailable: async () => {
      const response = await request(`${endpoint}/v2/ping`, "GET", undefined)
      return !response.error
    },

    async send(msg, ctx) {
      if (msg.subject == null) {
        // AhaSend hosts no templates, so nothing else can supply one.
        return err(createError(DRIVER, "INVALID_OPTIONS", "`subject` is required"))
      }

      // `/messages` has no Cc or Bcc at all, and turns a recipient list
      // into one separate message each rather than one message addressed
      // to everybody. `/messages/conversation` is the only endpoint that
      // puts several addresses into a single header.
      const conversational = msg.cc.length > 0 || msg.bcc.length > 0 || msg.to.length > 1
      const recipients = msg.to.length + msg.cc.length + msg.bcc.length
      if (conversational && recipients > CONVERSATION_RECIPIENT_LIMIT) {
        return err(
          createError(
            DRIVER,
            "INVALID_OPTIONS",
            `at most ${CONVERSATION_RECIPIENT_LIMIT} to, cc and bcc recipients combined; got ${recipients}`,
          ),
        )
      }

      let replayed = false
      const response = await request(
        conversational ? `${account}/messages/conversation` : `${account}/messages`,
        "POST",
        toPayload(msg, conversational, options),
        {
          ...(msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onResponse: (r) => {
            replayed = r.headers.get("idempotent-replayed") === "true"
          },
        },
      )
      if (response.error) return err(response.error)

      const body = (response.data ?? {}) as AhaSendSendResponse
      const entries = body.data ?? []
      const accepted = entries.find((entry) => entry.id && entry.status !== "error")
      if (!accepted?.id) {
        const reason = entries.find((entry) => entry.error)?.error
        return err(
          createError(DRIVER, "PROVIDER", reason ?? "response did not contain a message id", {
            cause: body,
          }),
        )
      }
      if (replayed) ctx.meta[REPLAYED_META_KEY] = true

      // AhaSend answers per recipient, so a send can be accepted for some
      // and refused for others. One accepted recipient makes the send a
      // success; the per-recipient verdicts stay on `result.provider.data`.
      const result: EmailResult = {
        id: accepted.id,
        driver: DRIVER,
        ...(msg.stream ? { stream: msg.stream } : {}),
        at: new Date(),
        provider: body as unknown as Record<string, unknown>,
      }
      return ok(result)
    },

    async cancel(id, ctx) {
      const response = await request(
        `${account}/messages/${encodeURIComponent(id)}/cancel`,
        "DELETE",
        undefined,
        ctx?.signal ? { signal: ctx.signal } : {},
      )
      return response.error ? err(response.error) : ok(undefined)
    },

    async retrieve(id, ctx) {
      const response = await request(
        `${account}/messages/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        ctx?.signal ? { signal: ctx.signal } : {},
      )
      if (response.error) return err(response.error)
      const body = (response.data ?? {}) as AhaSendMessage
      const at = body.delivered_at ?? body.sent_at ?? body.created_at
      const status: SendStatus = {
        id: body.message_id || body.id || id,
        driver: DRIVER,
        state: toState(body.status),
        ...(at ? { at: new Date(at) } : {}),
        provider: body as unknown as Record<string, unknown>,
      }
      return ok(status)
    },
  }
})

export default ahasend

function toPayload(
  msg: NormalizedMessage,
  conversational: boolean,
  options: AhaSendOptions,
): Record<string, unknown> {
  const headers: Record<string, string> = { ...msg.headers }
  // AhaSend has no metadata field; custom headers are what survive to the
  // delivered message.
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value
  // Its tags are bare strings, so a tag's value needs a header of its own.
  for (const tag of msg.tags) {
    if (tag.value) headers[`X-Tag-${tag.name}`] = tag.value
  }

  const payload: Record<string, unknown> = {
    from: toAddress(msg.from),
    subject: msg.subject,
  }
  if (conversational) {
    payload.to = msg.to.map(toAddress)
    if (msg.cc.length > 0) payload.cc = msg.cc.map(toAddress)
    if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(toAddress)
  } else {
    payload.recipients = msg.to.map(toAddress)
  }

  if (msg.replyTo.length === 1) payload.reply_to = toAddress(msg.replyTo[0]!)
  // `reply_to` is a single address. More than one only fits in the header,
  // which AhaSend forbids alongside the field but accepts on its own.
  else if (msg.replyTo.length > 1) headers["Reply-To"] = formatAddressList(msg.replyTo)

  if (msg.text != null) payload.text_content = msg.text
  if (msg.html != null) payload.html_content = msg.html
  if (Object.keys(headers).length > 0) payload.headers = headers
  if (msg.tags.length > 0) payload.tags = msg.tags.map((tag) => tag.name)
  if (msg.scheduledAt) payload.schedule = { first_attempt: msg.scheduledAt.toISOString() }
  if (msg.tracking) {
    payload.tracking = {
      ...(msg.tracking.opens == null ? {} : { open: msg.tracking.opens }),
      ...(msg.tracking.clicks == null ? {} : { click: msg.tracking.clicks }),
    }
  }

  const sandbox = msg.sandbox ?? options.sandbox
  if (sandbox) {
    payload.sandbox = true
    if (options.sandboxResult) payload.sandbox_result = options.sandboxResult
  }

  if (msg.attachments.length > 0) payload.attachments = msg.attachments.map(toAttachment)
  return payload
}

function toAddress(address: EmailAddress): AhaSendAddress {
  return { email: address.email, ...(address.name ? { name: address.name } : {}) }
}

function toAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    file_name: attachment.filename,
    content_type: attachment.contentType ?? "application/octet-stream",
    base64: true,
    data: attachmentToBase64(attachment),
    // AhaSend delivers the part as a download unless the Content-ID keeps
    // its angle brackets, which is what makes `cid:` references resolve.
    ...(attachment.cid ? { content_id: `<${attachment.cid.replace(/^<|>$/g, "")}>` } : {}),
    ...(attachment.disposition ? { content_disposition: attachment.disposition } : {}),
  }
}

/** On the message endpoints a 409 is only ever the idempotency lease: a
 *  request with this key is still running, and `Retry-After` says when to
 *  come back. A 422 is the same key with a different payload, which no
 *  retry will fix. */
function classify(status: number, body: unknown): Classification | null {
  if (status === 409) return { code: "PROVIDER", retryable: true }
  if (status === 422) {
    return {
      code: "PROVIDER",
      message: messageOf(body) ?? "idempotency key was already used with a different request",
      retryable: false,
    }
  }
  return null
}

function messageOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const message = (body as { message?: unknown }).message
  return typeof message === "string" ? message : null
}

/** AhaSend's statuses are capitalized words, and the sandbox mirrors each
 *  of them under a `Sandbox ` prefix. */
function toState(status?: string): SendState {
  switch (status?.toLowerCase().replace(/^sandbox /, "")) {
    case "received":
    case "deferred":
      return "queued"
    case "delivered":
      return "delivered"
    case "bounced":
      return "bounced"
    case "failed":
    case "suppressed":
      return "failed"
    default:
      return "unknown"
  }
}
