import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
  SendState,
  SendStatus,
} from "../core/types.ts"
import type { EmailError } from "../core/error.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { batchIdempotencyKey, chunk } from "./_chunk.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface BrevoOptions {
  /** Transactional API key (`xkeysib-…`). */
  apiKey: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Groups every send under one id, so `cancel()` and `retrieve()` can
   *  address the whole group. Brevo requires a UUIDv4. */
  batchId?: string
}

const DRIVER = "brevo"
const DEFAULT_ENDPOINT = "https://api.brevo.com"
/** Brevo takes at most 1000 `messageVersions` in one call… */
const VERSION_LIMIT = 1000
/** …and at most 2000 recipients across all of them. */
const RECIPIENT_LIMIT = 2000
/** Per version, and per plain (unversioned) send. */
const RECIPIENTS_PER_VERSION = 99
/** Brevo's own error strings that mean "your key cannot do this", whatever
 *  status they arrive with. */
const AUTH_ERROR_CODES = new Set(["unauthorized", "permission_denied"])

/**
 * Brevo (formerly Sendinblue), over its transactional REST API.
 *
 * ```ts
 * createEmail({ driver: brevo({ apiKey: process.env.BREVO_API_KEY! }) })
 * ```
 */
const brevo: DriverFactory<BrevoOptions> = defineDriver<BrevoOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function request(
    path: string,
    method: string,
    body: unknown,
    extra: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}${path}`,
      method,
      headers: {
        "api-key": options.apiKey,
        // Brevo spells its idempotency header in camelCase, unlike every
        // other provider here.
        ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        const code = (parsed as { code?: string } | null)?.code
        if (code != null && AUTH_ERROR_CODES.has(code)) return { code: "AUTH" }
        return { code: classifyStatus(status) }
      },
    })
  }

  async function sendOne(msg: NormalizedMessage, ctx: SendContext): Promise<Result<EmailResult>> {
    const invalid = validate(msg)
    if (invalid) return err(invalid)

    const key = await idempotencyKey([msg.idempotencyKey])
    const response = await request("/v3/smtp/email", "POST", toPayload(msg, options.batchId), {
      ...(key ? { idempotencyKey: key } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (response.error) return err(response.error)
    const body = (response.data ?? {}) as { messageId?: string; messageIds?: string[] }
    const id = body.messageId ?? body.messageIds?.[0]
    if (!id) return err(missingId(response.data))
    return ok(toResult(id, msg, body))
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      scheduling: true,
      idempotency: true,
      templates: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
      sandbox: true,
      cancelable: true,
      retrievable: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    send: sendOne,

    async sendBatch(msgs, ctx) {
      // `messageVersions` overrides only to/cc/bcc/replyTo/subject/body/params.
      // Sender, attachments, headers, tags, template and schedule are one per
      // request, so a batch that disagrees on any of them cannot be expressed
      // as versions of a single message and goes out one at a time instead.
      if (new Set(msgs.map(sharedEnvelope)).size > 1) {
        const out: Result<EmailResult>[] = []
        for (const msg of msgs) out.push(await sendOne(msg, ctx))
        return out
      }

      const results: Result<EmailResult>[] = Array.from({ length: msgs.length })
      const sendable: { index: number; msg: NormalizedMessage }[] = []
      for (const [index, msg] of msgs.entries()) {
        const invalid = validate(msg)
        if (invalid) results[index] = err(invalid)
        else sendable.push({ index, msg })
      }
      if (sendable.length === 0) return results

      for (const versionGroup of chunk(sendable, VERSION_LIMIT)) {
        for (const group of splitByRecipients(versionGroup, RECIPIENT_LIMIT)) {
          const first = group[0]!.msg
          const payload = toPayload(first, options.batchId)
          payload.messageVersions = group.map((entry) => toVersion(entry.msg))
          const key = await idempotencyKey(group.map((entry) => entry.msg.idempotencyKey))
          const response = await request("/v3/smtp/email", "POST", payload, {
            ...(key ? { idempotencyKey: key } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          })
          if (response.error) {
            for (const entry of group) results[entry.index] = err(response.error)
            continue
          }
          const body = (response.data ?? {}) as { messageIds?: string[] }
          const ids = body.messageIds ?? []
          // Brevo answers with one id per version, in the order they were
          // sent; a short list means some version was dropped, which must
          // not silently shift every id onto the wrong message.
          for (const [offset, entry] of group.entries()) {
            const id = ids[offset]
            results[entry.index] = id
              ? ok(toResult(id, entry.msg, { messageId: id }))
              : err<EmailResult>(missingId(body))
          }
        }
      }
      return results
    },

    /** Deletes a *scheduled* send, by `batchId` or by message id. Brevo
     *  cannot recall a message that has already left. */
    async cancel(id) {
      const response = await request(
        `/v3/smtp/email/${encodeURIComponent(id)}`,
        "DELETE",
        undefined,
      )
      return response.error ? err(response.error) : ok(undefined)
    },

    async retrieve(id) {
      const response = await request(
        `/v3/smtp/emailStatus/${encodeURIComponent(id)}`,
        "GET",
        undefined,
      )
      if (response.error) return err(response.error)
      const body = (response.data ?? {}) as BrevoStatusResponse
      // A messageId answers with one record; a batchId answers with a list
      // of them under `batches`.
      const entry = body.batches?.[0] ?? body
      const at = entry.scheduledAt ?? entry.createdAt
      const status: SendStatus = {
        id,
        driver: DRIVER,
        state: toState(entry.status),
        ...(at ? { at: new Date(at) } : {}),
        provider: body as Record<string, unknown>,
      }
      return ok(status)
    },
  }
})

export default brevo

interface BrevoStatusEntry {
  createdAt?: string
  scheduledAt?: string
  status?: string
}

interface BrevoStatusResponse extends BrevoStatusEntry {
  count?: number
  batches?: BrevoStatusEntry[]
}

/** What a message cannot ask Brevo for. Checked before the request so the
 *  caller gets the reason rather than a bare 400. */
function validate(msg: NormalizedMessage): EmailError | null {
  if (msg.template?.alias && !msg.template.id) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      "Brevo addresses templates by numeric id — use `template.id`, not `template.alias`",
    )
  }
  if (msg.template?.id != null && !/^\d+$/.test(msg.template.id)) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `\`template.id\` must be numeric for Brevo, got "${msg.template.id}"`,
    )
  }
  if (msg.to.length > RECIPIENTS_PER_VERSION) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `Brevo accepts at most ${RECIPIENTS_PER_VERSION} \`to\` recipients, got ${msg.to.length}`,
    )
  }
  return null
}

