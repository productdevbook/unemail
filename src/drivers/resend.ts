import type {
  DriverFactory,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
  SendState,
  SendStatus,
} from "../core/types.ts"
import { formatAddress } from "../core/address.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { batchIdempotencyKey, chunk } from "./_chunk.ts"
import { httpJson, resolveFetch } from "./_fetch.ts"

export interface ResendOptions {
  /** Server API key. Starts with `re_`. */
  apiKey: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

const DRIVER = "resend"
/** Resend caps `/emails/batch` at 100 messages per request. */
const BATCH_LIMIT = 100

/**
 * Resend, over its REST API.
 *
 * ```ts
 * createEmail({ driver: resend({ apiKey: process.env.RESEND_API_KEY! }) })
 * ```
 */
const resend: DriverFactory<ResendOptions> = defineDriver<ResendOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  if (!options.apiKey.startsWith("re_")) {
    throw createError(DRIVER, "INVALID_OPTIONS", "`apiKey` must start with 're_'")
  }
  const endpoint = (options.endpoint ?? "https://api.resend.com").replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function request(
    path: string,
    method: string,
    body: unknown,
    extra: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}${path}`,
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(extra.idempotencyKey ? { "idempotency-key": extra.idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
    })
  }

  async function sendOne(msg: NormalizedMessage, ctx: SendContext): Promise<Result<EmailResult>> {
    const response = await request("/emails", "POST", toPayload(msg), {
      ...(msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (response.error) return err(response.error)
    const body = (response.data ?? {}) as { id?: string }
    if (!body.id) return err(missingId(response.data))
    return ok(toResult(body.id, msg, body))
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      scheduling: true,
      idempotency: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      cancelable: true,
      retrievable: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    send: sendOne,

    async sendBatch(msgs, ctx) {
      // The batch endpoint has no attachment support — "The attachments
      // field is not supported yet" — so a batch carrying one goes down the
      // single-send path, which does. Otherwise `sendBatch([a])` would
      // attach the file and `sendBatch([a, b])` would quietly not.
      if (msgs.some((msg) => msg.attachments.length > 0)) {
        const out: Result<EmailResult>[] = []
        for (const msg of msgs) out.push(await sendOne(msg, ctx))
        return out
      }

      const results: Result<EmailResult>[] = []
      for (const group of chunk(msgs, BATCH_LIMIT)) {
        const idempotencyKey = await batchIdempotencyKey(group.map((msg) => msg.idempotencyKey))
        const response = await request("/emails/batch", "POST", group.map(toPayload), {
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        if (response.error) {
          for (const _ of group) results.push(err<EmailResult>(response.error))
          continue
        }
        const body = (response.data ?? {}) as { data?: { id: string }[] }
        const entries = body.data ?? []
        // Resend answers positionally; if it ever does not, the core's
        // length check turns that into a loud failure rather than a
        // silently mismatched set of ids.
        for (const [index, msg] of group.entries()) {
          const entry = entries[index]
          results.push(
            entry?.id ? ok(toResult(entry.id, msg, entry)) : err<EmailResult>(missingId(body)),
          )
        }
      }
      return results
    },

    async cancel(id) {
      const response = await request(`/emails/${encodeURIComponent(id)}/cancel`, "POST", {})
      return response.error ? err(response.error) : ok(undefined)
    },

    async retrieve(id) {
      const response = await request(`/emails/${encodeURIComponent(id)}`, "GET", undefined)
      if (response.error) return err(response.error)
      const body = (response.data ?? {}) as {
        id?: string
        last_event?: string
        created_at?: string
      }
      const status: SendStatus = {
        id: body.id ?? id,
        driver: DRIVER,
        state: toState(body.last_event),
        ...(body.created_at ? { at: new Date(body.created_at) } : {}),
        provider: body,
      }
      return ok(status)
    },
  }
})

export default resend

function toPayload(msg: NormalizedMessage): Record<string, unknown> {
  const headers: Record<string, string> = { ...msg.headers }
  // Resend has no metadata field of its own; custom headers are what come
  // back on its webhook events.
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value

  const payload: Record<string, unknown> = {
    from: formatAddress(msg.from),
    to: msg.to.map(formatAddress),
    subject: msg.subject,
  }
  if (msg.cc.length > 0) payload.cc = msg.cc.map(formatAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(formatAddress)
  if (msg.replyTo.length > 0) payload.reply_to = msg.replyTo.map(formatAddress)
  if (msg.text != null) payload.text = msg.text
  if (msg.html != null) payload.html = msg.html
  if (Object.keys(headers).length > 0) payload.headers = headers
  if (msg.tags.length > 0) payload.tags = msg.tags.map((t) => ({ name: t.name, value: t.value }))
  if (msg.scheduledAt) payload.scheduled_at = msg.scheduledAt.toISOString()
  if (msg.attachments.length > 0) {
    payload.attachments = msg.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachmentToBase64(attachment),
      ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
      ...(attachment.cid ? { content_id: attachment.cid } : {}),
    }))
  }
  return payload
}

function toResult(
  id: string,
  msg: NormalizedMessage,
  provider: Record<string, unknown>,
): EmailResult {
  return {
    id,
    driver: DRIVER,
    ...(msg.stream ? { stream: msg.stream } : {}),
    at: new Date(),
    provider,
  }
}

function missingId(body: unknown) {
  return createError(DRIVER, "PROVIDER", "response did not contain an email id", { cause: body })
}

function toState(event?: string): SendState {
  switch (event) {
    case "sent":
    case "delivered":
    case "complained":
    case "opened":
    case "clicked":
    case "scheduled":
    case "cancelled":
    case "bounced":
      return event
    case "delivery_delayed":
      return "queued"
    default:
      return "unknown"
  }
}
