import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailMessage,
  EmailResult,
  Result,
} from "../types.ts"
import { defineDriver } from "../_define.ts"
import { formatAddress, normalizeAddresses } from "../_normalize.ts"
import { createError, createRequiredError } from "../errors.ts"
import { httpJson } from "./_http.ts"

/** Options for the generic `http` driver — useful for proxying through
 *  your own endpoint (a Next.js route handler, a hosted worker, a test
 *  harness, anything JSON-shaped). */
export interface HttpDriverOptions {
  /** The POST target. */
  endpoint: string
  /** HTTP method. Defaults to POST. */
  method?: string
  /** Bearer token sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string
  /** Extra headers merged on every request. */
  headers?: Record<string, string>
  /** Transform the normalized message into the payload shape your API
   *  expects. The default emits a sensible object similar to Resend's
   *  public shape. */
  transform?: (msg: EmailMessage) => unknown
  /** Extract the provider-assigned id from the response body. Default:
   *  looks at \`id\`, \`messageId\`, \`data.id\`, \`data.messageId\`. */
  extractId?: (body: unknown) => string | null
  /** Injected fetch — defaults to global \`fetch\`. */
  fetch?: typeof fetch
}

const DRIVER = "http"

const http: DriverFactory<HttpDriverOptions> = defineDriver<HttpDriverOptions>((options) => {
  if (!options?.endpoint) throw createRequiredError(DRIVER, "endpoint")
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function")
    throw createError(DRIVER, "INVALID_OPTIONS", "fetch is unavailable; pass `fetch` explicitly")

  const transform = options.transform ?? defaultTransform
  const extractId = options.extractId ?? defaultExtractId

  return {
    name: DRIVER,
    options,
    flags: {
      html: true,
      text: true,
      attachments: true,
      replyTo: true,
      customHeaders: true,
    },

    async isAvailable() {
      return true
    },

    async send(msg) {
      const payload = transform(msg)
      const headers: Record<string, string> = { ...options.headers }
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
      const res = await httpJson({
        fetch: fetchImpl,
        driver: DRIVER,
        url: options.endpoint,
        method: options.method ?? "POST",
        headers,
        body: payload,
      })
      if (res.error) return res as Result<EmailResult>
      const id = extractId(res.data) ?? synthId()
      return {
        data: {
          id,
          driver: DRIVER,
          at: new Date(),
          provider: (res.data ?? null) as Record<string, unknown> | undefined,
        },
        error: null,
      }
    },
  }
})

export default http

function defaultTransform(msg: EmailMessage): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  const out: Record<string, unknown> = {
    from: from ? formatAddress(from) : undefined,
    to: normalizeAddresses(msg.to).map((a: EmailAddress) => formatAddress(a)),
    subject: msg.subject,
  }
  if (msg.cc) out.cc = normalizeAddresses(msg.cc).map(formatAddress)
  if (msg.bcc) out.bcc = normalizeAddresses(msg.bcc).map(formatAddress)
  if (msg.replyTo) out.replyTo = normalizeAddresses(msg.replyTo).map(formatAddress)
  if (msg.text) out.text = msg.text
  if (msg.html) out.html = msg.html
  if (msg.headers) out.headers = msg.headers
  if (msg.attachments?.length) out.attachments = msg.attachments.map(toAttachmentPayload)
  return out
}

function toAttachmentPayload(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  const out: Record<string, unknown> = {
    filename: a.filename,
    content,
  }
  if (a.contentType) out.contentType = a.contentType
  if (a.disposition) out.disposition = a.disposition
  if (a.cid) out.cid = a.cid
  return out
}

function defaultExtractId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const r = body as Record<string, unknown>
  if (typeof r.id === "string") return r.id
  if (typeof r.messageId === "string") return r.messageId
  if (r.data && typeof r.data === "object") {
    const inner = r.data as Record<string, unknown>
    if (typeof inner.id === "string") return inner.id
    if (typeof inner.messageId === "string") return inner.messageId
  }
  return null
}

function synthId(): string {
  return `http_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as {
    Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
