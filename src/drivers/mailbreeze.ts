import type { DriverFactory, NormalizedMessage } from "../core/types.ts"
import { formatAddress, formatAddressList } from "../core/address.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface MailbreezeOptions {
  /** API key from the console. `sk_live_…` sends real mail; `sk_test_…`
   *  simulates it. Which one you hold is the only thing that decides
   *  whether a send is real. */
  apiKey: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

interface MailbreezeData {
  id?: string
  messageId?: string
  sandbox?: boolean
  [key: string]: unknown
}

interface MailbreezeEnvelope {
  success?: boolean
  data?: MailbreezeData
  error?: { code?: string; message?: string; details?: unknown }
}

const DRIVER = "mailbreeze"
const DEFAULT_ENDPOINT = "https://api.mailbreeze.com"
const LIVE_PREFIX = "sk_live_"
const TEST_PREFIX = "sk_test_"
/** "Valid for 24 hours, max 256 characters." */
const IDEMPOTENCY_KEY_LIMIT = 256

/**
 * MailBreeze, over its REST API.
 *
 * ```ts
 * createEmail({ driver: mailbreeze({ apiKey: process.env.MAILBREEZE_API_KEY! }) })
 * ```
 *
 * Test mode belongs to the key, not to the request: an `sk_test_` key
 * simulates every send it makes and says so in the response, which reaches
 * the caller as `provider.sandbox`. `message.sandbox` therefore cannot turn
 * a live key into a test one, and asking for it is refused rather than
 * ignored — the alternative is a caller who believes a delivered email was
 * a simulation.
 */
const mailbreeze: DriverFactory<MailbreezeOptions> = defineDriver<MailbreezeOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  const isTestKey = options.apiKey.startsWith(TEST_PREFIX)
  if (!isTestKey && !options.apiKey.startsWith(LIVE_PREFIX)) {
    throw createError(
      DRIVER,
      "INVALID_OPTIONS",
      `\`apiKey\` must start with '${LIVE_PREFIX}' or '${TEST_PREFIX}'`,
    )
  }

  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  return {
    name: DRIVER,
    features: {
      // The send endpoint takes `attachmentIds` from a separate upload
      // flow, never file content, so there is nothing to encode onto it.
      attachments: false,
      html: true,
      text: true,
      templates: true,
      idempotency: true,
      replyTo: true,
      customHeaders: true,
      sandbox: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    async send(msg, ctx) {
      if (msg.sandbox && !isTestKey) {
        return err(
          createError(
            DRIVER,
            "INVALID_OPTIONS",
            `\`sandbox\` is a property of the API key — use an '${TEST_PREFIX}' key, ` +
              "as this one would deliver the message",
          ),
        )
      }
      if (msg.idempotencyKey && msg.idempotencyKey.length > IDEMPOTENCY_KEY_LIMIT) {
        return err(
          createError(
            DRIVER,
            "INVALID_OPTIONS",
            `\`idempotencyKey\` is ${msg.idempotencyKey.length} characters; ` +
              `MailBreeze accepts at most ${IDEMPOTENCY_KEY_LIMIT}`,
          ),
        )
      }
      if (msg.template && !msg.template.id && !msg.template.alias) {
        return err(createError(DRIVER, "INVALID_OPTIONS", "`template` needs an `id` or an `alias`"))
      }

      const response = await httpJson({
        fetch: fetchImpl,
        driver: DRIVER,
        url: `${endpoint}/v1/emails`,
        headers: { "x-api-key": options.apiKey },
        body: toPayload(msg),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
        classify,
      })
      if (response.error) return err(response.error)

      const envelope = (response.data ?? {}) as MailbreezeEnvelope
      if (envelope.success === false) {
        return err(
          createError(DRIVER, "PROVIDER", envelope.error?.message ?? "send failed", {
            retryable: false,
            cause: envelope,
          }),
        )
      }
      // The SDKs unwrap `data`; the API does not, and a gateway in between
      // may have done it already.
      const data = envelope.data ?? (envelope as MailbreezeData)
      const id = data.id ?? data.messageId
      if (!id) {
        return err(
          createError(DRIVER, "PROVIDER", "response did not contain an email id", {
            cause: response.data,
          }),
        )
      }
      return ok({
        id,
        driver: DRIVER,
        ...(msg.stream ? { stream: msg.stream } : {}),
        at: new Date(),
        // A live send omits the flag entirely; normalizing it to a boolean
        // is what lets a caller ask the question at all.
        provider: { ...data, sandbox: data.sandbox === true },
      })
    },
  }
})

export default mailbreeze

function toPayload(msg: NormalizedMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: formatAddress(msg.from),
    to: msg.to.map(formatAddress),
  }
  if (msg.subject != null) payload.subject = msg.subject
  if (msg.cc.length > 0) payload.cc = msg.cc.map(formatAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(formatAddress)
  if (msg.text != null) payload.text = msg.text
  if (msg.html != null) payload.html = msg.html
  // One string, so several reply addresses go out as the header value they
  // would have had anyway rather than as a silently dropped list.
  if (msg.replyTo.length > 0) payload.replyTo = formatAddressList(msg.replyTo)
  if (msg.idempotencyKey) payload.idempotencyKey = msg.idempotencyKey

  // MailBreeze has no metadata field; a custom header is what survives to
  // the recipient and to its own logs.
  const headers: Record<string, string> = { ...msg.headers }
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value
  if (Object.keys(headers).length > 0) payload.headers = headers

  if (msg.template) {
    payload.templateId = msg.template.id ?? msg.template.alias
    if (msg.template.variables) payload.variables = { ...msg.template.variables }
  }
  return payload
}

/** MailBreeze wraps failures in `{ success: false, error: { code, message } }`.
 *  The shared extractor cannot reach a message nested that deep, so without
 *  this every failure would read `HTTP 400`. */
function classify(status: number, body: unknown) {
  if (!body || typeof body !== "object") return null
  const error = (body as MailbreezeEnvelope).error
  if (!error) return null

  const message = error.message ?? error.code
  // A 403 usually means the key; this one means the domain is switched off,
  // and no new key fixes it.
  const code = error.code === "SENDING_DISABLED" ? ("PROVIDER" as const) : classifyStatus(status)
  return { code, ...(message ? { message } : {}) }
}
