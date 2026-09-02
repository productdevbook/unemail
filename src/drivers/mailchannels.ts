import type {
  DriverFactory,
  EmailAddress,
  EmailErrorCode,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
} from "../core/types.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { chunk } from "./_chunk.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

/** Per-domain DKIM key. MailChannels signs for you rather than expecting a
 *  pre-signed message, so the private key travels with the request. */
export interface MailChannelsDkim {
  domain: string
  selector: string
  /** PKCS#8 or PKCS#1 RSA private key, base64, without the PEM armour. */
  privateKey: string
}

export interface MailChannelsOptions {
  /** Sending-scoped key from the MailChannels console, sent as `X-Api-Key`.
   *  Required — the unauthenticated Cloudflare Workers endpoint this driver
   *  used to target was switched off on 30 June 2024. */
  apiKey: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Queue on `/tx/v1/send-async` and report delivery over webhooks instead
   *  of waiting for it. The response then carries one `request_id` for the
   *  whole request and no per-message ids. Default: false. */
  async?: boolean
  /** Sign with this key. Pass a function to choose one per message, which
   *  is what makes multi-tenant sending work inside a single batch — the
   *  key rides on the personalization, not the request. */
  dkim?: MailChannelsDkim | ((msg: NormalizedMessage) => MailChannelsDkim | null)
  /** `campaign_id` for messages with no `campaign` tag of their own. */
  campaignId?: string
  /** SMTP envelope sender, when it should differ from `from`. */
  envelopeFrom?: string
  /** MailChannels treats mail as transactional unless told otherwise;
   *  setting this false marks the whole instance as bulk. */
  transactional?: boolean
  /** CNAME'd domain for tracking links and pixels. */
  trackingDomain?: string
  /** CNAME'd domain for one-click unsubscribe links. */
  unsubscribeDomain?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

const DRIVER = "mailchannels"
const DEFAULT_ENDPOINT = "https://api.mailchannels.net"
/** One request carries at most 1000 personalizations. */
const BATCH_LIMIT = 1000
/** `to`, `cc` and `bcc` together, per personalization. */
const RECIPIENT_LIMIT = 1000
const ATTACHMENT_LIMIT = 1000
/** `campaign_id` is at most 48 UTF-8 characters and may not contain spaces. */
const CAMPAIGN_ID_LIMIT = 48
const CAMPAIGN_TAG = "campaign"

interface SendResult {
  index?: number
  message_id?: string
  status?: "sent" | "failed"
  reason?: string
}

interface MailChannelsResponse {
  request_id?: string
  queued_at?: string
  results?: SendResult[]
  /** Dry runs answer with the rendered message instead of sending it. */
  data?: string[]
  errors?: string[]
}

/**
 * MailChannels, over its Email API.
 *
 * This is the paid product at `api.mailchannels.net/tx/v1/send` with an
 * `X-Api-Key`, not the free unauthenticated Cloudflare Workers integration
 * that was terminated on 30 June 2024.
 *
 * ```ts
 * createEmail({ driver: mailchannels({ apiKey: process.env.MAILCHANNELS_API_KEY! }) })
 * ```
 *
 * `sendBatch` is a real batch: MailChannels varies the recipient, sender,
 * subject, headers, DKIM key and template data per `personalization`, so
 * messages are grouped by the body they share and each becomes one
 * personalization of a single request.
 */
const mailchannels: DriverFactory<MailChannelsOptions> = defineDriver<MailChannelsOptions>(
  (options) => {
    if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
    if (options.campaignId && badCampaignId(options.campaignId)) {
      throw createError(
        DRIVER,
        "INVALID_OPTIONS",
        `\`campaignId\` must be at most ${CAMPAIGN_ID_LIMIT} characters and contain no spaces`,
      )
    }
    const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
    const fetchImpl = resolveFetch(DRIVER, options.fetch)
    const path = options.async ? "/tx/v1/send-async" : "/tx/v1/send"

    function request(dryRun: boolean, body: unknown, ctx: SendContext) {
      return httpJson({
        fetch: fetchImpl,
        driver: DRIVER,
        url: `${endpoint}${path}${dryRun ? "?dry-run=true" : ""}`,
        headers: { "x-api-key": options.apiKey },
        body,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
        classify(status, parsed) {
          const errors = (parsed as MailChannelsResponse | null)?.errors
          const message = Array.isArray(errors) && errors.length > 0 ? errors.join("; ") : null
          return {
            code: classifyMailChannelsStatus(status),
            ...(message ? { message } : {}),
          }
        },
      })
    }

    async function deliver(
      group: readonly NormalizedMessage[],
      dryRun: boolean,
      ctx: SendContext,
    ): Promise<Result<EmailResult>[]> {
      const first = group[0]!
      const body = {
        ...sharedPayload(first, options),
        from: toAddress(first.from),
        subject: first.subject,
        personalizations: group.map((msg) => toPersonalization(msg, options)),
      }
      const response = await request(dryRun, body, ctx)
      if (response.error) return group.map(() => err<EmailResult>(response.error))

      const parsed = (response.data ?? {}) as MailChannelsResponse
      if (dryRun) {
        // A dry run renders the message and sends nothing, so there is no
        // id to report — only the rendered document, on `provider`.
        return group.map((msg, index) =>
          ok(toResult("dry-run", msg, { data: parsed.data?.[index] ?? null })),
        )
      }
      // MailChannels labels each outcome with its own `index` rather than
      // relying on array position, so the mapping back is read from the
      // label; a personalization with no outcome fails loudly instead of
      // borrowing its neighbour's id.
      const byIndex = new Map<number, SendResult>()
      for (const [position, entry] of (parsed.results ?? []).entries()) {
        byIndex.set(entry.index ?? position, entry)
      }
      return group.map((msg, index) => {
        const entry = byIndex.get(index)
        if (!entry) {
          // `send-async` queues the whole request and reports per message
          // over webhooks, so one `request_id` is all there is to give.
          if (options.async && parsed.request_id) {
            return ok(
              toResult(
                parsed.request_id,
                msg,
                parsed as unknown as Record<string, unknown>,
                parsed.queued_at,
              ),
            )
          }
          return err<EmailResult>(
            createError(DRIVER, "PROVIDER", "no result for message", { cause: parsed }),
          )
        }
        if (entry.status === "failed") {
          return err<EmailResult>(
            createError(DRIVER, "PROVIDER", entry.reason ?? "message rejected", {
              retryable: false,
              cause: entry,
            }),
          )
        }
        if (!entry.message_id) {
          return err<EmailResult>(
            createError(DRIVER, "PROVIDER", "response did not contain a message_id", {
              cause: entry,
            }),
          )
        }
        return ok(toResult(entry.message_id, msg, entry as unknown as Record<string, unknown>))
      })
    }

    return {
      name: DRIVER,
      features: {
        attachments: true,
        html: true,
        text: true,
        batch: true,
        tracking: true,
        templates: true,
        tagging: true,
        replyTo: true,
        customHeaders: true,
        sandbox: true,
      },

      isAvailable: () => Boolean(options.apiKey),

      async send(msg, ctx) {
        const rejected = validate(msg, options)
        if (rejected) return err(rejected)
        return (await deliver([msg], msg.sandbox ?? false, ctx))[0]!
      },

      async sendBatch(msgs, ctx) {
        const results: (Result<EmailResult> | undefined)[] = []
        const groups = new Map<string, { index: number; msg: NormalizedMessage }[]>()

        for (const [index, msg] of msgs.entries()) {
          const rejected = validate(msg, options)
          if (rejected) {
            results[index] = err(rejected)
            continue
          }
          // Everything a personalization can override may differ within a
          // request; everything else — the body above all — cannot, and a
          // dry run is a different URL.
          const key = JSON.stringify([msg.sandbox ?? false, sharedPayload(msg, options)])
          const group = groups.get(key)
          if (group) group.push({ index, msg })
          else groups.set(key, [{ index, msg }])
        }

        for (const group of groups.values()) {
          for (const batch of chunk(group, BATCH_LIMIT)) {
            const outcomes = await deliver(
              batch.map((item) => item.msg),
              batch[0]!.msg.sandbox ?? false,
              ctx,
            )
            for (const [position, item] of batch.entries())
              results[item.index] = outcomes[position]!
          }
        }

        return msgs.map((_, index) => results[index] ?? err<EmailResult>(noResult()))
      },
    }
  },
)

export default mailchannels

/** A message the batch loop never assigned an outcome to. Reaching this
 *  means a bug here, not a provider failure, so it is reported rather
 *  than silently dropped. */
function noResult() {
  return createError(DRIVER, "PROVIDER", "no result for message")
}

/** Checked here rather than left to the API: a 400 that names nothing costs
 *  a round trip, and MailChannels has no stored templates to address. */
function validate(msg: NormalizedMessage, options: MailChannelsOptions) {
  if (msg.template?.id || msg.template?.alias) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      "MailChannels has no stored templates — put the Mustache source in `html`/`text` and the values in `template.variables`",
    )
  }
  const recipients = msg.to.length + msg.cc.length + msg.bcc.length
  if (recipients > RECIPIENT_LIMIT) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `${recipients} recipients; MailChannels accepts at most ${RECIPIENT_LIMIT} per message`,
    )
  }
  if (msg.attachments.length > ATTACHMENT_LIMIT) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `${msg.attachments.length} attachments; MailChannels accepts at most ${ATTACHMENT_LIMIT}`,
    )
  }
  const campaign = campaignId(msg, options)
  if (campaign && badCampaignId(campaign)) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `\`campaign\` tag must be at most ${CAMPAIGN_ID_LIMIT} characters and contain no spaces`,
    )
  }
  return null
}

