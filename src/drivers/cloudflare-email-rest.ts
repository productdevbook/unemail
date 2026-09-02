import type { DriverFactory, EmailAddress, EmailResult, NormalizedMessage } from "../core/types.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface CloudflareEmailRestOptions {
  /** Cloudflare account id. */
  accountId: string
  /** API token with email-sending permission. */
  apiToken: string
  /** Override the API base — for a gateway or a test stub. */
  endpoint?: string
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Abort a request after this long, in milliseconds. Default: 30_000. */
  timeoutMs?: number
}

/** What the REST API answers with. Unlike the Workers binding, which
 *  returns one `messageId`, this groups the outcome by recipient. */
export interface CloudflareEmailRestResult {
  delivered?: string[]
  permanent_bounces?: string[]
  queued?: string[]
}

const DRIVER = "cloudflare-email-rest"
const DEFAULT_ENDPOINT = "https://api.cloudflare.com/client/v4"
/** Combined across `to`, `cc` and `bcc`. */
const RECIPIENT_LIMIT = 50
const ATTACHMENT_LIMIT = 32

/** Cloudflare's numeric API error codes, which the REST surface uses in
 *  place of the binding's `E_*` strings. */
const ERROR_CODES: Record<number, "INVALID_OPTIONS" | "AUTH" | "RATE_LIMIT" | "NETWORK"> = {
  10001: "INVALID_OPTIONS",
  10200: "INVALID_OPTIONS",
  10101: "AUTH",
  10102: "AUTH",
  10004: "RATE_LIMIT",
  10002: "NETWORK",
}

/**
 * Cloudflare Email Service over its REST API.
 *
 * The same service as `unemail/drivers/cloudflare-email-service`, reached
 * over HTTP with an API token instead of through a Worker binding — so it
 * runs on Node, Deno, Bun, or anywhere else with `fetch`. Use the binding
 * when you are inside a Worker; it is one less hop and needs no token.
 *
 * ```ts
 * createEmail({
 *   driver: cloudflareEmailRest({ accountId, apiToken: process.env.CF_API_TOKEN! }),
 *   defaults: { from: "hi@acme.com" },
 * })
 * ```
 *
 * Reports per-recipient outcomes, so a message accepted for some addresses
 * and permanently bounced for others is a failure naming which — the id it
 * returns is synthesized from the delivered set, because the REST API does
 * not hand back a message id at all.
 */
const cloudflareEmailRest: DriverFactory<CloudflareEmailRestOptions> =
  defineDriver<CloudflareEmailRestOptions>((options) => {
    if (!options?.accountId) throw createRequiredError(DRIVER, "accountId")
    if (!options.apiToken) throw createRequiredError(DRIVER, "apiToken")

    const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
    const fetchImpl = resolveFetch(DRIVER, options.fetch)

    return {
      name: DRIVER,
      features: {
        html: true,
        text: true,
        attachments: true,
        customHeaders: true,
        replyTo: true,
      },

      isAvailable: () => Boolean(options.apiToken),

      async send(msg, ctx) {
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

        const response = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: `${endpoint}/accounts/${encodeURIComponent(options.accountId)}/email/sending/send`,
          headers: { authorization: `Bearer ${options.apiToken}` },
          body: toPayload(msg),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
          classify(status, parsed) {
            const first = (parsed as { errors?: { code?: number; message?: string }[] } | null)
              ?.errors?.[0]
            const code = first?.code == null ? undefined : ERROR_CODES[first.code]
            return {
              code: code ?? classifyStatus(status),
              ...(first?.message ? { message: first.message } : {}),
            }
          },
        })
        if (response.error) return err(response.error)

        const body = (response.data ?? {}) as {
          success?: boolean
          errors?: { message?: string }[]
          result?: CloudflareEmailRestResult
        }
        // Cloudflare answers 200 with `success: false` for a request it
        // parsed but would not act on, so the status alone is not enough.
        if (body.success === false) {
          return err(
            createError(DRIVER, "PROVIDER", body.errors?.[0]?.message ?? "send failed", {
              retryable: false,
              cause: body,
            }),
          )
        }

        const result = body.result ?? {}
        const bounced = result.permanent_bounces ?? []
        const accepted = [...(result.delivered ?? []), ...(result.queued ?? [])]
        if (accepted.length === 0) {
          return err(
            createError(
              DRIVER,
              "PROVIDER",
              bounced.length > 0
                ? `permanently bounced for every recipient: ${bounced.join(", ")}`
                : "no recipient was accepted",
              { retryable: false, cause: body },
            ),
          )
        }
        if (bounced.length > 0) {
          // Reporting this as a success would hide addresses that will
          // never receive it, however many others did.
          return err(
            createError(
              DRIVER,
              "PROVIDER",
              `permanently bounced for ${bounced.join(", ")}; delivered to the rest`,
              { retryable: false, cause: body },
            ),
          )
        }

        const id = ((): string => {
          const messageId = msg.headers["Message-ID"] ?? msg.headers["message-id"]
          return messageId ?? `cf_${accepted.join(",")}_${Date.now().toString(36)}`
        })()

        return ok({
          id,
          driver: DRIVER,
          ...(msg.stream ? { stream: msg.stream } : {}),
          at: new Date(),
          provider: result as Record<string, unknown>,
        } satisfies EmailResult)
      },
    }
  })

export default cloudflareEmailRest

function toPayload(msg: NormalizedMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: toAddress(msg.from),
    to: msg.to.map(toAddress),
    subject: msg.subject,
  }
  if (msg.cc.length > 0) payload.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(toAddress)
  if (msg.replyTo[0]) payload.replyTo = toAddress(msg.replyTo[0])
  if (msg.text != null) payload.text = msg.text
  if (msg.html != null) payload.html = msg.html
  if (Object.keys(msg.headers).length > 0) payload.headers = { ...msg.headers }
  if (msg.attachments.length > 0) {
    payload.attachments = msg.attachments.map((file) => ({
      content: attachmentToBase64(file),
      filename: file.filename,
      type: file.contentType ?? "application/octet-stream",
      disposition: file.disposition ?? (file.cid ? "inline" : "attachment"),
      ...(file.cid ? { contentId: file.cid } : {}),
    }))
  }
  return payload
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}
