import type { Attachment, DriverFactory, EmailErrorCode, EmailResult, Result } from "../types.ts"
import { defineDriver } from "../_define.ts"
import { createError, createRequiredError, toEmailError } from "../errors.ts"
import { normalizeAddresses } from "../_normalize.ts"

/** Cloudflare **Email Service** (Email Sending) outbound binding.
 *
 *  Distinct from `unemail/driver/cloudflare-email`, which targets the older
 *  **Email Routing** API: that one constructs `EmailMessage` from the virtual
 *  `cloudflare:email` module and hands the binding raw RFC 5322 text. Email
 *  Service takes structured fields on the same `send_email` binding, so this
 *  driver needs no ambient global, no virtual module, and no MIME builder.
 *  Both are kept — pick the one matching the API your binding speaks.
 *
 *  ```ts
 *  export default {
 *    async fetch(req, env) {
 *      const email = createEmail({ driver: cloudflareEmailService({ binding: env.EMAIL }) })
 *      await email.send({ from, to, subject, html, text })
 *    }
 *  }
 *  ```
 *
 *  Requires a `send_email` binding in `wrangler.jsonc` and a sender domain
 *  onboarded via `wrangler email sending enable <domain>`. */
export interface CloudflareEmailServiceDriverOptions {
  binding: CloudflareEmailServiceBinding
}

export interface CloudflareEmailServiceBinding {
  send: (message: CloudflareEmailServiceMessage) => Promise<CloudflareEmailSendResult | void>
}

/** Structured payload accepted by the binding. Declared locally so the driver
 *  depends on neither `@cloudflare/workers-types` nor `cloudflare:email` —
 *  when those types are available, prefer them at the call site. */
export interface CloudflareEmailServiceMessage {
  from: { email: string; name?: string }
  to: string[]
  subject: string
  text?: string
  html?: string
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  headers?: Record<string, string>
  attachments?: CloudflareEmailServiceAttachment[]
}

export interface CloudflareEmailServiceAttachment {
  content: string | Uint8Array
  filename: string
  type?: string
  disposition?: "attachment" | "inline"
  contentId?: string
}

export interface CloudflareEmailSendResult {
  messageId?: string
}

const DRIVER = "cloudflare-email-service"

/** The binding throws `Error`s carrying an `E_*` `code`. Map them onto our
 *  taxonomy so `retryable` is meaningful — otherwise the retry middleware
 *  would keep re-sending messages that a validation fix, not a retry, cures. */
const ERROR_CODES: Record<string, EmailErrorCode> = {
  E_VALIDATION_ERROR: "INVALID_OPTIONS",
  E_FIELD_MISSING: "INVALID_OPTIONS",
  E_TOO_MANY_RECIPIENTS: "INVALID_OPTIONS",
  E_CONTENT_TOO_LARGE: "INVALID_OPTIONS",
  E_HEADER_NOT_ALLOWED: "INVALID_OPTIONS",
  E_HEADER_USE_API_FIELD: "INVALID_OPTIONS",
  E_HEADER_VALUE_INVALID: "INVALID_OPTIONS",
  E_HEADER_VALUE_TOO_LONG: "INVALID_OPTIONS",
  E_HEADER_NAME_INVALID: "INVALID_OPTIONS",
  E_HEADERS_TOO_LARGE: "INVALID_OPTIONS",
  E_HEADERS_TOO_MANY: "INVALID_OPTIONS",
  E_SENDER_NOT_VERIFIED: "AUTH",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "AUTH",
  E_RECIPIENT_NOT_ALLOWED: "AUTH",
  E_RATE_LIMIT_EXCEEDED: "RATE_LIMIT",
  E_DAILY_LIMIT_EXCEEDED: "RATE_LIMIT",
  E_DELIVERY_FAILED: "NETWORK",
  E_INTERNAL_SERVER_ERROR: "NETWORK",
}

function toDriverError(err: unknown) {
  const code = ERROR_CODES[String((err as { code?: unknown })?.code ?? "")]
  if (!code) return toEmailError(DRIVER, err)
  return createError(DRIVER, code, (err as Error).message, { cause: err })
}

/** Email Service takes structured attachments rather than MIME parts, so the
 *  mapping is a rename: `contentType` → `type`, `cid` → `contentId`. */
function toCloudflareAttachment(file: Attachment): CloudflareEmailServiceAttachment {
  return {
    content: file.content,
    filename: file.filename,
    type: file.contentType,
    disposition: file.disposition ?? (file.cid ? "inline" : "attachment"),
    contentId: file.cid,
  }
}

const cloudflareEmailService: DriverFactory<CloudflareEmailServiceDriverOptions> =
  defineDriver<CloudflareEmailServiceDriverOptions>((options) => {
    if (!options?.binding) throw createRequiredError(DRIVER, "binding")

    return {
      name: DRIVER,
      options,
      flags: {
        html: true,
        text: true,
        attachments: true,
        customHeaders: true,
        replyTo: true,
      },

      async isAvailable() {
        return true
      },

      async send(msg): Promise<Result<EmailResult>> {
        try {
          const from = normalizeAddresses(msg.from)[0]
          const to = normalizeAddresses(msg.to).map((addr) => addr.email)
          if (!from || !to.length)
            return {
              data: null,
              error: createError(DRIVER, "INVALID_OPTIONS", "`from` and `to` are required"),
            }

          const cc = normalizeAddresses(msg.cc).map((addr) => addr.email)
          const bcc = normalizeAddresses(msg.bcc).map((addr) => addr.email)
          const replyTo = normalizeAddresses(msg.replyTo)[0]

          const result = await options.binding.send({
            from: { email: from.email, name: from.name },
            to,
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
            cc: cc.length ? cc : undefined,
            bcc: bcc.length ? bcc : undefined,
            replyTo: replyTo?.email,
            headers: msg.headers,
            attachments: msg.attachments?.length
              ? msg.attachments.map(toCloudflareAttachment)
              : undefined,
          })

          return {
            data: {
              id: result?.messageId ?? "",
              driver: DRIVER,
              at: new Date(),
            },
            error: null,
          }
        } catch (err) {
          return { data: null, error: toDriverError(err) }
        }
      },
    }
  })

export default cloudflareEmailService
