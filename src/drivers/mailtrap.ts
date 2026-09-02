import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
} from "../core/types.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { chunk } from "./_chunk.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface MailtrapOptions {
  apiKey: string
  /** Email API base. Default `https://send.api.mailtrap.io`. */
  endpoint?: string
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Abort a request after this long, in milliseconds. Default: 30_000. */
  timeoutMs?: number
  /** Category used when no tag is named `category`. Default: `general`. */
  defaultCategory?: string
  /** Mailtrap's edge protection can block a request with no User-Agent. */
  userAgent?: string
  /** Route to the sandbox when the message does not say. Default: false. */
  sandbox?: boolean
  /** Sandbox inbox id, from `mailtrap.io/sandboxes/{id}`. Required to send
   *  to the sandbox at all. */
  inboxId?: number | string
  /** Sandbox API base. Default `https://sandbox.api.mailtrap.io`. */
  sandboxEndpoint?: string
  /** Send over the bulk stream instead of the transactional one. Mailtrap
   *  keeps them apart so a newsletter cannot damage the reputation that
   *  carries your password resets. */
  bulk?: boolean
  /** Bulk API base. Default `https://bulk.api.mailtrap.io`. */
  bulkEndpoint?: string
}

interface MailtrapSendResponse {
  success?: boolean
  message_ids?: string[]
  errors?: string[]
}

interface MailtrapBatchResponse {
  success?: boolean
  responses?: MailtrapSendResponse[]
  errors?: string[]
}

const DRIVER = "mailtrap"
const DEFAULT_ENDPOINT = "https://send.api.mailtrap.io"
const DEFAULT_SANDBOX_ENDPOINT = "https://sandbox.api.mailtrap.io"
const DEFAULT_BULK_ENDPOINT = "https://bulk.api.mailtrap.io"
/** `/api/batch` takes at most 500 messages, and 50 MB across the request. */
const BATCH_LIMIT = 500
/** Each of `to`, `cc` and `bcc` is capped at 1000 addresses. */
const RECIPIENT_LIMIT = 1000
/** `category` is a 255-character string. */
const CATEGORY_LIMIT = 255

/**
 * Mailtrap, over its Email API — and, with `sandbox`, its Email Sandbox.
 *
 * The two are separate services on separate hosts, and the sandbox needs an
 * `inboxId` in the path, so a message's `sandbox` flag chooses the whole
 * endpoint rather than setting a field. This is not the same as SendGrid's
 * or Mailgun's test flags, which stay on the production API.
 *
 * ```ts
 * // real delivery
 * createEmail({ driver: mailtrap({ apiKey }) })
 * // captured in an inbox instead
 * createEmail({ driver: mailtrap({ apiKey, sandbox: true, inboxId: 1234567 }) })
 * ```
 */
const mailtrap: DriverFactory<MailtrapOptions> = defineDriver<MailtrapOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")

  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const sandboxEndpoint = (options.sandboxEndpoint ?? DEFAULT_SANDBOX_ENDPOINT).replace(/\/$/, "")
  const bulkEndpoint = (options.bulkEndpoint ?? DEFAULT_BULK_ENDPOINT).replace(/\/$/, "")
  const defaultCategory = options.defaultCategory ?? "general"
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  const useSandbox = (msg: NormalizedMessage) => msg.sandbox ?? options.sandbox ?? false

  function url(sandbox: boolean, kind: "send" | "batch"): string {
    const host = sandbox ? sandboxEndpoint : options.bulk ? bulkEndpoint : endpoint
    const inbox = sandbox && hasInboxId() ? `/${options.inboxId}` : ""
    return `${host}/api/${kind}${inbox}`
  }

  function hasInboxId(): boolean {
    if (options.inboxId == null) return false
    return typeof options.inboxId === "number" || String(options.inboxId).trim().length > 0
  }

  function request(sandbox: boolean, kind: "send" | "batch", body: unknown, ctx: SendContext) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: url(sandbox, kind),
      headers: {
        "api-token": options.apiKey,
        ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
      },
      body,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        const message = extractErrors(parsed)
        const code = classifyStatus(status)
        return { code, ...(message ? { message } : {}) }
      },
    })
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      sandbox: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    async send(msg, ctx) {
      const sandbox = useSandbox(msg)
      if (sandbox && !hasInboxId()) return err(missingInboxId())
      const tooMany = tooManyRecipients(msg)
      if (tooMany) return err(tooMany)

      const response = await request(sandbox, "send", toPayload(msg, defaultCategory), ctx)
      if (response.error) return err(response.error)
      return toResult(response.data as MailtrapSendResponse, msg)
    },

    async sendBatch(msgs, ctx) {
      // The sandbox and the live API are different hosts, so one request
      // cannot serve both. Refusing beats sending half of them somewhere
      // the caller did not intend.
      const modes = new Set(msgs.map(useSandbox))
      if (modes.size > 1) {
        const mixed = err<EmailResult>(
          createError(
            DRIVER,
            "INVALID_OPTIONS",
            "a batch cannot mix sandbox and live messages — they are different endpoints",
          ),
        )
        return msgs.map(() => mixed)
      }

      const sandbox = modes.has(true)
      if (sandbox && !hasInboxId()) {
        const failure = err<EmailResult>(missingInboxId())
        return msgs.map(() => failure)
      }

      const results: Result<EmailResult>[] = []
      for (const group of chunk(msgs, BATCH_LIMIT)) {
        const response = await request(
          sandbox,
          "batch",
          {
            base: { from: toAddress(group[0]!.from) },
            requests: group.map((msg) => toPayload(msg, defaultCategory)),
          },
          ctx,
        )
        if (response.error) {
          for (const _ of group) results.push(err<EmailResult>(response.error))
          continue
        }
        const body = (response.data ?? {}) as MailtrapBatchResponse
        const entries = body.responses ?? []
        for (const [index, msg] of group.entries()) {
          const entry = entries[index]
          results.push(
            entry
              ? toResult(entry, msg)
              : err<EmailResult>(createError(DRIVER, "PROVIDER", "no result for message")),
          )
        }
      }
      return results
    },
  }
})

