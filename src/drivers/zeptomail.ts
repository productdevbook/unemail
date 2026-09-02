import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailErrorCode,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
} from "../core/types.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface ZeptomailOptions {
  /** The Agent's Send Mail token. The `Zoho-enczapikey ` prefix is added
   *  for you, and tolerated if you paste it in. */
  token: string
  /** Override the base URL. Zoho documents only `https://api.zeptomail.com`;
   *  an account in another data centre answers on that region's host, which
   *  is what this is for. Default: `https://api.zeptomail.com`. */
  endpoint?: string
  /** Address bounces are returned to. ZeptoMail rejects a send whose
   *  `bounce_address` is absent or not a verified bounce domain. */
  bounceAddress?: string
  /** `client_reference` for messages that do not carry a `client_reference`
   *  tag of their own. ZeptoMail shows it against the transaction in its
   *  reports; it is not an idempotency key. */
  clientReference?: string
  /** Account-level default for `track_clicks`, overridden per message by
   *  `tracking.clicks`. */
  trackClicks?: boolean
  /** Account-level default for `track_opens`, overridden per message by
   *  `tracking.opens`. */
  trackOpens?: boolean
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

const DRIVER = "zeptomail"
const DEFAULT_ENDPOINT = "https://api.zeptomail.com"
const AUTH_PREFIX = "Zoho-enczapikey "
/** "The maximum number of email addresses that can be included in a batch
 *  emails is 500" — addresses, not messages. */
const BATCH_ADDRESS_LIMIT = 500
/** TM_8001 / SM_127: at most 500 unique addresses per recipient field. */
const RECIPIENT_LIMIT = 500
/** TM_8001 / SM_127: total attachments exceeding limit. */
const ATTACHMENT_LIMIT = 60
/** TM_8001 / SM_129: subject character limit. */
const SUBJECT_LIMIT = 500
/** The tag that names a message's `client_reference`. */
const REFERENCE_TAG = "client_reference"

/** Sub-codes in `error.details[]` that mean the credentials, the sender or
 *  the account — not the message — are the problem. */
const AUTH_DETAIL_CODES: ReadonlySet<string> = new Set([
  "SERR_156",
  "SERR_157",
  "SM_111",
  "SM_128",
  "AE_101",
])
/** Sub-codes for a quota that resets on its own. */
const RATE_DETAIL_CODES: ReadonlySet<string> = new Set(["SM_133", "SMI_115"])
/** Sub-codes for credits that do not come back without buying more, so
 *  retrying is pointless however transient the status looks. */
const EXHAUSTED_DETAIL_CODES: ReadonlySet<string> = new Set(["LE_101", "LE_102"])
/** Top-level codes for a malformed or oversized request. */
const INVALID_CODES: ReadonlySet<string> = new Set(["TM_3201", "TM_3301", "TM_8001"])

interface ZeptomailResponse {
  data?: { code?: string; message?: string; additional_info?: unknown[] }[]
  message?: string
  request_id?: string
  object?: string
  error?: {
    code?: string
    message?: string
    request_id?: string
    details?: { code?: string; message?: string; target?: string }[]
  }
}

/**
 * ZeptoMail (Zoho), over its REST API.
 *
 * ```ts
 * createEmail({
 *   driver: zeptomail({ token: process.env.ZEPTOMAIL_TOKEN!, bounceAddress: "bounce@acme.com" }),
 * })
 * ```
 *
 * `sendBatch` uses ZeptoMail's own `/email/batch`, which is one message to
 * many recipients with per-recipient `merge_info` rather than many separate
 * messages — so messages are grouped by everything that batch cannot vary,
 * and only what it can (the recipient and their template variables) differs
 * within a request.
 */
