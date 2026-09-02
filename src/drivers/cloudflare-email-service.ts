import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailErrorCode,
  EmailResult,
  Result,
} from "../core/types.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError, toEmailError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"

export interface CloudflareEmailServiceOptions {
  binding: CloudflareEmailServiceBinding
}

export interface CloudflareEmailServiceBinding {
  send: (message: CloudflareEmailServiceMessage) => Promise<CloudflareEmailSendResult | void>
}

/** The structured payload the binding accepts. Declared here so the driver
 *  needs neither `@cloudflare/workers-types` nor the `cloudflare:email`
 *  virtual module; prefer those types at the call site when you have them. */
export interface CloudflareEmailServiceMessage {
  from: EmailAddress
  to: EmailAddress[]
  subject: string
  text?: string
  html?: string
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  replyTo?: EmailAddress
  headers?: Record<string, string>
  attachments?: CloudflareEmailServiceAttachment[]
}

export interface CloudflareEmailServiceAttachment {
  content: string | Uint8Array
  filename: string
  type: string
  disposition: "attachment" | "inline"
  contentId?: string
}

export interface CloudflareEmailSendResult {
  messageId?: string
}

const DRIVER = "cloudflare-email-service"
/** Combined across `to`, `cc` and `bcc`. */
const RECIPIENT_LIMIT = 50
const ATTACHMENT_LIMIT = 32

/** The binding throws `Error`s carrying an `E_*` `code`. Mapping them onto
 *  our taxonomy is what makes `retryable` mean anything — otherwise the
 *  retry middleware would keep re-sending a message that a validation fix,
 *  not a retry, would cure. */
const ERROR_CODES: Record<string, EmailErrorCode> = {
  E_VALIDATION_ERROR: "INVALID_OPTIONS",
  E_FIELD_MISSING: "INVALID_OPTIONS",
  E_TOO_MANY_RECIPIENTS: "INVALID_OPTIONS",
  E_TOO_MANY_ATTACHMENTS: "INVALID_OPTIONS",
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
  E_RECIPIENT_SUPPRESSED: "PROVIDER",
  E_RATE_LIMIT_EXCEEDED: "RATE_LIMIT",
  E_DAILY_LIMIT_EXCEEDED: "RATE_LIMIT",
  E_DELIVERY_FAILED: "NETWORK",
  E_INTERNAL_SERVER_ERROR: "NETWORK",
}

/**
 * Cloudflare **Email Service** (Email Sending), over the `send_email`
 * binding.
 *
 * Not the same as `unemail/drivers/cloudflare-email`, which targets the
 * older Email Routing API: that one hands the binding raw RFC 5322 text,
 * while Email Service takes structured fields. So this driver needs no
 * ambient global, no virtual module and no MIME builder. Both ship — pick
 * the one matching the API your binding speaks.
 *
 * Needs a `send_email` binding in `wrangler.jsonc` and a sender domain
 * onboarded with `wrangler email sending enable <domain>`.
 *
 * Limits it enforces before the call: 50 recipients across to/cc/bcc, and
 * 32 attachments. The binding also caps a message at 5 MiB, which only it
 * can measure.
 *
 * ```ts
 * export default {
 *   async fetch(request, env) {
 *     const email = createEmail({
 *       driver: cloudflareEmailService({ binding: env.EMAIL }),
 *       defaults: { from: "hi@acme.com" },
 *     })
 *     return Response.json(await email.send({ to, subject, html }))
 *   },
 * }
 * ```
 */
const cloudflareEmailService: DriverFactory<CloudflareEmailServiceOptions> =
  defineDriver<CloudflareEmailServiceOptions>((options) => {
    if (!options?.binding) throw createRequiredError(DRIVER, "binding")

    return {
      name: DRIVER,
      features: {
        html: true,
        text: true,
        attachments: true,
        customHeaders: true,
        replyTo: true,
      },

      isAvailable: () => true,

      async send(msg): Promise<Result<EmailResult>> {
        // Checked here rather than left to E_TOO_MANY_RECIPIENTS: the
        // binding's error names the code, not the number, and it costs a
        // round trip to find out.
        const recipients = msg.to.length + msg.cc.length + msg.bcc.length
        if (recipients > RECIPIENT_LIMIT) {
          return err(
            createError(
              DRIVER,
              "INVALID_OPTIONS",
              `${recipients} recipients across to/cc/bcc; the limit is ${RECIPIENT_LIMIT}`,
            ),
          )
        }
        if (msg.attachments.length > ATTACHMENT_LIMIT) {
          return err(
            createError(
              DRIVER,
              "INVALID_OPTIONS",
              `${msg.attachments.length} attachments; the limit is ${ATTACHMENT_LIMIT}`,
            ),
          )
        }

        let result: CloudflareEmailSendResult | void
        try {
          result = await options.binding.send({
            from: msg.from,
            to: [...msg.to],
            subject: msg.subject ?? "",
            ...(msg.text == null ? {} : { text: msg.text }),
            ...(msg.html == null ? {} : { html: msg.html }),
            ...(msg.cc.length > 0 ? { cc: [...msg.cc] } : {}),
            ...(msg.bcc.length > 0 ? { bcc: [...msg.bcc] } : {}),
            ...(msg.replyTo[0] ? { replyTo: msg.replyTo[0] } : {}),
            ...(Object.keys(msg.headers).length > 0 ? { headers: { ...msg.headers } } : {}),
            ...(msg.attachments.length > 0
              ? { attachments: msg.attachments.map(toCloudflareAttachment) }
              : {}),
          })
        } catch (error) {
          return err(toDriverError(error))
        }

        if (!result?.messageId) {
          return err(
            createError(DRIVER, "PROVIDER", "the binding returned no messageId", { cause: result }),
          )
        }
        return ok({
          id: result.messageId,
          driver: DRIVER,
          ...(msg.stream ? { stream: msg.stream } : {}),
          at: new Date(),
          provider: result as Record<string, unknown>,
        })
      },
    }
  })

export default cloudflareEmailService

function toDriverError(error: unknown) {
  const code = ERROR_CODES[String((error as { code?: unknown })?.code ?? "")]
  if (!code) return toEmailError(DRIVER, error)
  return createError(DRIVER, code, (error as Error).message, { cause: error })
}

/** Email Service takes structured attachments rather than MIME parts, so
 *  the mapping is mostly a rename: `contentType` → `type`, `cid` →
 *  `contentId`. `content` is base64 either way — passing a text string
 *  through unencoded is what corrupted attachments in #116. */
function toCloudflareAttachment(file: Attachment): CloudflareEmailServiceAttachment {
  return {
    content: attachmentToBase64(file),
    filename: file.filename,
    type: file.contentType ?? "application/octet-stream",
    disposition: file.disposition ?? (file.cid ? "inline" : "attachment"),
    ...(file.cid ? { contentId: file.cid } : {}),
  }
}
