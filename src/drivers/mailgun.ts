import type { DriverFactory, EmailMessage, EmailResult, Result } from "../types.ts"
import { defineDriver } from "../_define.ts"
import { formatAddress, normalizeAddresses } from "../_normalize.ts"
import { createError, createRequiredError, toEmailError } from "../errors.ts"

export interface MailgunDriverOptions {
  apiKey: string
  domain: string
  /** Regional endpoint override: "https://api.eu.mailgun.net" for EU. */
  endpoint?: string
  fetch?: typeof fetch
}

const DRIVER = "mailgun"

const mailgun: DriverFactory<MailgunDriverOptions> = defineDriver<MailgunDriverOptions>(
  (options) => {
    if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
    if (!options?.domain) throw createRequiredError(DRIVER, "domain")
    const endpoint = options.endpoint ?? "https://api.mailgun.net"
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
      },

      async isAvailable() {
        return Boolean(options.apiKey && options.domain)
      },

      async send(msg) {
        const form = buildMailgunForm(msg)
        return mailgunRequest(
          fetchImpl,
          `${endpoint}/v3/${options.domain}/messages`,
          options.apiKey,
          form,
        )
      },
    }
  },
)

export default mailgun

function buildMailgunForm(msg: EmailMessage): FormData {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const form = new FormData()
  form.append("from", formatAddress(from))
  for (const t of normalizeAddresses(msg.to)) form.append("to", formatAddress(t))
  for (const c of normalizeAddresses(msg.cc)) form.append("cc", formatAddress(c))
  for (const b of normalizeAddresses(msg.bcc)) form.append("bcc", formatAddress(b))
  form.append("subject", msg.subject)
  if (msg.text) form.append("text", msg.text)
  if (msg.html) form.append("html", msg.html)
  for (const r of normalizeAddresses(msg.replyTo)) form.append("h:Reply-To", formatAddress(r))
  if (msg.headers) {
    for (const [k, v] of Object.entries(msg.headers)) form.append(`h:${k}`, v)
  }
  if (msg.tags?.length) {
    for (const t of msg.tags) form.append("o:tag", t.name)
  }
  if (msg.scheduledAt) {
    const d = msg.scheduledAt instanceof Date ? msg.scheduledAt : new Date(msg.scheduledAt)
    form.append("o:deliverytime", d.toUTCString())
  }
  if (msg.attachments?.length) {
    for (const a of msg.attachments) {
      const blob = new Blob(
        [typeof a.content === "string" ? a.content : (a.content as unknown as BlobPart)],
        { type: a.contentType ?? "application/octet-stream" },
      )
      form.append("attachment", blob, a.filename)
    }
  }
  return form
}

async function mailgunRequest(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  form: FormData,
): Promise<Result<EmailResult>> {
  const auth = `Basic ${basicAuth("api", apiKey)}`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: auth, accept: "application/json" },
      body: form,
    })
  } catch (err) {
    return { data: null, error: toEmailError(DRIVER, err) }
  }
  const text = await res.text()
  const parsed = text ? safeJson(text) : null
  if (!res.ok) {
    const body = (parsed ?? {}) as { message?: string }
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
      error: createError(DRIVER, code, body.message ?? `HTTP ${res.status}`, {
        status: res.status,
        retryable: code === "RATE_LIMIT" || code === "NETWORK",
        cause: { headers: res.headers, body: parsed ?? text },
      }),
    }
  }
  const body = (parsed ?? {}) as { id?: string; message?: string }
  const id = body.id ?? `mg_${Date.now().toString(36)}`
  return {
    data: {
      id: id.replace(/^<|>$/g, ""),
      driver: DRIVER,
      at: new Date(),
      provider: body as Record<string, unknown>,
    },
    error: null,
  }
}

function basicAuth(user: string, pass: string): string {
  const raw = `${user}:${pass}`
  const g = globalThis as { Buffer?: { from: (v: string) => { toString: (e: string) => string } } }
  if (g.Buffer) return g.Buffer.from(raw).toString("base64")
  return btoa(raw)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
