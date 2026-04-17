import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailMessage,
  EmailResult,
  Result,
} from "../types.ts"
import { defineDriver } from "../_define.ts"
import { normalizeAddresses } from "../_normalize.ts"
import { createError, createRequiredError } from "../errors.ts"
import { httpJson } from "./_http.ts"

/** Options for the Zeptomail driver. The token **must** be prefixed with
 *  \`Zoho-enczapikey \` per Zeptomail's auth format. */
export interface ZeptomailDriverOptions {
  /** Full token including the \`Zoho-enczapikey \` prefix. */
  token: string
  endpoint?: string
  fetch?: typeof fetch
  trackClicks?: boolean
  trackOpens?: boolean
}

const DRIVER = "zeptomail"
const DEFAULT_ENDPOINT = "https://api.zeptomail.com/v1.1"

const zeptomail: DriverFactory<ZeptomailDriverOptions> = defineDriver<ZeptomailDriverOptions>(
  (options) => {
    if (!options?.token) throw createRequiredError(DRIVER, "token")
    if (!options.token.startsWith("Zoho-enczapikey "))
      throw createError(DRIVER, "INVALID_OPTIONS", "token must start with 'Zoho-enczapikey '")

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
        tracking: true,
        replyTo: true,
        customHeaders: true,
      },

      async isAvailable() {
        return Boolean(options.token)
      },

      async send(msg) {
        const payload = buildPayload(msg, options)
        const res = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: `${endpoint}/email`,
          headers: { authorization: options.token },
          body: payload,
        })
        if (res.error) return res as Result<EmailResult>
        const body = (res.data ?? {}) as { data?: Array<{ message_id?: string }>; message?: string }
        const id = body.data?.[0]?.message_id ?? `zepto_${Date.now().toString(36)}`
        return {
          data: {
            id,
            driver: DRIVER,
            at: new Date(),
            provider: body as unknown as Record<string, unknown>,
          },
          error: null,
        }
      },
    }
  },
)

export default zeptomail

function buildPayload(msg: EmailMessage, options: ZeptomailDriverOptions): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const payload: Record<string, unknown> = {
    from: toAddress(from),
    to: normalizeAddresses(msg.to).map(toRecipient),
    subject: msg.subject,
  }
  if (msg.cc) payload.cc = normalizeAddresses(msg.cc).map(toRecipient)
  if (msg.bcc) payload.bcc = normalizeAddresses(msg.bcc).map(toRecipient)
  if (msg.replyTo) payload.reply_to = normalizeAddresses(msg.replyTo).map(toAddress)
  if (msg.text) payload.textbody = msg.text
  if (msg.html) payload.htmlbody = msg.html
  if (msg.headers) payload.mime_headers = msg.headers
  if (msg.attachments?.length) payload.attachments = msg.attachments.map(toZeptoAttachment)
  if (options.trackClicks) payload.track_clicks = true
  if (options.trackOpens) payload.track_opens = true
  if (msg.template) {
    if (msg.template.id) payload.template_key = msg.template.id
    if (msg.template.alias) payload.template_alias = msg.template.alias
    if (msg.template.variables) payload.merge_info = { ...msg.template.variables }
  }
  return payload
}

function toAddress(a: EmailAddress): Record<string, string> {
  return a.name ? { address: a.email, name: a.name } : { address: a.email }
}

function toRecipient(a: EmailAddress): Record<string, unknown> {
  return { email_address: toAddress(a) }
}

function toZeptoAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  return {
    name: a.filename,
    content,
    mime_type: a.contentType ?? "application/octet-stream",
  }
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
