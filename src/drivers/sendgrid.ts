import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
  SendStatus,
} from "../core/types.ts"
import type { EmailError } from "../core/error.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface SendGridOptions {
  /** Server API key. Starts with `SG.`. */
  apiKey: string
  /** Override the base URL — for a gateway, a test stub, or EU data
   *  residency, which lives on `https://api.eu.sendgrid.com` and needs an
   *  EU regional subuser to accept the request. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Act as a subuser — SendGrid's `on-behalf-of` header. */
  onBehalfOf?: string
  /** Dedicated IP pool for every message this driver sends. */
  ipPoolName?: string
  /** Unsubscribe group. SendGrid addresses groups by numeric id, which no
   *  field of `EmailMessage` carries, so it is set per driver. */
  asm?: SendGridAsm
  /** Route every message to sandbox mode — validated, never delivered.
   *  A message's own `sandbox` wins over this. */
  sandbox?: boolean
  /** Reserve a `batch_id` for a scheduled send, which is the only handle
   *  SendGrid will cancel one by. Costs one extra request per scheduled
   *  request. Default: true. */
  batchIdForScheduled?: boolean
}

/** A SendGrid unsubscribe group, and the groups its preference page
 *  offers alongside it. */
export interface SendGridAsm {
  groupId: number
  /** At most 25 — SendGrid shows no more than that at a time. */
  groupsToDisplay?: readonly number[]
}

const DRIVER = "sendgrid"
/** `personalizations` holds at most 1000 entries, and the recipients
 *  across all of them — to plus cc plus bcc — at most 1000 as well. */
const PERSONALIZATION_LIMIT = 1000
const RECIPIENT_LIMIT = 1000
/** At most 10 categories per message, at most 255 characters each. */
const CATEGORY_LIMIT = 10
const CATEGORY_LENGTH = 255
/** "Scheduling more than 72 hours in advance is forbidden." */
const SCHEDULE_WINDOW_MS = 72 * 60 * 60 * 1000
/** Headers SendGrid sets itself and rejects the request for overriding. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "x-sg-id",
  "x-sg-eid",
  "received",
  "dkim-signature",
  "content-type",
  "content-transfer-encoding",
  "to",
  "from",
  "subject",
  "reply-to",
  "cc",
  "bcc",
])

/**
 * SendGrid, over the v3 Mail Send API.
 *
 * `sendBatch` uses `personalizations`, which is the only batching SendGrid
 * has: messages sharing an envelope — same sender, body, attachments and
 * settings — go out as one request with a personalization each, and
 * anything that differs gets a request of its own. So a mixed batch is
 * still correct rather than quietly sending one body to everybody.
 *
 * ```ts
 * createEmail({ driver: sendgrid({ apiKey: process.env.SENDGRID_API_KEY! }) })
 * ```
 */
