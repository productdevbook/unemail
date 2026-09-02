import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  NormalizedMessage,
  SendState,
  SendStatus,
} from "../core/types.ts"
import { formatAddressList } from "../core/address.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { hasHeader } from "../core/message.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface ScalewayOptions {
  /** The secret part of a Scaleway API key, sent as `X-Auth-Token`. */
  secretKey: string
  /** Project the email is created in. Required by the API and with no
   *  equivalent on a message, so it lives here. */
  projectId: string
  /** Region in the request path. Default — and, today, the only one
   *  Transactional Email runs in: `fr-par`. */
  region?: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

interface ScalewayEmail {
  id?: string
  message_id?: string
  status?: string
  created_at?: string
}

const DRIVER = "scaleway"
const DEFAULT_ENDPOINT = "https://api.scaleway.com"
const DEFAULT_REGION = "fr-par"
/** "Maximum email size (API): 2 MB, including the email and all
 *  attachments" — the one TEM quota whose maximum equals its default, so
 *  a caller cannot have had it raised. */
const MAX_EMAIL_BYTES = 2 * 1024 * 1024
/** Scaleway takes a MIME type per attachment and accepts a documented list
 *  of about forty file types. The list is theirs to change, so it is not
 *  mirrored here — an unlisted type comes back as a 400 naming it. */
const DEFAULT_CONTENT_TYPE = "application/octet-stream"

/**
 * Scaleway Transactional Email, over its REST API.
 *
 * The API is `v1alpha1`. Scaleway may move it without the guarantees a
 * stable version carries, so pin what you can and expect this driver to
 * follow the endpoint rather than the other way round.
 *
 * ```ts
 * createEmail({
 *   driver: scaleway({
 *     secretKey: process.env.SCW_SECRET_KEY!,
 *     projectId: process.env.SCW_DEFAULT_PROJECT_ID!,
 *   }),
 * })
 * ```
 *
 * Scaleway bills — and reports — one email per recipient, so a message to
 * three addresses answers with three email objects. `EmailResult.id` is the
 * first of them and `provider` carries all of them.
 */
const scaleway: DriverFactory<ScalewayOptions> = defineDriver<ScalewayOptions>((options) => {
  if (!options?.secretKey) throw createRequiredError(DRIVER, "secretKey")
  if (!options.projectId) throw createRequiredError(DRIVER, "projectId")

  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const region = options.region ?? DEFAULT_REGION
  const base = `${endpoint}/transactional-email/v1alpha1/regions/${encodeURIComponent(region)}`
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function request(path: string, method: string, body: unknown, signal?: AbortSignal) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${base}${path}`,
      method,
      headers: { "x-auth-token": options.secretKey },
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
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
      replyTo: true,
      customHeaders: true,
      cancelable: true,
      retrievable: true,
    },

    isAvailable: () => Boolean(options.secretKey && options.projectId),

    async send(msg, ctx) {
      // Serialized once here so the size check weighs the same bytes the
      // request sends, then handed to `httpJson` as a string.
      const body = JSON.stringify(toPayload(msg, options.projectId))
      const size = new TextEncoder().encode(body).byteLength
      if (size > MAX_EMAIL_BYTES) return err(tooLarge(size))

      const response = await request("/emails", "POST", body, ctx.signal)
      if (response.error) return err(response.error)
      const payload = (response.data ?? {}) as { emails?: ScalewayEmail[] }
      const id = payload.emails?.[0]?.id
      if (!id) {
        return err(
          createError(DRIVER, "PROVIDER", "response did not contain an email id", {
            cause: response.data,
          }),
        )
      }
      return ok({
        id,
        driver: DRIVER,
        ...(msg.stream ? { stream: msg.stream } : {}),
        at: new Date(),
        provider: payload as Record<string, unknown>,
      })
    },

    async cancel(id) {
      const response = await request(`/emails/${encodeURIComponent(id)}/cancel`, "POST", {})
      return response.error ? err(response.error) : ok(undefined)
    },

    async retrieve(id) {
      const response = await request(`/emails/${encodeURIComponent(id)}`, "GET", undefined)
      if (response.error) return err(response.error)
      const body = (response.data ?? {}) as ScalewayEmail
      const status: SendStatus = {
        id: body.id ?? id,
        driver: DRIVER,
        state: toState(body.status),
        ...(body.created_at ? { at: new Date(body.created_at) } : {}),
        provider: body as Record<string, unknown>,
      }
      return ok(status)
    },
  }
})

export default scaleway

function toPayload(msg: NormalizedMessage, projectId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: toAddress(msg.from),
    to: msg.to.map(toAddress),
    project_id: projectId,
  }
  if (msg.subject != null) payload.subject = msg.subject
  if (msg.cc.length > 0) payload.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(toAddress)
  if (msg.text != null) payload.text = msg.text
  if (msg.html != null) payload.html = msg.html

  const headers = toHeaders(msg)
  if (headers.length > 0) payload.additional_headers = headers
  if (msg.attachments.length > 0) payload.attachments = msg.attachments.map(toScalewayAttachment)
  return payload
}

/** Scaleway has no `reply_to` and no metadata field; both are ordinary
 *  headers, which is what its own documentation shows for Reply-To. */
function toHeaders(msg: NormalizedMessage): { key: string; value: string }[] {
  const headers = Object.entries(msg.headers).map(([key, value]) => ({ key, value }))
  if (msg.replyTo.length > 0 && !hasHeader(msg.headers, "reply-to")) {
    headers.push({ key: "Reply-To", value: formatAddressList(msg.replyTo) })
  }
  for (const [key, value] of Object.entries(msg.metadata)) {
    headers.push({ key: `X-Metadata-${key}`, value })
  }
  return headers
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}

function toScalewayAttachment(attachment: Attachment): Record<string, string> {
  return {
    name: attachment.filename,
    type: attachment.contentType ?? DEFAULT_CONTENT_TYPE,
    content: attachmentToBase64(attachment),
  }
}

function tooLarge(size: number) {
  return createError(
    DRIVER,
    "INVALID_OPTIONS",
    `the request is ${size} bytes; Scaleway's API accepts at most ${MAX_EMAIL_BYTES} ` +
      "for the email and its attachments together",
  )
}

/** Scaleway answers with `{ type, message }`. Two of its types say more
 *  than the status does. */
function classify(status: number, body: unknown) {
  if (!body || typeof body !== "object") return null
  const error = body as {
    type?: string
    message?: string
    details?: { argument_name?: string; reason?: string }[]
  }

  if (error.type === "quotas_exceeded") {
    // A 403 here is the monthly send quota, not the credentials — and it
    // does not clear on its own, so retrying only spends the attempt.
    return {
      code: "RATE_LIMIT" as const,
      retryable: false,
      message: error.message ?? "quota exceeded",
    }
  }

  if (error.type === "invalid_arguments" && Array.isArray(error.details)) {
    const fields = error.details
      .map((detail) => [detail.argument_name, detail.reason].filter(Boolean).join(" "))
      .filter(Boolean)
    if (fields.length > 0) {
      return {
        code: classifyStatus(status),
        message: `${error.message ?? "invalid arguments"}: ${fields.join("; ")}`,
      }
    }
  }

  return null
}

function toState(status?: string): SendState {
  switch (status) {
    case "new":
    case "sending":
      return "queued"
    case "sent":
      return "sent"
    case "failed":
      return "failed"
    case "canceled":
      return "cancelled"
    default:
      return "unknown"
  }
}