function badCampaignId(value: string): boolean {
  return [...value].length > CAMPAIGN_ID_LIMIT || /\s/.test(value)
}

function campaignId(msg: NormalizedMessage, options: MailChannelsOptions): string | undefined {
  return msg.tags.find((tag) => tag.name === CAMPAIGN_TAG)?.value ?? options.campaignId
}

/** Everything that lives outside a personalization. Two messages that
 *  produce the same object can share one request. */
function sharedPayload(
  msg: NormalizedMessage,
  options: MailChannelsOptions,
): Record<string, unknown> {
  // Mustache is MailChannels' only templating, and it is switched on per
  // content part rather than by naming a stored template.
  const mustache = msg.template?.variables ? { template_type: "mustache" } : {}
  const content: Record<string, unknown>[] = []
  if (msg.text != null) content.push({ type: "text/plain", value: msg.text, ...mustache })
  if (msg.html != null) content.push({ type: "text/html", value: msg.html, ...mustache })

  const payload: Record<string, unknown> = { content }
  if (msg.attachments.length > 0) {
    payload.attachments = msg.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachmentToBase64(attachment),
      ...(attachment.contentType ? { type: attachment.contentType } : {}),
      ...(attachment.cid ? { content_id: attachment.cid } : {}),
    }))
  }
  const campaign = campaignId(msg, options)
  if (campaign) payload.campaign_id = campaign
  if (options.envelopeFrom) payload.envelope_from = { email: options.envelopeFrom }
  if (options.transactional != null) payload.transactional = options.transactional
  if (options.unsubscribeDomain) {
    payload.unsubscribe_settings = { custom_domain_name: options.unsubscribeDomain }
  }

  const tracking: Record<string, unknown> = {}
  const domain = options.trackingDomain ? { custom_domain_name: options.trackingDomain } : {}
  if (msg.tracking?.opens != null) {
    tracking.open_tracking = { enable: msg.tracking.opens, ...domain }
  }
  if (msg.tracking?.clicks != null) {
    tracking.click_tracking = { enable: msg.tracking.clicks, ...domain }
  }
  if (Object.keys(tracking).length > 0) payload.tracking_settings = tracking
  return payload
}

