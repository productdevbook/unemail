import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
  SendState,
  SendStatus,
} from "../core/types.ts"
import type { EmailError } from "../core/error.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { chunk } from "./_chunk.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface MailerSendOptions {
  /** API token from the MailerSend dashboard. */
  apiKey: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Mark every message as bulk mail (`Precedence: bulk`), which suppresses
   *  auto-replies. Overrides the domain-level setting. */
  precedenceBulk?: boolean
}

const DRIVER = "mailersend"
const DEFAULT_ENDPOINT = "https://api.mailersend.com"
/** `/v1/bulk-email` takes 500 message objects per request (5 on trial). */
const BULK_LIMIT = 500
const TO_LIMIT = 50
const CC_LIMIT = 10
const BCC_LIMIT = 10
const TAG_LIMIT = 5
/** `send_at` may not be further ahead than this. */
const SCHEDULE_WINDOW_MS = 72 * 60 * 60 * 1000
/** Headers MailerSend reads off a message rather than passing through. */
const IN_REPLY_TO = "in-reply-to"
const REFERENCES = "references"
const LIST_UNSUBSCRIBE = "list-unsubscribe"
const LIST_UNSUBSCRIBE_POST = "list-unsubscribe-post"

/**
 * MailerSend, over its REST API.
 *
 * ```ts
 * createEmail({ driver: mailersend({ apiKey: process.env.MAILERSEND_API_KEY! }) })
 * ```
 */