export default mailtrap

/** Checked here rather than left to the API: a 422 naming a field is a
 *  worse error than one naming the limit, and it costs a round trip. */
function tooManyRecipients(msg: NormalizedMessage) {
  for (const [field, list] of [
    ["to", msg.to],
    ["cc", msg.cc],
    ["bcc", msg.bcc],
  ] as const) {
    if (list.length > RECIPIENT_LIMIT) {
      return createError(
        DRIVER,
        "INVALID_OPTIONS",
        `\`${field}\` has ${list.length} addresses; Mailtrap accepts at most ${RECIPIENT_LIMIT}`,
      )
    }
  }
  return null
}

function missingInboxId() {
  return createError(
    DRIVER,
    "INVALID_OPTIONS",
    "`inboxId` is required to send to the Email Sandbox",
  )
}

function toResult(body: MailtrapSendResponse, msg: NormalizedMessage): Result<EmailResult> {
  if (body?.success === false) {
    return err(
      createError(DRIVER, "PROVIDER", extractErrors(body) ?? "send failed", {
        retryable: false,
        cause: body,
      }),
    )
  }
  const id = body?.message_ids?.[0]
  if (!id) {
    return err(createError(DRIVER, "PROVIDER", "response contained no message id", { cause: body }))
  }
  return ok({
    id,
    driver: DRIVER,
    ...(msg.stream ? { stream: msg.stream } : {}),
    at: new Date(),
    provider: body as Record<string, unknown>,
  })
}

function toPayload(msg: NormalizedMessage, defaultCategory: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: toAddress(msg.from),
    to: msg.to.map(toAddress),
    subject: msg.subject,
    // Mailtrap groups by category in its UI and rejects a message without
    // one, so there is always a value.
    category: (msg.tags.find((tag) => tag.name === "category")?.value || defaultCategory).slice(
      0,
      CATEGORY_LIMIT,
    ),
  }
  if (msg.cc.length > 0) payload.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(toAddress)
  if (msg.replyTo[0]) payload.reply_to = toAddress(msg.replyTo[0])
  if (msg.text != null) payload.text = msg.text
  if (msg.html != null) payload.html = msg.html
  if (Object.keys(msg.headers).length > 0) payload.headers = { ...msg.headers }
  if (msg.attachments.length > 0) payload.attachments = msg.attachments.map(toMailtrapAttachment)

  const custom: Record<string, string> = { ...msg.metadata }
  for (const tag of msg.tags) {
    if (tag.name === "category") continue
    custom[`tag_${tag.name}`] = tag.value
  }
  if (Object.keys(custom).length > 0) payload.custom_variables = custom

  if (msg.template) {
    if (msg.template.id) payload.template_uuid = msg.template.id
    if (msg.template.variables) payload.template_variables = { ...msg.template.variables }
  }
  return payload
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}

function toMailtrapAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    content: attachmentToBase64(attachment),
    filename: attachment.filename,
    ...(attachment.contentType ? { type: attachment.contentType } : {}),
    ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
    ...(attachment.cid ? { content_id: attachment.cid } : {}),
  }
}

/** Mailtrap reports validation problems as an `errors` array rather than a
 *  message, on both success and failure responses. */
function extractErrors(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const errors = (body as { errors?: unknown }).errors
  if (Array.isArray(errors) && errors.length > 0) return errors.join("; ")
  return null
}