const zeptomail: DriverFactory<ZeptomailOptions> = defineDriver<ZeptomailOptions>((options) => {
  if (!options?.token) throw createRequiredError(DRIVER, "token")
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)
  const token = options.token.toLowerCase().startsWith(AUTH_PREFIX.toLowerCase())
    ? options.token
    : `${AUTH_PREFIX}${options.token}`

  function request(path: string, body: unknown, ctx: SendContext) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}/v1.1${path}`,
      headers: { authorization: token },
      body,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        const error = (parsed as ZeptomailResponse | null)?.error
        if (!error) return { code: classifyStatus(status) }
        const detail = error.details?.[0]
        const message = [error.message, detail?.message, detail?.target].filter(Boolean).join(": ")
        return {
          ...classifyZeptoError(error.code, detail?.code, status),
          ...(message ? { message } : {}),
        }
      },
    })
  }

  async function sendOne(msg: NormalizedMessage, ctx: SendContext): Promise<Result<EmailResult>> {
    const rejected = validate(msg)
    if (rejected) return err(rejected)

    const payload: Record<string, unknown> = {
      ...sharedPayload(msg, options),
      to: msg.to.map(toRecipient),
      ...(msg.cc.length > 0 ? { cc: msg.cc.map(toRecipient) } : {}),
      ...(msg.bcc.length > 0 ? { bcc: msg.bcc.map(toRecipient) } : {}),
      ...(msg.template?.variables ? { merge_info: { ...msg.template.variables } } : {}),
    }
    const response = await request(templated(msg) ? "/email/template" : "/email", payload, ctx)
    if (response.error) return err(response.error)
    return toResult(response.data as ZeptomailResponse, msg)
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      templates: true,
      tracking: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
    },

    isAvailable: () => Boolean(options.token),

    send: sendOne,

    async sendBatch(msgs, ctx) {
      const results: (Result<EmailResult> | undefined)[] = []
      const groups = new Map<string, { index: number; msg: NormalizedMessage }[]>()

      for (const [index, msg] of msgs.entries()) {
        const rejected = validate(msg)
        if (rejected) {
          results[index] = err(rejected)
          continue
        }
        // A batch fans one message out to many `to` entries, so a message
        // with Cc or Bcc would copy those recipients once per entry. Those
        // go down the single-send path instead.
        const shared =
          msg.cc.length > 0 || msg.bcc.length > 0
            ? null
            : JSON.stringify(sharedPayload(msg, options))
        if (shared == null) {
          results[index] = await sendOne(msg, ctx)
          continue
        }
        const group = groups.get(shared)
        if (group) group.push({ index, msg })
        else groups.set(shared, [{ index, msg }])
      }

      for (const [shared, group] of groups) {
        for (const batch of splitByAddresses(group)) {
          if (batch.length === 1) {
            results[batch[0]!.index] = await sendOne(batch[0]!.msg, ctx)
            continue
          }
          const payload = {
            ...(JSON.parse(shared) as Record<string, unknown>),
            to: batch.flatMap(({ msg }) =>
              msg.to.map((address) => ({
                ...toRecipient(address),
                ...(msg.template?.variables ? { merge_info: { ...msg.template.variables } } : {}),
              })),
            ),
          }
          const response = await request(
            templated(batch[0]!.msg) ? "/email/template/batch" : "/email/batch",
            payload,
            ctx,
          )
          // ZeptoMail answers a batch once, for the whole request — there
          // is no per-recipient outcome to read — so every message in it
          // shares the request's fate and its `request_id`.
          for (const { index, msg } of batch) {
            results[index] = response.error
              ? err<EmailResult>(response.error)
              : toResult(response.data as ZeptomailResponse, msg)
          }
        }
      }

      return msgs.map((_, index) => results[index] ?? err<EmailResult>(noResult()))
    },
  }
})

export default zeptomail

/** A message the batch loop never assigned an outcome to. Reaching this
 *  means a bug here, not a provider failure, so it is reported rather
 *  than silently dropped. */
function noResult() {
  return createError(DRIVER, "PROVIDER", "no result for message")
}

/** ZeptoMail counts addresses, not messages, so a run of two-recipient
 *  messages fills a batch twice as fast as a run of one-recipient ones. */
function splitByAddresses<T extends { msg: NormalizedMessage }>(items: readonly T[]): T[][] {
  const out: T[][] = []
  let current: T[] = []
  let addresses = 0
  for (const item of items) {
    if (current.length > 0 && addresses + item.msg.to.length > BATCH_ADDRESS_LIMIT) {
      out.push(current)
      current = []
      addresses = 0
    }
    current.push(item)
    addresses += item.msg.to.length
  }
  if (current.length > 0) out.push(current)
  return out
}

/** Checked here rather than left to the API: a TM_8001 naming a limit costs
 *  a round trip and does not say which field tripped it. */
function validate(msg: NormalizedMessage) {
  for (const [field, list] of [
    ["to", msg.to],
    ["cc", msg.cc],
    ["bcc", msg.bcc],
  ] as const) {
    if (list.length > RECIPIENT_LIMIT) {
      return createError(
        DRIVER,
        "INVALID_OPTIONS",
        `\`${field}\` has ${list.length} addresses; ZeptoMail accepts at most ${RECIPIENT_LIMIT}`,
      )
    }
  }
  if (msg.attachments.length > ATTACHMENT_LIMIT) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `${msg.attachments.length} attachments; ZeptoMail accepts at most ${ATTACHMENT_LIMIT}`,
    )
  }
  if ((msg.subject?.length ?? 0) > SUBJECT_LIMIT) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `\`subject\` is ${msg.subject?.length} characters; ZeptoMail accepts at most ${SUBJECT_LIMIT}`,
    )
  }
  return null
}

