import type {
  Attachment,
  DriverFactory,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
} from "../core/types.ts"
import type { EmailError } from "../core/error.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError, createUnsupportedError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface LoopsOptions {
  /** API key from the Loops dashboard. */
  apiKey: string
  /** The transactional email to send when a message names no `template`.
   *  Found in the Loops UI as the email's `transactionalId`. */
  transactionalId?: string
  /** Add every recipient to the Loops audience as a contact. */
  addToAudience?: boolean
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
}

const DRIVER = "loops"
const DEFAULT_ENDPOINT = "https://app.loops.so"
/** Loops truncates nothing — it rejects a longer key outright. */
const IDEMPOTENCY_KEY_LIMIT = 100

/**
 * Loops, over its transactional API.
 *
 * Loops is not a general mail transport. Every send names a transactional
 * email built in the Loops UI, and the API carries nothing but the
 * recipient and the `dataVariables` that email renders — no subject, no
 * body, no cc, no reply-to, no headers. So `template` is mandatory here
 * (or `transactionalId` as the driver default), and a message that carries
 * `text` or `html` is refused rather than delivered as a blank template.
 *
 * ```ts
 * const email = createEmail({ driver: loops({ apiKey }) })
 * await email.send({
 *   to: "ada@acme.com",
 *   subject: "ignored — Loops uses the template's",
 *   template: { id: "clfq6dinn000yl70fgwwyp82l", variables: { name: "Ada" } },
 * })
 * ```
 */
const loops: DriverFactory<LoopsOptions> = defineDriver<LoopsOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  async function sendOne(msg: NormalizedMessage, ctx: SendContext): Promise<Result<EmailResult>> {
    const transactionalId = msg.template?.id ?? msg.template?.alias ?? options.transactionalId
    const invalid = validate(msg, transactionalId)
    if (invalid) return err(invalid)

    const recipient = msg.to[0]!
    const body: Record<string, unknown> = {
      transactionalId,
      email: recipient.email,
    }
    if (options.addToAudience != null) body.addToAudience = options.addToAudience
    const dataVariables = toDataVariables(msg)
    if (Object.keys(dataVariables).length > 0) body.dataVariables = dataVariables
    if (msg.attachments.length > 0) body.attachments = msg.attachments.map(toLoopsAttachment)

    const response = await httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}/api/v1/transactional`,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(msg.idempotencyKey ? { "idempotency-key": msg.idempotencyKey } : {}),
      },
      body,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        const message = extractMessage(parsed)
        return { code: classifyStatus(status), ...(message ? { message } : {}) }
      },
    })
    if (response.error) return err(response.error)

    const parsed = (response.data ?? {}) as { success?: boolean; id?: string }
    if (parsed.success === false) {
      return err(
        createError(DRIVER, "PROVIDER", extractMessage(parsed) ?? "send failed", {
          retryable: false,
          cause: parsed,
        }),
      )
    }
    // Loops answers `{ "success": true }` and nothing else — there is no
    // provider-side id to report, so the result is keyed by the two things
    // that identify the send. Do not treat it as a handle: Loops has no
    // endpoint that takes one.
    const id = parsed.id ?? msg.idempotencyKey ?? `${transactionalId}:${recipient.email}`
    return ok({
      id,
      driver: DRIVER,
      ...(msg.stream ? { stream: msg.stream } : {}),
      at: new Date(),
      provider: parsed,
    })
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      // Loops renders the transactional email it holds; the message body
      // never leaves the caller's process.
      html: false,
      text: false,
      templates: true,
      idempotency: true,
    },

    isAvailable: () => Boolean(options.apiKey),

    send: sendOne,
  }
})

export default loops

/** Everything Loops cannot carry, refused before the request so nothing is
 *  quietly dropped between here and the recipient. */
function validate(msg: NormalizedMessage, transactionalId?: string): EmailError | null {
  if (!transactionalId) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      "Loops sends a transactional email by id — set `template.id` on the message or `transactionalId` on the driver",
    )
  }
  if (msg.text != null || msg.html != null) {
    return createError(
      DRIVER,
      "UNSUPPORTED",
      "Loops renders the transactional email named by `template.id`; a `text`/`html` body would be discarded — put the content in `template.variables`",
    )
  }
  if (msg.to.length !== 1) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `Loops sends to exactly one recipient per call, got ${msg.to.length}`,
    )
  }
  if (msg.cc.length > 0 || msg.bcc.length > 0) {
    return createUnsupportedError(DRIVER, "`cc`/`bcc` — set them on the Loops email instead")
  }
  if (msg.replyTo.length > 0) {
    return createUnsupportedError(DRIVER, "`replyTo` — set it on the Loops email instead")
  }
  if (msg.idempotencyKey && msg.idempotencyKey.length > IDEMPOTENCY_KEY_LIMIT) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `\`idempotencyKey\` may be at most ${IDEMPOTENCY_KEY_LIMIT} characters for Loops`,
    )
  }
  return null
}

/** Loops has one extension point, so tags and metadata land in it too —
 *  the Loops email can reference them in its From, Reply, CC, BCC and
 *  Subject fields, which is the only way those get set per send. */
function toDataVariables(msg: NormalizedMessage): Record<string, unknown> {
  const variables: Record<string, unknown> = { ...msg.metadata }
  for (const tag of msg.tags) variables[tag.name] = tag.value
  return Object.assign(variables, msg.template?.variables)
}

function toLoopsAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    filename: attachment.filename,
    contentType: attachment.contentType ?? "application/octet-stream",
    data: attachmentToBase64(attachment),
  }
}

/** Loops nests the useful half of a failure under `error`, leaving a
 *  generic sentence in `message`. */
function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const record = body as { message?: unknown; error?: { message?: unknown; reason?: unknown } }
  const nested = record.error
  const detail = typeof nested?.message === "string" ? nested.message : null
  const reason = typeof nested?.reason === "string" ? nested.reason : null
  const top = typeof record.message === "string" ? record.message : null
  const parts = [top, detail && reason ? `${detail} (${reason})` : (detail ?? reason)]
  const joined = parts.filter(Boolean).join(": ")
  return joined || null
}