/** Everything a `messageVersions` request has to agree on. Two messages
 *  with the same signature can travel as versions of one another. */
function sharedEnvelope(msg: NormalizedMessage): string {
  return JSON.stringify([
    msg.from,
    msg.headers,
    msg.metadata,
    msg.tags,
    msg.template?.id ?? null,
    msg.scheduledAt?.toISOString() ?? null,
    msg.sandbox ?? false,
    msg.stream ?? null,
    // Attachments are per request, not per version — differing ones would
    // reach every recipient in the batch.
    msg.attachments.map((a) => a.filename + ":" + a.content.length),
  ])
}

function splitByRecipients<T extends { msg: NormalizedMessage }>(
  entries: readonly T[],
  limit: number,
): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let count = 0
  for (const entry of entries) {
    const size = entry.msg.to.length + entry.msg.cc.length + entry.msg.bcc.length
    if (current.length > 0 && count + size > limit) {
      groups.push(current)
      current = []
      count = 0
    }
    current.push(entry)
    count += size
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function toPayload(msg: NormalizedMessage, batchId?: string): Record<string, unknown> {
  const headers: Record<string, string> = { ...msg.headers }
  // Brevo has no metadata field; `X-Mailin-custom` is the header it echoes
  // back on webhook events, so tags and metadata ride there together.
  const custom: Record<string, string> = { ...msg.metadata }
  for (const tag of msg.tags) custom[tag.name] = tag.value
  if (Object.keys(custom).length > 0) headers["X-Mailin-custom"] = JSON.stringify(custom)
  // Brevo's sandbox is a header, not an endpoint: the request is validated
  // in full and then dropped instead of delivered.
  if (msg.sandbox) headers["X-Sib-Sandbox"] = "drop"

  const payload: Record<string, unknown> = {
    sender: toAddress(msg.from),
    to: msg.to.map(toAddress),
    subject: msg.subject,
  }
  if (msg.cc.length > 0) payload.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) payload.bcc = msg.bcc.map(toAddress)
  // Brevo takes exactly one reply-to address, not a list.
  if (msg.replyTo[0]) payload.replyTo = toAddress(msg.replyTo[0])
  if (msg.html != null) payload.htmlContent = msg.html
  if (msg.text != null) payload.textContent = msg.text
  if (Object.keys(headers).length > 0) payload.headers = headers
  // Brevo tags are bare strings; the values are carried in X-Mailin-custom
  // above so nothing the caller set goes nowhere.
  if (msg.tags.length > 0) payload.tags = msg.tags.map((tag) => tag.name)
  if (msg.template?.id) payload.templateId = Number(msg.template.id)
  if (msg.template?.variables) payload.params = { ...msg.template.variables }
  if (msg.scheduledAt) payload.scheduledAt = msg.scheduledAt.toISOString()
  if (batchId) payload.batchId = batchId
  if (msg.attachments.length > 0) payload.attachment = msg.attachments.map(toBrevoAttachment)
  return payload
}