const sendgrid: DriverFactory<SendGridOptions> = defineDriver<SendGridOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  if (!options.apiKey.startsWith("SG.")) {
    throw createError(DRIVER, "INVALID_OPTIONS", "`apiKey` must start with 'SG.'")
  }
  const endpoint = (options.endpoint ?? "https://api.sendgrid.com").replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)
  const wantsBatchId = options.batchIdForScheduled ?? true

  async function request(
    path: string,
    method: string,
    body: unknown,
    ctx: SendContext,
  ): Promise<{ result: Result<unknown>; messageId?: string }> {
    let messageId: string | undefined
    const result = await httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}${path}`,
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(options.onBehalfOf ? { "on-behalf-of": options.onBehalfOf } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        const message = joinErrors(parsed)
        return { code: classifyStatus(status), ...(message ? { message } : {}) }
      },
      onResponse(response) {
        // A 202 with an empty body: the id exists only here. HTTP/2
        // lowercases the name and the docs spell it `X-Message-ID`, but
        // `Headers.get` is case-insensitive.
        messageId = response.headers.get("x-message-id") ?? undefined
      },
    })
    return { result, ...(messageId ? { messageId } : {}) }
  }

  async function createBatchId(ctx: SendContext): Promise<Result<string>> {
    const { result } = await request("/v3/mail/batch", "POST", {}, ctx)
    if (result.error) return err(result.error)
    const batchId = (result.data as { batch_id?: string } | null)?.batch_id
    if (!batchId) {
      return err(
        createError(DRIVER, "PROVIDER", "response did not contain a batch_id", {
          cause: result.data,
        }),
      )
    }
    return ok(batchId)
  }

  /** One `/v3/mail/send` request for a run of messages sharing an envelope.
   *  They all get the same result: SendGrid issues one id per request
   *  however many personalizations it carries, and the per-recipient
   *  `sg_message_id` on its webhook events is derived from that one. */
  async function deliver(run: readonly Entry[], ctx: SendContext): Promise<Result<EmailResult>[]> {
    const payload: Record<string, unknown> = {
      ...run[0]!.envelope,
      subject: run[0]!.msg.subject,
      personalizations: run.map((entry) => toPersonalization(entry.msg)),
    }

    if (wantsBatchId && run.some((entry) => entry.msg.scheduledAt)) {
      const batch = await createBatchId(ctx)
      if (batch.error) return run.map(() => err<EmailResult>(batch.error))
      payload.batch_id = batch.data
    }

    const { result, messageId } = await request("/v3/mail/send", "POST", payload, ctx)
    if (result.error) return run.map(() => err<EmailResult>(result.error))

    const batchId = payload.batch_id as string | undefined
    // A scheduled send is reported by its batch id, because that is the
    // only value `cancel()` accepts. The message id stays on `provider`.
    // Sandbox mode is validated and dropped, so it gets no id at all.
    const id = batchId ?? messageId ?? (run[0]!.envelope.mail_settings ? "sandbox" : undefined)
    if (!id) {
      const missing = err<EmailResult>(
        createError(DRIVER, "PROVIDER", "response carried no X-Message-Id header"),
      )
      return run.map(() => missing)
    }
    const provider: Record<string, unknown> = {
      ...(messageId ? { x_message_id: messageId } : {}),
      ...(batchId ? { batch_id: batchId } : {}),
    }
    return run.map((entry) => ok(toResult(id, entry.msg, provider)))
  }

  function ctxFor(): SendContext {
    return { driver: DRIVER, attempt: 1, meta: {} }
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      scheduling: true,
      tracking: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      sandbox: true,
      cancelable: true,
      retrievable: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    async send(msg, ctx) {
      const refusal = checkLimits(msg)
      if (refusal) return err(refusal)
      const entry: Entry = { index: 0, msg, envelope: toEnvelope(msg, options) }
      return (await deliver([entry], ctx))[0]!
    },

    async sendBatch(msgs, ctx) {
      const results: (Result<EmailResult> | undefined)[] = Array.from({ length: msgs.length })
      const groups = new Map<string, Entry[]>()
      for (const [index, msg] of msgs.entries()) {
        const refusal = checkLimits(msg)
        if (refusal) {
          results[index] = err(refusal)
          continue
        }
        const envelope = toEnvelope(msg, options)
        const key = JSON.stringify(envelope)
        const group = groups.get(key)
        if (group) group.push({ index, msg, envelope })
        else groups.set(key, [{ index, msg, envelope }])
      }

      for (const group of groups.values()) {
        for (const run of chunkRuns(group)) {
          const produced = await deliver(run, ctx)
          for (const [slot, entry] of run.entries()) results[entry.index] = produced[slot]!
        }
      }
      return results.map(
        (result) =>
          result ?? err<EmailResult>(createError(DRIVER, "PROVIDER", "no result for message")),
      )
    },

    async cancel(id) {
      const { result } = await request(
        "/v3/user/scheduled_sends",
        "POST",
        { batch_id: id, status: "cancel" },
        ctxFor(),
      )
      return result.error ? err(result.error) : ok(undefined)
    },

    async retrieve(id) {
      const { result } = await request(
        `/v3/user/scheduled_sends/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        ctxFor(),
      )
      if (result.error) return err(result.error)
      // The endpoint reports the pause and cancel records for a batch, so
      // a batch nobody has touched — still scheduled, or long since sent —
      // comes back as an empty list.
      const records = (Array.isArray(result.data) ? result.data : []) as {
        batch_id?: string
        status?: string
      }[]
      const record = records.find((entry) => entry.batch_id === id) ?? records[0]
      const status: SendStatus = {
        id,
        driver: DRIVER,
        state: record?.status === "cancel" ? "cancelled" : record ? "scheduled" : "unknown",
        provider: { records },
      }
      return ok(status)
    },
  }
})

