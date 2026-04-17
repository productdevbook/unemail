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

export interface BrevoDriverOptions {
  apiKey: string
  endpoint?: string
  fetch?: typeof fetch
}

const DRIVER = "brevo"

const brevo: DriverFactory<BrevoDriverOptions> = defineDriver<BrevoDriverOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  const endpoint = options.endpoint ?? "https://api.brevo.com"
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
      tagging: true,
      tracking: true,
      replyTo: true,
      customHeaders: true,
      scheduling: true,
      templates: true,
    },

    async isAvailable() {
      return Boolean(options.apiKey)
    },

    async send(msg) {
      const payload = buildBrevoPayload(msg)
      const res = await httpJson({
        fetch: fetchImpl,
        driver: DRIVER,
        url: `${endpoint}/v3/smtp/email`,
        headers: { "api-key": options.apiKey },
        body: payload,
      })
      if (res.error) return res as Result<EmailResult>
      const body = (res.data ?? {}) as { messageId?: string }
      return {
        data: {
          id: body.messageId ?? `brevo_${Date.now().toString(36)}`,
          driver: DRIVER,
          at: new Date(),
          provider: body as Record<string, unknown>,
        },
        error: null,
      }
    },
  }
})

export default brevo

function buildBrevoPayload(msg: EmailMessage): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const payload: Record<string, unknown> = {
    sender: toBrevoAddress(from),
    to: normalizeAddresses(msg.to).map(toBrevoAddress),
    subject: msg.subject,
  }
  if (msg.cc) payload.cc = normalizeAddresses(msg.cc).map(toBrevoAddress)
  if (msg.bcc) payload.bcc = normalizeAddresses(msg.bcc).map(toBrevoAddress)
  if (msg.replyTo) {
    const r = normalizeAddresses(msg.replyTo)[0]
    if (r) payload.replyTo = toBrevoAddress(r)
  }
  if (msg.text) payload.textContent = msg.text
  if (msg.html) payload.htmlContent = msg.html
  if (msg.headers) payload.headers = msg.headers
  if (msg.tags?.length) payload.tags = msg.tags.map((t) => t.name)
  if (msg.scheduledAt) {
    const d = msg.scheduledAt instanceof Date ? msg.scheduledAt : new Date(msg.scheduledAt)
    payload.scheduledAt = d.toISOString()
  }
  if (msg.attachments?.length) payload.attachment = msg.attachments.map(toBrevoAttachment)
  return payload
}

function toBrevoAddress(a: EmailAddress): Record<string, string> {
  return a.name ? { email: a.email, name: a.name } : { email: a.email }
}

function toBrevoAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  return { name: a.filename, content }
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
