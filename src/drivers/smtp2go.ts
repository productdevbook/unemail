import type {
  Attachment,
  DriverFactory,
  EmailResult,
  NormalizedMessage,
  Result,
  SendStatus,
} from "../core/types.ts"
import type { EmailError } from "../core/error.ts"
import { formatAddress, formatAddressList } from "../core/address.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface Smtp2goOptions {
  /** API key, from Settings → API Keys. */
  apiKey: string
  /** Which regional host to send to. Omitted, the global host routes to
   *  whichever region is closest to the DNS resolver that answered — which
   *  is not necessarily the one holding the account's data. */
  region?: "us" | "eu" | "au"
  /** Override the base URL — for a gateway or a test stub. Wins over
   *  `region`. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Accept the message immediately and send it in a background process.
   *  Faster, and SMTP2GO's coming default — but the response then carries
   *  no `succeeded`/`failed`, so a rejection only reaches you by webhook. */
  fastAccept?: boolean
}

const DRIVER = "smtp2go"
const HOSTS = {
  us: "https://us-api.smtp2go.com",
  eu: "https://eu-api.smtp2go.com",
  au: "https://au-api.smtp2go.com",
} as const
const GLOBAL_HOST = "https://api.smtp2go.com"
/** "An array of names and email addresses (up to 100)" — per field. */
const RECIPIENT_LIMIT = 100
/** "Must be in the future and within the next 3 days." */
const SCHEDULE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** "the following headers are not allowed". */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-transfer-encoding",
  "mime-version",
])
/** `E_ApiResponseCodes.*` values that mean the key, not the message, is the
 *  problem. SMTP2GO answers all of them with a 400. */
const AUTH_ERROR_CODE = /PERMISSION|AUTH|API_KEY|UNAUTHORIZED|FORBIDDEN/i

/**
 * SMTP2GO, over the v3 email API.
 *
 * Two things separate it from the rest: it answers `200 OK` even when the
 * send failed — the outcome is in `failed` and `failures`, not the status
 * code — and it will fetch an attachment from a URL itself, so a large
 * file never passes through this process.
 *
 * ```ts
 * createEmail({ driver: smtp2go({ apiKey: process.env.SMTP2GO_API_KEY!, region: "eu" }) })
 * ```
 */
const smtp2go: DriverFactory<Smtp2goOptions> = defineDriver<Smtp2goOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  const host = options.endpoint ?? (options.region ? HOSTS[options.region] : GLOBAL_HOST)
  const endpoint = host.replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function request(path: string, body: unknown, signal?: AbortSignal) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}/v3${path}`,
      headers: { "x-smtp2go-api-key": options.apiKey },
      body,
      ...(signal ? { signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        // The reason lives under `data`, where the shared extractor does
        // not look, and a rejected key arrives as a 400 rather than a 401.
        const data = (parsed as { data?: { error?: unknown; error_code?: unknown } } | null)?.data
        const code = typeof data?.error_code === "string" ? data.error_code : ""
        const message = typeof data?.error === "string" ? data.error : undefined
        return {
          code: AUTH_ERROR_CODE.test(code) ? "AUTH" : classifyStatus(status),
          ...(message ? { message } : {}),
        }
      },
    })
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      scheduling: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      remoteAttachments: true,
      cancelable: true,
      retrievable: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    async send(msg, ctx) {
      const refusal = checkLimits(msg)
      if (refusal) return err(refusal)
      const response = await request("/email/send", toPayload(msg, options), ctx.signal)
      if (response.error) return err(response.error)
      return toResult(response.data, msg)
    },

    async cancel(id) {
      const response = await request("/email/scheduled/remove", { schedule_id: id })
      return response.error ? err(response.error) : ok(undefined)
    },

    async retrieve(id) {
      const response = await request("/email/scheduled/search", { schedule_id: id })
      if (response.error) return err(response.error)
      const body = (response.data as { data?: unknown } | null)?.data
      const rows = (Array.isArray(body) ? body : []) as {
        schedule_id?: string
        schedule?: string
      }[]
      const row = rows.find((entry) => entry.schedule_id === id)
      const at = row?.schedule ? new Date(row.schedule) : null
      // Only scheduled mail is searchable, so an id for something already
      // sent — or already cancelled — is absent rather than reported.
      const status: SendStatus = {
        id,
        driver: DRIVER,
        state: row ? "scheduled" : "unknown",
        ...(at && !Number.isNaN(at.getTime()) ? { at } : {}),
        provider: { rows },
      }
      return ok(status)
    },
  }
})

export default smtp2go

interface Smtp2goResponse {
  request_id?: string
  data?: {
    succeeded?: number
    failed?: number
    failures?: unknown[]
    email_id?: string
    schedule_id?: string
  }
}

/** What SMTP2GO would reject the message for, checked here so the caller is
 *  told which field and which limit rather than reading
 *  `NON_VALIDATING_IN_PAYLOAD` off a 400. */
function checkLimits(msg: NormalizedMessage): EmailError | null {
  const fields = [
    ["to", msg.to],
    ["cc", msg.cc],
    ["bcc", msg.bcc],
  ] as const
  for (const [name, list] of fields) {
    if (list.length > RECIPIENT_LIMIT) {
      return createError(
        DRIVER,
        "INVALID_OPTIONS",
        `at most ${RECIPIENT_LIMIT} \`${name}\` recipients per message; got ${list.length}`,
      )
    }
  }
  const forbidden = Object.keys(msg.headers).find((name) =>
    FORBIDDEN_HEADERS.has(name.toLowerCase()),
  )
  if (forbidden) {
    return createError(DRIVER, "INVALID_OPTIONS", `header "${forbidden}" may not be set`)
  }
  if (msg.scheduledAt && msg.scheduledAt.getTime() - Date.now() > SCHEDULE_WINDOW_MS) {
    return createError(DRIVER, "INVALID_OPTIONS", "`scheduledAt` may be at most 3 days ahead")
  }
  return null
}