export default sendgrid

/** A message paired with the request envelope it belongs to. Messages
 *  whose envelopes serialize the same can share one request. */
interface Entry {
  index: number
  msg: NormalizedMessage
  envelope: Record<string, unknown>
}

/** What SendGrid would reject the request for, checked here so the caller
 *  is told which field and which limit rather than reading `invalid
 *  request` off a 400. */
function checkLimits(msg: NormalizedMessage): EmailError | null {
  if (msg.tags.length > CATEGORY_LIMIT) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `at most ${CATEGORY_LIMIT} categories per message; got ${msg.tags.length}`,
    )
  }
  const long = msg.tags.find((tag) => tag.name.length > CATEGORY_LENGTH)
  if (long) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `category "${long.name.slice(0, 32)}" is longer than ${CATEGORY_LENGTH} characters`,
    )
  }
  const reserved = Object.keys(msg.headers).find((name) => RESERVED_HEADERS.has(name.toLowerCase()))
  if (reserved) {
    return createError(DRIVER, "INVALID_OPTIONS", `header "${reserved}" may not be overridden`)
  }
  if (msg.scheduledAt && msg.scheduledAt.getTime() - Date.now() > SCHEDULE_WINDOW_MS) {
    return createError(DRIVER, "INVALID_OPTIONS", "`scheduledAt` may be at most 72 hours ahead")
  }
  if (msg.template && !msg.template.id) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      "`template.id` is required — SendGrid has no template aliases",
    )
  }
  return null
}

/** Split a group into runs no request will be rejected for. SendGrid caps
 *  the personalizations and, separately, the recipients across them — so a
 *  fixed-size chunk is not enough — and refuses a request where one address
 *  appears twice, which two messages to the same person would produce. */
function chunkRuns(entries: readonly Entry[]): Entry[][] {
  const runs: Entry[][] = []
  let current: Entry[] = []
  let recipients = 0
  let seen = new Set<string>()

  for (const entry of entries) {
    const addresses = addressesOf(entry.msg)
    const duplicate = addresses.some((address) => seen.has(address))
    if (
      current.length > 0 &&
      (duplicate ||
        current.length >= PERSONALIZATION_LIMIT ||
        recipients + addresses.length > RECIPIENT_LIMIT)
    ) {
      runs.push(current)
      current = []
      recipients = 0
      seen = new Set()
    }
    current.push(entry)
    recipients += addresses.length
    for (const address of addresses) seen.add(address)
  }
  if (current.length > 0) runs.push(current)
  return runs
}

function addressesOf(msg: NormalizedMessage): string[] {
  return [...msg.to, ...msg.cc, ...msg.bcc].map((address) => address.email.toLowerCase())
}

/** Everything that is the same for every message in a request. `subject`
 *  is deliberately absent: it belongs to the personalization, and keeping
 *  it here would stop two otherwise identical messages from sharing a
 *  request. */