const mailersend: DriverFactory<MailerSendOptions> = defineDriver<MailerSendOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function request(
    path: string,
    method: string,
    body: unknown,
    extra: { signal?: AbortSignal; onResponse?: (response: Response) => void } = {},
  ) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}${path}`,
      method,
      headers: { authorization: `Bearer ${options.apiKey}` },
      ...(body === undefined ? {} : { body }),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        const message = extractValidationErrors(parsed)
        return { code: classifyStatus(status), ...(message ? { message } : {}) }
      },
      ...(extra.onResponse ? { onResponse: extra.onResponse } : {}),
    })
  }

  async function sendOne(msg: NormalizedMessage, ctx: SendContext): Promise<Result<EmailResult>> {
    const invalid = validate(msg)
    if (invalid) return err(invalid)

    // MailerSend answers with a 202 and an empty body; the message id
    // exists only in this header.
    let headerId: string | undefined
    const response = await request("/v1/email", "POST", toPayload(msg, options), {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onResponse: (raw) => {
        headerId = raw.headers.get("x-message-id") ?? undefined
      },
    })
    if (response.error) return err(response.error)
    const body = (response.data ?? {}) as { message_id?: string }
    const id = headerId ?? body.message_id
    if (!id) {
      return err(
        createError(DRIVER, "PROVIDER", "response carried no `x-message-id` header", {
          cause: response.data,
        }),
      )
    }
    return ok(toResult(id, msg, { message_id: id }))
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      scheduling: true,
      tracking: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      cancelable: true,
      retrievable: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    send: sendOne,

    async sendBatch(msgs, ctx) {
      const results: Result<EmailResult>[] = Array.from({ length: msgs.length })
      const sendable: { index: number; msg: NormalizedMessage }[] = []
      for (const [index, msg] of msgs.entries()) {
        const invalid = validate(msg)
        if (invalid) results[index] = err(invalid)
        else sendable.push({ index, msg })
      }
      if (sendable.length === 0) return results

      for (const group of chunk(sendable, BULK_LIMIT)) {
        const response = await request(
          "/v1/bulk-email",
          "POST",
          group.map((entry) => toPayload(entry.msg, options)),
          ctx.signal ? { signal: ctx.signal } : {},
        )
        if (response.error) {
          for (const entry of group) results[entry.index] = err(response.error)
          continue
        }
        const body = (response.data ?? {}) as { bulk_email_id?: string }
        const id = body.bulk_email_id
        for (const entry of group) {
          // The bulk endpoint issues one id for the whole request and no
          // per-message ids at all, so every message in the group carries
          // the handle that `retrieve()` can actually resolve.
          results[entry.index] = id
            ? ok(toResult(id, entry.msg, body))
            : err<EmailResult>(
                createError(DRIVER, "PROVIDER", "response did not contain a bulk_email_id", {
                  cause: body,
                }),
              )
        }
      }
      return results
    },

    /** Deletes a *scheduled* message. MailerSend refuses within 10 minutes
     *  of the send time. */
    async cancel(id) {
      const response = await request(
        `/v1/message-schedules/${encodeURIComponent(id)}`,
        "DELETE",
        undefined,
      )
      return response.error ? err(response.error) : ok(undefined)
    },

    async retrieve(id) {
      const response = await request(`/v1/messages/${encodeURIComponent(id)}`, "GET", undefined)
      // `sendBatch` hands back a bulk id, which the message endpoint does
      // not know; the bulk endpoint is the one that can resolve it.
      if (response.error) {
        if (response.error.status !== 404) return err(response.error)
        return retrieveBulk(id)
      }
      const body = (response.data ?? {}) as {
        data?: { id?: string; created_at?: string; emails?: { status?: string }[] }
      }
      const data = body.data ?? {}
      const status: SendStatus = {
        id: data.id ?? id,
        driver: DRIVER,
        state: toState(data.emails?.[0]?.status),
        ...(data.created_at ? { at: new Date(data.created_at) } : {}),
        provider: body,
      }
      return ok(status)
    },
  }

  async function retrieveBulk(id: string): Promise<Result<SendStatus>> {
    const response = await request(`/v1/bulk-email/${encodeURIComponent(id)}`, "GET", undefined)
    if (response.error) return err(response.error)
    const body = (response.data ?? {}) as {
      data?: { id?: string; state?: string; created_at?: string }
    }
    const data = body.data ?? {}
    const status: SendStatus = {
      id: data.id ?? id,
      driver: DRIVER,
      state: toBulkState(data.state),
      ...(data.created_at ? { at: new Date(data.created_at) } : {}),
      provider: body,
    }
    return ok(status)
  }
})

export default mailersend

/** The caps MailerSend enforces with a 422. Checked first so the caller
 *  gets the reason without spending a round trip. */
function validate(msg: NormalizedMessage): EmailError | null {
  const over = (what: string, count: number, limit: number) =>
    count > limit
      ? createError(
          DRIVER,
          "INVALID_OPTIONS",
          `MailerSend accepts at most ${limit} ${what}, got ${count}`,
        )
      : null
  const limit =
    over("`to` recipients", msg.to.length, TO_LIMIT) ??
    over("`cc` recipients", msg.cc.length, CC_LIMIT) ??
    over("`bcc` recipients", msg.bcc.length, BCC_LIMIT) ??
    over("tags", msg.tags.length, TAG_LIMIT)
  if (limit) return limit

  if (msg.scheduledAt && msg.scheduledAt.getTime() - Date.now() > SCHEDULE_WINDOW_MS) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      "`scheduledAt` may be at most 72 hours ahead for MailerSend",
    )
  }
  return null
}

function toPayload(msg: NormalizedMessage, options: MailerSendOptions): Record<string, unknown> {
  const headers: Record<string, string> = { ...msg.headers }
  // MailerSend reads these three off dedicated fields; leaving them in
  // `headers` would either duplicate them or be rejected outright.
  const inReplyTo = take(headers, IN_REPLY_TO)
  const references = take(headers, REFERENCES)
  const listUnsubscribe = take(headers, LIST_UNSUBSCRIBE)
  // `list_unsubscribe` is RFC 8058 compliant on MailerSend's side, so it
  // emits the one-click Post header itself; passing ours would duplicate it.
  if (listUnsubscribe) take(headers, LIST_UNSUBSCRIBE_POST)
  // MailerSend has no metadata field of its own; custom headers are what
  // survive to the webhook events.
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value

  const payload: Record<string, unknown> = {
    from: toAddress(msg.from),
    to: msg.to.map(toAddress),
    subject: msg.subject,
  }
  if (msg.cc.length > 0) payload.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(toAddress)
  // MailerSend takes exactly one reply-to address, not a list.
  if (msg.replyTo[0]) payload.reply_to = toAddress(msg.replyTo[0])
  if (msg.text != null) payload.text = msg.text
  if (msg.html != null) payload.html = msg.html
  if (Object.keys(headers).length > 0) {
    payload.headers = Object.entries(headers).map(([name, value]) => ({ name, value }))
  }
  if (inReplyTo) payload.in_reply_to = inReplyTo
  if (references) payload.references = references.split(/\s+/).filter(Boolean)
  if (listUnsubscribe) payload.list_unsubscribe = listUnsubscribe
  // MailerSend tags are bare strings; a tag's value has nowhere to go but
  // the metadata headers above, so it is carried there too.
  if (msg.tags.length > 0) {
    payload.tags = msg.tags.map((tag) => tag.name)
    payload.headers = [
      ...((payload.headers as { name: string; value: string }[] | undefined) ?? []),
      ...msg.tags.map((tag) => ({ name: `X-Tag-${tag.name}`, value: tag.value })),
    ]
  }
  const template = msg.template
  // MailerSend addresses templates by an opaque string, so an `alias` is
  // just as valid an id as an `id`.
  const templateId = template ? (template.id ?? template.alias) : undefined
  if (templateId) payload.template_id = templateId
  // Personalization is addressed per recipient, so the same variables are
  // repeated for each — otherwise only the first `to` would render them.
  if (template?.variables) {
    const data = { ...template.variables }
    payload.personalization = msg.to.map((address) => ({ email: address.email, data }))
  }
  const settings: Record<string, boolean> = {}
  if (msg.tracking?.opens != null) settings.track_opens = msg.tracking.opens
  if (msg.tracking?.clicks != null) settings.track_clicks = msg.tracking.clicks
  if (Object.keys(settings).length > 0) payload.settings = settings
  if (options.precedenceBulk != null) payload.precedence_bulk = options.precedenceBulk
  if (msg.scheduledAt) payload.send_at = Math.floor(msg.scheduledAt.getTime() / 1000)
  if (msg.attachments.length > 0) payload.attachments = msg.attachments.map(toMailerSendAttachment)
  return payload
}

function take(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
  if (!key) return undefined
  const value = headers[key]
  delete headers[key]
  return value
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}

function toMailerSendAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    filename: attachment.filename,
    content: attachmentToBase64(attachment),
    disposition: attachment.disposition ?? (attachment.cid ? "inline" : "attachment"),
    ...(attachment.cid ? { id: attachment.cid } : {}),
  }
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

/** MailerSend reports validation failures as `{ message, errors: { field:
 *  [reason] } }`; the top-level message is always the same sentence, so the
 *  field reasons are what a caller actually needs. */
function extractValidationErrors(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const errors = (body as { errors?: unknown }).errors
  if (!errors || typeof errors !== "object") return null
  const parts: string[] = []
  for (const [field, reasons] of Object.entries(errors as Record<string, unknown>)) {
    const list = Array.isArray(reasons) ? reasons : [reasons]
    parts.push(`${field}: ${list.join(", ")}`)
  }
  return parts.length > 0 ? parts.join("; ") : null
}

function toState(status?: string): SendState {
  switch (status) {
    case "queued":
    case "processed":
      return "queued"
    case "sent":
    case "delivered":
    case "opened":
    case "clicked":
      return status
    case "soft_bounced":
    case "hard_bounced":
      return "bounced"
    case "spam_complaint":
      return "complained"
    case "rejected":
      return "failed"
    default:
      return "unknown"
  }
}

function toBulkState(state?: string): SendState {
  switch (state) {
    case "completed":
      return "sent"
    case "processing":
      return "queued"
    case "failed":
      return "failed"
    default:
      return "unknown"
  }
}
