import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailMessage,
  EmailResult,
  EmailTag,
  Result,
  SendStatus,
  SendStatusState,
} from "../types.ts"
import { defineDriver } from "../_define.ts"
import { formatAddress, normalizeAddresses } from "../_normalize.ts"
import { createError, createRequiredError, toEmailError } from "../errors.ts"

/** Options for the Resend driver. Keep the surface minimal — everything
 *  Resend-specific (tags, scheduling, idempotency) is carried on the
 *  `EmailMessage` itself. */
export interface ResendDriverOptions {
  apiKey: string
  /** Override for self-hosted gateways or test stubs. */
  endpoint?: string
  /** Fetch impl — useful for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

interface ResendApiSuccess {
  id: string
  [k: string]: unknown
}

interface ResendApiError {
  name?: string
  message?: string
  statusCode?: number
}

const DRIVER = "resend"
const DEFAULT_ENDPOINT = "https://api.resend.com"

const resend: DriverFactory<ResendDriverOptions> = defineDriver<ResendDriverOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  if (!options.apiKey.startsWith("re_"))
    throw createError(DRIVER, "INVALID_OPTIONS", "apiKey must start with 're_'")

  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function")
    throw createError(DRIVER, "INVALID_OPTIONS", "fetch is unavailable; pass `fetch` explicitly")

  return {
    name: DRIVER,
    options,
    flags: {
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

    async isAvailable() {
      return Boolean(options.apiKey)
    },

    async send(msg) {
      const payload = buildPayload(msg)
      const res = await request(fetchImpl, endpoint, "/emails", "POST", options.apiKey, payload, {
        idempotencyKey: msg.idempotencyKey,
      })
      if (res.error) return res as Result<EmailResult>
      const data = res.data as ResendApiSuccess
      return {
        data: {
          id: data.id,
          driver: DRIVER,
          at: new Date(),
          provider: data,
        },
        error: null,
      }
    },

    async cancel(id) {
      const res = await request(
        fetchImpl,
        endpoint,
        `/emails/${id}/cancel`,
        "POST",
        options.apiKey,
        {},
      )
      if (res.error) return res as Result<void>
      return { data: undefined, error: null }
    },

    async retrieve(id) {
      const res = await request(fetchImpl, endpoint, `/emails/${id}`, "GET", options.apiKey, null)
      if (res.error) return res as Result<SendStatus>
      const body = (res.data ?? {}) as {
        id?: string
        last_event?: string
        created_at?: string
      }
      return {
        data: {
          id: body.id ?? id,
          driver: DRIVER,
          state: mapResendStatus(body.last_event),
          at: body.created_at ? new Date(body.created_at) : undefined,
          provider: body,
        },
        error: null,
      }
    },

    async sendBatch(msgs) {
      const payload = msgs.map((m) => buildPayload(m))
      const res = await request(
        fetchImpl,
        endpoint,
        "/emails/batch",
        "POST",
        options.apiKey,
        payload,
      )
      if (res.error) return res as never
      const body = (res.data ?? {}) as { data?: Array<{ id: string }> }
      const items = body.data ?? []
      return {
        data: items.map((entry) => ({
          id: entry.id,
          driver: DRIVER,
          at: new Date(),
          provider: entry,
        })),
        error: null,
      }
    },
  }
})

export default resend

function buildPayload(msg: EmailMessage): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const body: Record<string, unknown> = {
    from: formatAddress(from),
    to: addressList(msg.to),
    subject: msg.subject,
  }
  if (msg.cc) body.cc = addressList(msg.cc)
  if (msg.bcc) body.bcc = addressList(msg.bcc)
  if (msg.replyTo) body.reply_to = addressList(msg.replyTo)
  if (msg.text) body.text = msg.text
  if (msg.html) body.html = msg.html
  if (msg.headers) body.headers = msg.headers
  if (msg.tags) body.tags = msg.tags.map((t: EmailTag) => ({ name: t.name, value: t.value }))
  if (msg.attachments?.length) body.attachments = msg.attachments.map(toResendAttachment)
  if (msg.scheduledAt) {
    body.scheduled_at =
      msg.scheduledAt instanceof Date ? msg.scheduledAt.toISOString() : msg.scheduledAt
  }
  return body
}

function addressList(input: EmailMessage["to"]): string[] {
  return normalizeAddresses(input).map((a: EmailAddress) => formatAddress(a))
}

function toResendAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  const out: Record<string, unknown> = {
    filename: a.filename,
    content,
    content_type: a.contentType,
  }
  if (a.disposition) out.disposition = a.disposition
  if (a.cid) out.content_id = a.cid
  return out
}

function mapResendStatus(event?: string): SendStatusState {
  switch (event) {
    case "sent":
      return "sent"
    case "delivered":
      return "delivered"
    case "bounced":
    case "delivery_delayed":
      return "bounced"
    case "complained":
      return "complained"
    case "opened":
      return "opened"
    case "clicked":
      return "clicked"
    case "scheduled":
      return "scheduled"
    case "cancelled":
      return "cancelled"
    default:
      return "unknown"
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as {
    Buffer?: { from: (b: Uint8Array) => { toString: (enc: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64")
  // Web API fallback (browsers, Workers, Deno).
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function request(
  fetchImpl: typeof fetch,
  endpoint: string,
  path: string,
  method: string,
  apiKey: string,
  body: unknown,
  extras?: { idempotencyKey?: string },
): Promise<Result<unknown>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  }
  if (extras?.idempotencyKey) headers["Idempotency-Key"] = extras.idempotencyKey

  let res: Response
  try {
    const init: RequestInit = { method, headers }
    if (body !== null && method !== "GET") init.body = JSON.stringify(body)
    res = await fetchImpl(`${endpoint}${path}`, init)
  } catch (err) {
    return { data: null, error: toEmailError(DRIVER, err) }
  }

  const text = await res.text()
  const parsed = text ? safeJson(text) : null

  if (!res.ok) {
    const apiError = (parsed ?? {}) as ResendApiError
    const code =
      res.status === 401 || res.status === 403
        ? "AUTH"
        : res.status === 429
          ? "RATE_LIMIT"
          : res.status >= 500
            ? "NETWORK"
            : "PROVIDER"
    return {
      data: null,
      error: createError(DRIVER, code, apiError.message ?? `HTTP ${res.status}`, {
        status: res.status,
        cause: { headers: res.headers, body: parsed ?? text },
        retryable: code === "RATE_LIMIT" || code === "NETWORK",
      }),
    }
  }

  return { data: parsed, error: null }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