function templated(msg: NormalizedMessage): boolean {
  return Boolean(msg.template?.id || msg.template?.alias)
}

/** Everything a batch request cannot vary between its recipients. Two
 *  messages that produce the same object can share one request. */
function sharedPayload(msg: NormalizedMessage, options: ZeptomailOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: toAddress(msg.from),
    subject: msg.subject,
  }
  if (msg.replyTo.length > 0) payload.reply_to = msg.replyTo.map(toAddress)
  if (msg.text != null) payload.textbody = msg.text
  if (msg.html != null) payload.htmlbody = msg.html

  // ZeptoMail has no tag or metadata field; `mime_headers` is what its
  // webhook events echo back.
  const headers: Record<string, string> = { ...msg.headers }
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value
  for (const tag of msg.tags) {
    if (tag.name === REFERENCE_TAG) continue
    headers[`X-Tag-${tag.name}`] = tag.value
  }
  if (Object.keys(headers).length > 0) payload.mime_headers = headers

  const reference =
    msg.tags.find((tag) => tag.name === REFERENCE_TAG)?.value ?? options.clientReference
  if (reference) payload.client_reference = reference
  if (options.bounceAddress) payload.bounce_address = options.bounceAddress

  const clicks = msg.tracking?.clicks ?? options.trackClicks
  const opens = msg.tracking?.opens ?? options.trackOpens
  if (clicks != null) payload.track_clicks = clicks
  if (opens != null) payload.track_opens = opens

  const files = msg.attachments.filter((attachment) => !isInline(attachment))
  const inline = msg.attachments.filter(isInline)
  if (files.length > 0) {
    payload.attachments = files.map((attachment) => ({
      name: attachment.filename,
      content: attachmentToBase64(attachment),
      mime_type: attachment.contentType ?? "application/octet-stream",
    }))
  }
  if (inline.length > 0) {
    payload.inline_images = inline.map((attachment) => ({
      cid: attachment.cid,
      content: attachmentToBase64(attachment),
      mime_type: attachment.contentType ?? "application/octet-stream",
    }))
  }

  if (msg.template?.id) payload.template_key = msg.template.id
  if (msg.template?.alias) payload.template_alias = msg.template.alias
  return payload
}

/** An image referenced from the HTML by `cid:` is a separate field here,
 *  not an attachment with a disposition. */
function isInline(attachment: Attachment): boolean {
  return Boolean(attachment.cid)
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { address: address.email, name: address.name } : { address: address.email }
}

function toRecipient(address: EmailAddress): Record<string, unknown> {
  return { email_address: toAddress(address) }
}

function toResult(body: ZeptomailResponse, msg: NormalizedMessage): Result<EmailResult> {
  const id = body?.request_id
  if (!id) {
    return err(
      createError(DRIVER, "PROVIDER", "response did not contain a request_id", { cause: body }),
    )
  }
  return ok({
    id,
    driver: DRIVER,
    ...(msg.stream ? { stream: msg.stream } : {}),
    at: new Date(),
    provider: body as unknown as Record<string, unknown>,
  })
}

/** ZeptoMail says more in `error.details[].code` than the status does: the
 *  same 400 covers an invalid token, an unverified sender and a subject
 *  that is too long. */
function classifyZeptoError(
  code: string | undefined,
  detail: string | undefined,
  status: number,
): { code: EmailErrorCode; retryable?: boolean } {
  if (detail) {
    if (AUTH_DETAIL_CODES.has(detail)) return { code: "AUTH" }
    if (RATE_DETAIL_CODES.has(detail)) return { code: "RATE_LIMIT" }
    if (EXHAUSTED_DETAIL_CODES.has(detail)) return { code: "PROVIDER", retryable: false }
  }
  if (code && INVALID_CODES.has(code)) return { code: "INVALID_OPTIONS" }
  return { code: classifyStatus(status) }
}
