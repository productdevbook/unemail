import type { DriverFactory, EmailResult, NormalizedMessage, Result } from "../core/types.ts"
import { formatAddress, formatAddressList } from "../core/address.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface PostmarkOptions {
  /** The per-server token, not the account token. */
  token: string
  /** `MessageStream` for messages that do not set `stream` themselves. */
  messageStream?: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

const DRIVER = "postmark"
/** Postmark's "sender signature not confirmed" / bad-token family. */
const AUTH_ERROR_CODES = new Set([10, 400, 401])

/**
 * Postmark, over its REST API. The one mainstream provider with real
 * transactional/broadcast stream isolation — route with `message.stream`
 * or set `messageStream` as the instance default.
 *
 * ```ts
 * const email = createEmail({ driver: postmark({ token }) })
 * await email.send({ ...msg, stream: "broadcast" })
 * ```
 */
const postmark: DriverFactory<PostmarkOptions> = defineDriver<PostmarkOptions>((options) => {
  if (!options?.token) throw createRequiredError(DRIVER, "token")
  const endpoint = (options.endpoint ?? "https://api.postmarkapp.com").replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function request(path: string, body: unknown) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}${path}`,
      headers: { "x-postmark-server-token": options.token },
      body,
      classify(status, parsed) {
        const code = (parsed as { ErrorCode?: number } | null)?.ErrorCode
        if (code != null && AUTH_ERROR_CODES.has(code)) return { code: "AUTH" }
        return { code: classifyStatus(status) }
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
      tracking: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
    },

    isAvailable: () => Boolean(options.token),

    async send(msg) {
      const payload = toPayload(msg, options.messageStream)
      const response = await request(msg.template ? "/email/withTemplate" : "/email", payload)
      if (response.error) return err(response.error)
      return toResult(response.data as PostmarkResponse, msg, options.messageStream)
    },

    async sendBatch(msgs) {
      const withTemplate = msgs.some((msg) => msg.template)
      // Postmark keeps templated and plain batches on separate endpoints,
      // and will not mix them in one request.
      if (withTemplate && msgs.some((msg) => !msg.template)) {
        const conflict = err<EmailResult>(
          createError(
            DRIVER,
            "INVALID_OPTIONS",
            "a batch must be all templated or all plain — Postmark has no mixed endpoint",
          ),
        )
        return msgs.map(() => conflict)
      }

      const payload = msgs.map((msg) => toPayload(msg, options.messageStream))
      const response = await request(
        withTemplate ? "/email/batchWithTemplates" : "/email/batch",
        withTemplate ? { Messages: payload } : payload,
      )
      if (response.error) return msgs.map(() => err<EmailResult>(response.error))

      const entries = (response.data ?? []) as PostmarkResponse[]
      // Postmark reports per-message failures inside a 200 response, which
      // is exactly the case an all-or-nothing batch used to lose.
      return msgs.map((msg, index) => {
        const entry = entries[index]
        if (!entry)
          return err<EmailResult>(createError(DRIVER, "PROVIDER", "no result for message"))
        return toResult(entry, msg, options.messageStream)
      })
    },
  }
})

export default postmark

interface PostmarkResponse {
  MessageID?: string
  SubmittedAt?: string
  ErrorCode?: number
  Message?: string
}

function toResult(
  entry: PostmarkResponse,
  msg: NormalizedMessage,
  defaultStream?: string,
): Result<EmailResult> {
  if (entry.ErrorCode) {
    const code = AUTH_ERROR_CODES.has(entry.ErrorCode) ? "AUTH" : "PROVIDER"
    return err(
      createError(DRIVER, code, entry.Message ?? `ErrorCode ${entry.ErrorCode}`, {
        status: entry.ErrorCode,
        retryable: false,
        cause: entry,
      }),
    )
  }
  if (!entry.MessageID) {
    return err(
      createError(DRIVER, "PROVIDER", "response did not contain a MessageID", { cause: entry }),
    )
  }
  const at = entry.SubmittedAt ? new Date(entry.SubmittedAt) : null
  const stream = msg.stream ?? defaultStream
  return ok({
    id: entry.MessageID,
    driver: DRIVER,
    ...(stream ? { stream } : {}),
    at: at && !Number.isNaN(at.getTime()) ? at : new Date(),
    provider: entry as Record<string, unknown>,
  })
}

function toPayload(msg: NormalizedMessage, defaultStream?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    From: formatAddress(msg.from),
    To: formatAddressList(msg.to),
    Subject: msg.subject,
  }
  if (msg.cc.length > 0) payload.Cc = formatAddressList(msg.cc)
  if (msg.bcc.length > 0) payload.Bcc = formatAddressList(msg.bcc)
  if (msg.replyTo.length > 0) payload.ReplyTo = formatAddressList(msg.replyTo)
  if (msg.text != null) payload.TextBody = msg.text
  if (msg.html != null) payload.HtmlBody = msg.html

  const headers = Object.entries(msg.headers)
  if (headers.length > 0) payload.Headers = headers.map(([Name, Value]) => ({ Name, Value }))
  if (Object.keys(msg.metadata).length > 0) payload.Metadata = { ...msg.metadata }
  // Postmark takes exactly one tag; the rest carry as metadata so nothing
  // the caller set is silently dropped.
  if (msg.tags.length > 0) {
    payload.Tag = msg.tags[0]!.name
    if (msg.tags.length > 1) {
      payload.Metadata = {
        ...(payload.Metadata as Record<string, string> | undefined),
        ...Object.fromEntries(msg.tags.slice(1).map((tag) => [tag.name, tag.value])),
      }
    }
  }
  if (msg.tracking?.opens != null) payload.TrackOpens = msg.tracking.opens
  if (msg.tracking?.clicks != null)
    payload.TrackLinks = msg.tracking.clicks ? "HtmlAndText" : "None"
  if (msg.attachments.length > 0) {
    payload.Attachments = msg.attachments.map((attachment) => ({
      Name: attachment.filename,
      Content: attachmentToBase64(attachment.content),
      ContentType: attachment.contentType ?? "application/octet-stream",
      ...(attachment.cid ? { ContentID: `cid:${attachment.cid}` } : {}),
    }))
  }
  if (msg.template) {
    if (msg.template.id) {
      const numeric = Number.parseInt(msg.template.id, 10)
      payload.TemplateId = Number.isNaN(numeric) ? msg.template.id : numeric
    }
    if (msg.template.alias) payload.TemplateAlias = msg.template.alias
    if (msg.template.variables) payload.TemplateModel = { ...msg.template.variables }
  }
  const stream = msg.stream ?? defaultStream
  if (stream) payload.MessageStream = stream
  return payload
}
