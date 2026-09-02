import type { DriverFactory, EmailResult, Result } from "../core/types.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError, toEmailError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { buildMime, resolveMessageId, toMimeInput } from "./_mime.ts"

/** The `send_email` binding Workers injects from your `wrangler.toml`. */
export interface CloudflareEmailBinding {
  send: (message: unknown) => Promise<void> | void
}

/** `import { EmailMessage } from "cloudflare:email"`. */
export type CloudflareEmailMessageCtor = new (from: string, to: string, raw: string) => unknown

export interface CloudflareEmailOptions {
  binding: CloudflareEmailBinding
  /** `import { EmailMessage } from "cloudflare:email"` and pass it here.
   *  That specifier is a Workers virtual module, so this package cannot
   *  import it itself and still run on Node. Falls back to
   *  `globalThis.EmailMessage` for runtimes that expose it. */
  EmailMessage?: CloudflareEmailMessageCtor
}

const DRIVER = "cloudflare-email"

/**
 * Cloudflare Email Routing's outbound binding.
 *
 * The binding takes a raw RFC 5322 document, which the shared MIME builder
 * produces — so attachments and inline images work here as they do over
 * SMTP, without a network call of our own.
 *
 * ```ts
 * export default {
 *   async fetch(request, env) {
 *     const email = createEmail({
 *       driver: cloudflareEmail({ binding: env.SEND_EMAIL }),
 *       defaults: { from: "hi@acme.com" },
 *     })
 *     return Response.json(await email.send({ to, subject, text }))
 *   },
 * }
 * ```
 *
 * The legacy `EmailMessage(from, to, raw)` constructor takes a single
 * envelope recipient, so `to` must hold exactly one address and `cc`/`bcc`
 * are refused rather than dropped. Use
 * `unemail/drivers/cloudflare-email-service` for several recipients, or for
 * anything new — Cloudflare keeps this API for compatibility only.
 */
const cloudflareEmail: DriverFactory<CloudflareEmailOptions> = defineDriver<CloudflareEmailOptions>(
  (options) => {
    if (!options?.binding) throw createRequiredError(DRIVER, "binding")
    const Ctor =
      options.EmailMessage ??
      (globalThis as { EmailMessage?: CloudflareEmailMessageCtor }).EmailMessage
    if (!Ctor) {
      throw createError(
        DRIVER,
        "INVALID_OPTIONS",
        'no `EmailMessage` constructor — pass one: import { EmailMessage } from "cloudflare:email"',
      )
    }

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
        // The constructor's `to` is one envelope address. Silently sending
        // to only the first would look like a delivery that worked.
        if (msg.to.length > 1 || msg.cc.length > 0 || msg.bcc.length > 0) {
          return err(
            createError(
              DRIVER,
              "INVALID_OPTIONS",
              "the legacy binding takes one recipient per call — use cloudflare-email-service, or send one message per address",
            ),
          )
        }

        const messageId = resolveMessageId(msg, "cloudflare-email")
        try {
          const mime = buildMime(toMimeInput(msg, messageId))
          await options.binding.send(new Ctor(msg.from.email, msg.to[0]!.email, mime.body))
        } catch (error) {
          return err(toEmailError(DRIVER, error))
        }

        return ok({
          id: messageId,
          driver: DRIVER,
          ...(msg.stream ? { stream: msg.stream } : {}),
          at: new Date(),
        })
      },
    }
  },
)

export default cloudflareEmail
