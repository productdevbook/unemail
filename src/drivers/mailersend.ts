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

export interface MailerSendDriverOptions {
  apiKey: string
  endpoint?: string
  fetch?: typeof fetch
}

const DRIVER = "mailersend"

const mailersend: DriverFactory<MailerSendDriverOptions> = defineDriver<MailerSendDriverOptions>(
  (options) => {
    if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
    const endpoint = options.endpoint ?? "https://api.mailersend.com"
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
        batch: true,
      },

      async isAvailable() {
        return Boolean(options.apiKey)
      },

      async send(msg) {
        const payload = buildMailerSendPayload(msg)
        const res = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: `${endpoint}/v1/email`,
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: payload,
        })
        if (res.error) return res as Result<EmailResult>
        // MailerSend returns 202 with `X-Message-Id` header; body is empty.
        const id = `ms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        return {
          data: {
            id,
            driver: DRIVER,
            at: new Date(),
            provider: (res.data as Record<string, unknown> | null) ?? undefined,
          },
          error: null,
        }
      },

      async sendBatch(msgs) {
        const payload = msgs.map(buildMailerSendPayload)
        const res = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: `${endpoint}/v1/bulk-email`,
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: payload,
        })
        if (res.error) return res as never
        const body = (res.data ?? {}) as { bulk_email_id?: string }
        const results: EmailResult[] = msgs.map((_, i) => ({
          id: `${body.bulk_email_id ?? "ms_bulk"}_${i}`,
          driver: DRIVER,
          at: new Date(),
          provider: body as Record<string, unknown>,
        }))
        return { data: results, error: null }
      },
    }
  },
)

export default mailersend

function buildMailerSendPayload(msg: EmailMessage): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const payload: Record<string, unknown> = {
    from: toMsAddress(from),
    to: normalizeAddresses(msg.to).map(toMsAddress),
    subject: msg.subject,
  }
  if (msg.cc) payload.cc = normalizeAddresses(msg.cc).map(toMsAddress)
  if (msg.bcc) payload.bcc = normalizeAddresses(msg.bcc).map(toMsAddress)
  if (msg.replyTo) {
    const r = normalizeAddresses(msg.replyTo)[0]
    if (r) payload.reply_to = toMsAddress(r)
  }
  if (msg.text) payload.text = msg.text
  if (msg.html) payload.html = msg.html
  if (msg.tags?.length) payload.tags = msg.tags.map((t) => t.name)
  if (msg.headers)
    payload.headers = Object.entries(msg.headers).map(([name, value]) => ({ name, value }))
  if (msg.scheduledAt) {
    const d = msg.scheduledAt instanceof Date ? msg.scheduledAt : new Date(msg.scheduledAt)
    payload.send_at = Math.floor(d.getTime() / 1000)
  }
  if (msg.attachments?.length) payload.attachments = msg.attachments.map(toMsAttachment)
  return payload
}

function toMsAddress(a: EmailAddress): Record<string, string> {
  return a.name ? { email: a.email, name: a.name } : { email: a.email }
}

function toMsAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  const out: Record<string, unknown> = {
    filename: a.filename,
    content,
    disposition: a.disposition ?? "attachment",
  }
  if (a.cid) out.id = a.cid
  return out
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