/** The subset of a message a `messageVersions` entry may override. */
function toVersion(msg: NormalizedMessage): Record<string, unknown> {
  const version: Record<string, unknown> = { to: msg.to.map(toAddress), subject: msg.subject }
  if (msg.cc.length > 0) version.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) version.bcc = msg.bcc.map(toAddress)
  if (msg.replyTo[0]) version.replyTo = toAddress(msg.replyTo[0])
  if (msg.html != null) version.htmlContent = msg.html
  if (msg.text != null) version.textContent = msg.text
  if (msg.template?.variables) version.params = { ...msg.template.variables }
  return version
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}

function toBrevoAttachment(attachment: Attachment): Record<string, unknown> {
  return { name: attachment.filename, content: attachmentToBase64(attachment) }
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

function missingId(body: unknown) {
  return createError(DRIVER, "PROVIDER", "response did not contain a messageId", { cause: body })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Brevo rejects an idempotency key that is not a UUID, and the library's
 * keys are free-form strings. A key that already looks like a UUID is
 * passed through; anything else is hashed into one, which keeps it stable
 * for the same key and distinct for any other.
 */
async function idempotencyKey(keys: readonly (string | undefined)[]): Promise<string | undefined> {
  const only = keys.length === 1 ? keys[0] : undefined
  if (only && UUID.test(only)) return only
  const hashed = await batchIdempotencyKey(keys)
  return hashed ? toUuid(hashed.replace(/^batch_/, "")) : undefined
}

function toUuid(hex: string): string {
  const value = hex.padEnd(32, "0").slice(0, 32)
  const variant = "89ab"[Number.parseInt(value[16]!, 16) % 4]
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    `4${value.slice(13, 16)}`,
    `${variant}${value.slice(17, 20)}`,
    value.slice(20, 32),
  ].join("-")
}

function toState(status?: string): SendState {
  switch (status) {
    case "queued":
      return "scheduled"
    case "inProgress":
      return "queued"
    case "processed":
      return "sent"
    case "error":
      return "failed"
    default:
      return "unknown"
  }
}
