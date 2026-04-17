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

export interface SendGridDriverOptions {
  apiKey: string
  endpoint?: string
  fetch?: typeof fetch
  /** Set X-Smtpapi IP pool. Optional. */
  ipPoolName?: string
  /** SendGrid dynamic template id — can also come on the message via \`headers["x-template-id"]\`. */
  templateId?: string
}

const DRIVER = "sendgrid"

const sendgrid: DriverFactory<SendGridDriverOptions> = defineDriver<SendGridDriverOptions>(
  (options) => {
    if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
    const endpoint = options.endpoint ?? "https://api.sendgrid.com"
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
        templates: true,
        tagging: true,
        tracking: true,
        replyTo: true,
        customHeaders: true,
        scheduling: true,
      },

      async isAvailable() {
        return Boolean(options.apiKey)
      },

      async send(msg) {
        const payload = buildSendGridPayload(msg, options)
        const res = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: `${endpoint}/v3/mail/send`,
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: payload,
        })
        if (res.error) return res as Result<EmailResult>
        // SendGrid returns 202 Accepted with empty body and the message id in the header.
        return {
          data: {
            id: `sg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            driver: DRIVER,
            at: new Date(),
            provider: (res.data as Record<string, unknown> | null) ?? undefined,
          },
          error: null,
        }
      },
    }
  },
)

export default sendgrid

function buildSendGridPayload(
  msg: EmailMessage,
  options: SendGridDriverOptions,
): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const personalization: Record<string, unknown> = {
    to: normalizeAddresses(msg.to).map(toSgAddress),
  }
  if (msg.cc) personalization.cc = normalizeAddresses(msg.cc).map(toSgAddress)
  if (msg.bcc) personalization.bcc = normalizeAddresses(msg.bcc).map(toSgAddress)
  if (msg.scheduledAt) {
    const seconds = Math.floor(toDate(msg.scheduledAt).getTime() / 1000)
    personalization.send_at = seconds
  }

  const payload: Record<string, unknown> = {
    personalizations: [personalization],
    from: toSgAddress(from),
    subject: msg.subject,
    content: buildContent(msg),
  }
  if (msg.replyTo) {
    const replyTo = normalizeAddresses(msg.replyTo)[0]
    if (replyTo) payload.reply_to = toSgAddress(replyTo)
  }
  if (msg.attachments?.length) payload.attachments = msg.attachments.map(toSgAttachment)
  if (msg.headers) payload.headers = msg.headers
  if (msg.tags?.length) payload.categories = msg.tags.map((t) => t.name)
  if (options.templateId) payload.template_id = options.templateId
  if (options.ipPoolName) payload.ip_pool_name = options.ipPoolName
  return payload
}

function buildContent(msg: EmailMessage): Array<{ type: string; value: string }> {
  const content: Array<{ type: string; value: string }> = []
  if (msg.text) content.push({ type: "text/plain", value: msg.text })
  if (msg.html) content.push({ type: "text/html", value: msg.html })
  return content
}

function toSgAddress(a: EmailAddress): Record<string, string> {
  return a.name ? { email: a.email, name: a.name } : { email: a.email }
}

function toSgAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  const out: Record<string, unknown> = {
    filename: a.filename,
    content,
    type: a.contentType ?? "application/octet-stream",
  }
  if (a.disposition) out.disposition = a.disposition
  if (a.cid) {
    out.content_id = a.cid
    out.disposition = "inline"
  }
  return out
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value)
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