function toPayload(msg: NormalizedMessage, options: Smtp2goOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sender: formatAddress(msg.from),
    to: msg.to.map(formatAddress),
  }
  if (msg.cc.length > 0) payload.cc = msg.cc.map(formatAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(formatAddress)
  // A template carries its own subject and body, and passing an empty
  // string here would blank the template's.
  if (msg.subject != null) payload.subject = msg.subject
  if (msg.text != null) payload.text_body = msg.text
  if (msg.html != null) payload.html_body = msg.html
  if (msg.template?.id) payload.template_id = msg.template.id
  if (msg.template?.variables) payload.template_data = { ...msg.template.variables }

  const headers: Record<string, string> = { ...msg.headers }
  // SMTP2GO has no reply-to, metadata or tag field; a custom header is the
  // documented way to set the first and what survives to the recipient and
  // the webhook events for the other two.
  if (msg.replyTo.length > 0) headers["Reply-To"] = formatAddressList(msg.replyTo)
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value
  for (const tag of msg.tags) headers[`X-Tag-${tag.name}`] = tag.value
  const entries = Object.entries(headers)
  if (entries.length > 0) {
    payload.custom_headers = entries.map(([header, value]) => ({ header, value }))
  }

  const files = msg.attachments.filter((attachment) => !attachment.cid)
  const inlines = msg.attachments.filter((attachment) => attachment.cid)
  if (files.length > 0) payload.attachments = files.map((file) => toFile(file, file.filename))
  // An inline image is addressed as `cid:<filename>`, so what the caller
  // wrote into the HTML as the content id has to be the filename SMTP2GO
  // sees — otherwise the reference resolves to nothing.
  if (inlines.length > 0) {
    payload.inlines = inlines.map((file) => toFile(file, file.cid ?? file.filename))
  }

  if (msg.scheduledAt) payload.schedule = msg.scheduledAt.toISOString()
  if (options.fastAccept) payload.fastaccept = true
  return payload
}

function toFile(attachment: Attachment, filename: string): Record<string, unknown> {
  return {
    filename,
    ...(attachment.contentType ? { mimetype: attachment.contentType } : {}),
    // A url is fetched by SMTP2GO and cached for 24 hours, so the bytes
    // never pass through this process.
    ...(attachment.url ? { url: attachment.url } : { fileblob: attachmentToBase64(attachment) }),
  }
}

function toResult(body: unknown, msg: NormalizedMessage): Result<EmailResult> {
  const envelope = (body ?? {}) as Smtp2goResponse
  const data = envelope.data ?? {}
  const failures = Array.isArray(data.failures) ? data.failures : []
  // "this endpoint returns 200 OK even if there are errors in the response":
  // reading the status alone reports every send as a success.
  if ((data.failed ?? 0) > 0 || failures.length > 0) {
    const reason = failures.map(describeFailure).filter(Boolean).join("; ")
    return err(
      createError(DRIVER, "PROVIDER", reason || `${data.failed ?? failures.length} failed`, {
        retryable: false,
        cause: envelope,
      }),
    )
  }
  // A scheduled send is reported by its schedule id, because that is the
  // only handle `cancel()` accepts; the email id stays on `provider`.
  const id = data.schedule_id ?? data.email_id
  if (!id) {
    return err(createError(DRIVER, "PROVIDER", "response carried no email_id", { cause: envelope }))
  }
  return ok({
    id,
    driver: DRIVER,
    ...(msg.stream ? { stream: msg.stream } : {}),
    at: new Date(),
    provider: envelope as Record<string, unknown>,
  })
}

/** `failures` is documented only as "an array containing any error
 *  messages", so a string is what it holds in practice and an object is
 *  read defensively rather than dropped. */
function describeFailure(failure: unknown): string {
  if (typeof failure === "string") return failure
  if (failure && typeof failure === "object") {
    const record = failure as Record<string, unknown>
    const parts = [
      record.recipient ?? record.email,
      record.error ?? record.message ?? record.reason,
    ].filter((part): part is string => typeof part === "string")
    if (parts.length > 0) return parts.join(": ")
    return JSON.stringify(failure)
  }
  return String(failure)
}