function toPersonalization(
  msg: NormalizedMessage,
  options: MailChannelsOptions,
): Record<string, unknown> {
  const personalization: Record<string, unknown> = {
    to: msg.to.map(toAddress),
    from: toAddress(msg.from),
    subject: msg.subject,
  }
  if (msg.cc.length > 0) personalization.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) personalization.bcc = msg.bcc.map(toAddress)
  if (msg.replyTo[0]) personalization.reply_to = toAddress(msg.replyTo[0])

  // MailChannels has no metadata field; a custom header is what survives to
  // the recipient and to its webhook events.
  const headers: Record<string, string> = { ...msg.headers }
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value
  for (const tag of msg.tags) {
    if (tag.name === CAMPAIGN_TAG) continue
    headers[`X-Tag-${tag.name}`] = tag.value
  }
  if (Object.keys(headers).length > 0) personalization.headers = headers

  const dkim = typeof options.dkim === "function" ? options.dkim(msg) : options.dkim
  if (dkim) {
    personalization.dkim_domain = dkim.domain
    personalization.dkim_selector = dkim.selector
    personalization.dkim_private_key = dkim.privateKey
  }
  if (msg.template?.variables) {
    personalization.dynamic_template_data = { ...msg.template.variables }
  }
  return personalization
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}

function toResult(
  id: string,
  msg: NormalizedMessage,
  provider: Record<string, unknown>,
  at?: string,
): EmailResult {
  const queued = at ? new Date(at) : null
  return {
    id,
    driver: DRIVER,
    ...(msg.stream ? { stream: msg.stream } : {}),
    at: queued && !Number.isNaN(queued.getTime()) ? queued : new Date(),
    provider,
  }
}

/** MailChannels answers a bad or unscoped key with 403 rather than 401, and
 *  uses 400 and 413 for requests that will never succeed as written. */
function classifyMailChannelsStatus(status: number): EmailErrorCode {
  if (status === 400 || status === 413) return "INVALID_OPTIONS"
  return classifyStatus(status)
}
