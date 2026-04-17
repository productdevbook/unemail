import type { DriverFactory, EmailMessage, EmailResult, Result } from "../types.ts"
import { defineDriver } from "../_define.ts"
import { buildMime, normalizeMimeInput } from "./_smtp/mime.ts"
import { createError, createRequiredError, toEmailError } from "../errors.ts"
import { normalizeAddresses } from "../_normalize.ts"

/** Cloudflare Email Workers outbound binding. Instantiate with the binding
 *  object defined in your \`wrangler.toml\` (\`send_email\` rule):
 *
 *  ```ts
 *  export default {
 *    async fetch(req, env) {
 *      const email = createEmail({ driver: cloudflareEmail({ binding: env.SEND_EMAIL }) })
 *      await email.send({ from, to, subject, text })
 *    }
 *  }
 *  ```
 *
 *  The binding accepts a constructed \`EmailMessage\` (see Cloudflare docs —
 *  the SDK exposes \`new EmailMessage(from, to, raw)\` via the global
 *  \`postalmime\` bindings); we build raw RFC 5322 text ourselves. */
export interface CloudflareEmailDriverOptions {
  binding: CloudflareEmailBinding
  /** Optional factory for the \`EmailMessage\` class. Defaults to
   *  \`globalThis.EmailMessage\`, which Workers injects at runtime. */
  EmailMessage?: CloudflareEmailMessageCtor
}

export interface CloudflareEmailBinding {
  send: (message: unknown) => Promise<void> | void
}

export type CloudflareEmailMessageCtor = new (from: string, to: string, raw: string) => unknown

const DRIVER = "cloudflare-email"

const cloudflareEmail: DriverFactory<CloudflareEmailDriverOptions> =
  defineDriver<CloudflareEmailDriverOptions>((options) => {
    if (!options?.binding) throw createRequiredError(DRIVER, "binding")
    const Ctor =
      options.EmailMessage ??
      (globalThis as { EmailMessage?: CloudflareEmailMessageCtor }).EmailMessage
    if (!Ctor)
      throw createError(
        DRIVER,
        "INVALID_OPTIONS",
        "EmailMessage constructor is unavailable; pass it via options when not running on Cloudflare Workers",
      )

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
          const to = normalizeAddresses(msg.to)[0]
          if (!from || !to)
            return {
              data: null,
              error: createError(DRIVER, "INVALID_OPTIONS", "`from` and `to` are required"),
            }
          const messageId =
            msg.headers?.["Message-ID"] ??
            `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@cloudflare-email>`
          const mime = buildMime(normalizeMimeInput(msg, messageId))
          const message = new Ctor(from.email, to.email, mime.body)
          await options.binding.send(message)
          return {
            data: {
              id: messageId,
              driver: DRIVER,
              at: new Date(),
            },
            error: null,
          }
        } catch (err) {
          return { data: null, error: toEmailError(DRIVER, err) }
        }
      },
    }
  })

export default cloudflareEmail