function toEnvelope(msg: NormalizedMessage, options: SendGridOptions): Record<string, unknown> {
  const envelope: Record<string, unknown> = { from: toAddress(msg.from) }

  // `reply_to` and `reply_to_list` are mutually exclusive — sending both
  // is rejected outright.
  if (msg.replyTo.length === 1) envelope.reply_to = toAddress(msg.replyTo[0]!)
  else if (msg.replyTo.length > 1) envelope.reply_to_list = msg.replyTo.map(toAddress)

  // RFC 1341 §7.2 order, which SendGrid enforces: text/plain first.
  const content: { type: string; value: string }[] = []
  if (msg.text != null) content.push({ type: "text/plain", value: msg.text })
  if (msg.html != null) content.push({ type: "text/html", value: msg.html })
  if (content.length > 0) envelope.content = content

  if (Object.keys(msg.headers).length > 0) envelope.headers = { ...msg.headers }
  // Categories must be unique; two tags of the same name would otherwise
  // fail the whole request.
  if (msg.tags.length > 0) envelope.categories = [...new Set(msg.tags.map((tag) => tag.name))]
  if (msg.attachments.length > 0) envelope.attachments = msg.attachments.map(toSendGridAttachment)
  if (msg.template?.id) envelope.template_id = msg.template.id
  if (options.ipPoolName) envelope.ip_pool_name = options.ipPoolName
  if (options.asm) {
    envelope.asm = {
      group_id: options.asm.groupId,
      ...(options.asm.groupsToDisplay
        ? { groups_to_display: [...options.asm.groupsToDisplay] }
        : {}),
    }
  }
  if (msg.sandbox ?? options.sandbox) {
    envelope.mail_settings = { sandbox_mode: { enable: true } }
  }

  const tracking: Record<string, unknown> = {}
  if (msg.tracking?.opens != null) tracking.open_tracking = { enable: msg.tracking.opens }
  if (msg.tracking?.clicks != null) {
    tracking.click_tracking = { enable: msg.tracking.clicks, enable_text: msg.tracking.clicks }
  }
  if (Object.keys(tracking).length > 0) envelope.tracking_settings = tracking

  return envelope
}

function toPersonalization(msg: NormalizedMessage): Record<string, unknown> {
  const personalization: Record<string, unknown> = {
    to: msg.to.map(toAddress),
    subject: msg.subject,
  }
  if (msg.cc.length > 0) personalization.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) personalization.bcc = msg.bcc.map(toAddress)
  if (msg.scheduledAt) personalization.send_at = Math.floor(msg.scheduledAt.getTime() / 1000)

  if (msg.template?.variables) {
    // A `d-` id is a dynamic template and takes JSON; anything else is a
    // legacy template, whose substitutions are string-to-string and are
    // rejected outright on a dynamic one.
    if (msg.template.id?.startsWith("d-")) {
      personalization.dynamic_template_data = { ...msg.template.variables }
    } else {
      personalization.substitutions = Object.fromEntries(
        Object.entries(msg.template.variables).map(([key, value]) => [key, String(value)]),
      )
    }
  }

  // A category is a bare string, so a tag's value would otherwise be the
  // one thing the caller set that reached nobody. custom_args is what
  // comes back on SendGrid's webhook events.
  const custom: Record<string, string> = { ...msg.metadata }
  for (const tag of msg.tags) custom[tag.name] = tag.value
  if (Object.keys(custom).length > 0) personalization.custom_args = custom

  return personalization
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}

function toSendGridAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    filename: attachment.filename,
    content: attachmentToBase64(attachment),
    type: attachment.contentType ?? "application/octet-stream",
    // A `cid` is only reachable from the HTML when the part is inline, so
    // naming one settles the disposition.
    disposition: attachment.cid ? "inline" : (attachment.disposition ?? "attachment"),
    ...(attachment.cid ? { content_id: attachment.cid } : {}),
  }
}

function toResult(
  id: string,
  msg: NormalizedMessage,
  provider: Record<string, unknown>,
): EmailResult {
  return {
    id,
    driver: DRIVER,
    ...(msg.stream ? { stream: msg.stream } : {}),
    at: new Date(),
    provider,
  }
}

/** SendGrid reports every problem with a request at once and names the
 *  offending field on each; keeping only the first would send the caller
 *  back for another round trip per mistake. */
function joinErrors(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const errors = (body as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return null
  const messages: string[] = []
  for (const entry of errors) {
    if (!entry || typeof entry !== "object") continue
    const { field, message } = entry as { field?: unknown; message?: unknown }
    if (typeof message !== "string") continue
    messages.push(typeof field === "string" && field ? `${field}: ${message}` : message)
  }
  return messages.length > 0 ? messages.join("; ") : null
}
