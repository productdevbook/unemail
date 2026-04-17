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
import { createError } from "../errors.ts"
import { httpJson } from "./_http.ts"

/** MailChannels — free transactional send from Cloudflare Workers (no auth
 *  needed when running inside a CF Worker; requires SPF/DKIM configured
 *  for your sending domain). Outside Workers you need an API key. */
export interface MailChannelsDriverOptions {
  /** Required when not running inside a Cloudflare Worker. */
  apiKey?: string
  /** DKIM signing for non-Worker usage. */
  dkim?: {
    domain: string
    selector: string
    privateKey: string
  }
  endpoint?: string
  fetch?: typeof fetch
}

const DRIVER = "mailchannels"

const mailchannels: DriverFactory<MailChannelsDriverOptions> =
  defineDriver<MailChannelsDriverOptions>((options = {}) => {
    const endpoint = options.endpoint ?? "https://api.mailchannels.net"
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== "function")
      throw createError(DRIVER, "INVALID_OPTIONS", "fetch is unavailable; pass `fetch` explicitly")

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
        const payload = buildMailChannelsPayload(msg, options)
        const headers: Record<string, string> = {}
        if (options.apiKey) headers["x-api-key"] = options.apiKey
        const res = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: `${endpoint}/tx/v1/send`,
          headers,
          body: payload,
        })
        if (res.error) return res as Result<EmailResult>
        return {
          data: {
            id: `mc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            driver: DRIVER,
            at: new Date(),
            provider: (res.data as Record<string, unknown> | null) ?? undefined,
          },
          error: null,
        }
      },
    }
  })

export default mailchannels

function buildMailChannelsPayload(
  msg: EmailMessage,
  options: MailChannelsDriverOptions,
): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const personalization: Record<string, unknown> = {
    to: normalizeAddresses(msg.to).map(toMcAddress),
  }
  if (msg.cc) personalization.cc = normalizeAddresses(msg.cc).map(toMcAddress)
  if (msg.bcc) personalization.bcc = normalizeAddresses(msg.bcc).map(toMcAddress)
  if (msg.headers) personalization.headers = msg.headers
  if (options.dkim) {
    personalization.dkim_domain = options.dkim.domain
    personalization.dkim_selector = options.dkim.selector
    personalization.dkim_private_key = options.dkim.privateKey
  }

  const content: Array<Record<string, string>> = []
  if (msg.text) content.push({ type: "text/plain", value: msg.text })
  if (msg.html) content.push({ type: "text/html", value: msg.html })

  const payload: Record<string, unknown> = {
    personalizations: [personalization],
    from: toMcAddress(from),
    subject: msg.subject,
    content,
  }
  if (msg.replyTo) {
    const r = normalizeAddresses(msg.replyTo)[0]
    if (r) payload.reply_to = toMcAddress(r)
  }
  if (msg.attachments?.length) payload.attachments = msg.attachments.map(toMcAttachment)
  return payload
}

function toMcAddress(a: EmailAddress): Record<string, string> {
  return a.name ? { email: a.email, name: a.name } : { email: a.email }
}

function toMcAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  return {
    filename: a.filename,
    content,
    type: a.contentType ?? "application/octet-stream",
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
