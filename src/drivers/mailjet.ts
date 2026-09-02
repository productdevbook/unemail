import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
} from "../core/types.ts"
import type { EmailError } from "../core/error.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { attachmentToBase64, stringToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface MailjetOptions {
  /** `MJ_APIKEY_PUBLIC`. */
  apiKey: string
  /** `MJ_APIKEY_PRIVATE`. */
  apiSecret: string
  /** Override the base URL — for a gateway or a test stub. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Validate every message without delivering it. A message's own
   *  `sandbox` wins over this. */
  sandbox?: boolean
}

const DRIVER = "mailjet"
/** "MAX RECIPIENTS: 50", counted across `To`, `Cc` and `Bcc` together, and
 *  enforced over the whole request rather than one message: 77 messages of
 *  one recipient each are refused with "Total number of recipients
 *  exceeded. Max allowed - 50". The `Messages` array's own documented cap
 *  is 100, which this one always reaches first. */
const RECIPIENT_LIMIT = 50
/** "Maximum length is 255 chars". */
const SUBJECT_LENGTH = 255
/** Headers Mailjet sets itself, or that have a dedicated message property;
 *  either one fails the message with `send-0011`. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "from",
  "sender",
  "subject",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "return-path",
  "delivered-to",
  "dkim-signature",
  "domainkey-status",
  "received-spf",
  "authentication-results",
  "received",
  "date",
  "message-id",
  "user-agent",
  "x-mailer",
  "list-id",
  "x-csa-complaints",
  "x-feedback-id",
  "x-mailjet-prio",
  "x-mailjet-debug",
  "x-mailjet-campaign",
  "x-mailjet-segmentation",
  "x-mailjet-trackopen",
  "x-mailjet-trackclick",
  "x-mj-customid",
  "x-mj-eventpayload",
  "x-mj-vars",
  "x-mj-templateid",
  "x-mj-templatelanguage",
  "x-mj-templateerrordeliver",
  "x-mj-templateerrorreporting",
  "x-mj-workflowid",
  "x-mj-mid",
  "x-mj-errormessage",
  "x-mj-statisticscontactslistid",
])

/**
 * Mailjet, over the Send API v3.1.
 *
 * The `Messages` array *is* the batch — one request carries many messages
 * and answers with a status object per message, in the order they were
 * sent. That maps straight onto the positional `sendBatch` contract, with
 * no grouping heuristics and no guessing which id belongs to whom.
 *
 * ```ts
 * createEmail({ driver: mailjet({ apiKey, apiSecret }) })
 * ```
 */
const mailjet: DriverFactory<MailjetOptions> = defineDriver<MailjetOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  if (!options.apiSecret) throw createRequiredError(DRIVER, "apiSecret")
  const endpoint = (options.endpoint ?? "https://api.mailjet.com").replace(/\/$/, "")
  const fetchImpl = resolveFetch(DRIVER, options.fetch)
  const authorization = `Basic ${stringToBase64(`${options.apiKey}:${options.apiSecret}`)}`

  async function deliver(
    run: readonly Entry[],
    sandbox: boolean,
    ctx: SendContext,
  ): Promise<Result<EmailResult>[]> {
    const response = await httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${endpoint}/v3.1/send`,
      headers: { authorization },
      body: {
        Messages: run.map((entry) => toMessage(entry.msg)),
        // SandboxMode is a root property of the payload, not of a message.
        ...(sandbox ? { SandboxMode: true } : {}),
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
    })

    // A batch where any message failed is answered with 400, not 200 — and
    // the body still carries the whole `Messages` array, the accepted ones
    // included. Reading the status alone would report every message in the
    // request as failed, including the ones Mailjet has already sent.
    const entries = messagesOf(response.error ? causeBody(response.error) : response.data)
    if (!entries || entries.length !== run.length) {
      const failure =
        response.error ??
        createError(DRIVER, "PROVIDER", "response carried no Messages array", {
          cause: response.data,
        })
      return run.map(() => err<EmailResult>(failure))
    }
    return run.map((entry, slot) => toResult(entries[slot]!, entry.msg, sandbox))
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

    isAvailable: () => Boolean(options.apiKey && options.apiSecret),

    async send(msg, ctx) {
      const refusal = checkLimits(msg)
      if (refusal) return err(refusal)
      const sandbox = msg.sandbox ?? options.sandbox ?? false
      return (await deliver([{ index: 0, msg }], sandbox, ctx))[0]!
    },

    async sendBatch(msgs, ctx) {
      const results: (Result<EmailResult> | undefined)[] = Array.from({ length: msgs.length })
      // Sandbox is settled per request, so a validated-only message cannot
      // share one with a message that is meant to go out.
      const groups = new Map<boolean, Entry[]>()
      for (const [index, msg] of msgs.entries()) {
        const refusal = checkLimits(msg)
        if (refusal) {
          results[index] = err(refusal)
          continue
        }
        const sandbox = msg.sandbox ?? options.sandbox ?? false
        const group = groups.get(sandbox)
        if (group) group.push({ index, msg })
        else groups.set(sandbox, [{ index, msg }])
      }

      for (const [sandbox, group] of groups) {
        for (const run of splitRuns(group)) {
          const produced = await deliver(run, sandbox, ctx)
          for (const [slot, entry] of run.entries()) results[entry.index] = produced[slot]!
        }
      }
      return results.map(
        (result) =>
          result ?? err<EmailResult>(createError(DRIVER, "PROVIDER", "no result for message")),
      )
    },
  }
})

export default mailjet

/** A message and the slot in the caller's list it has to be reported back
 *  into once the requests have been split. */
interface Entry {
  index: number
  msg: NormalizedMessage
}

interface MailjetRecipient {
  Email?: string
  MessageUUID?: string
  MessageID?: number
  MessageHref?: string
}

interface MailjetError {
  ErrorIdentifier?: string
  ErrorCode?: string
  StatusCode?: number
  ErrorMessage?: string
  ErrorRelatedTo?: string[]
}

interface MailjetMessage {
  Status?: string
  CustomID?: string
  To?: MailjetRecipient[]
  Cc?: MailjetRecipient[]
  Bcc?: MailjetRecipient[]
  Errors?: MailjetError[]
}

/** What Mailjet would reject the message for, checked here so the caller is
 *  told which field and which limit rather than reading `mj-0006` off a
 *  400. */
function checkLimits(msg: NormalizedMessage): EmailError | null {
  if (msg.subject != null && msg.subject.length > SUBJECT_LENGTH) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `\`subject\` is longer than ${SUBJECT_LENGTH} characters`,
    )
  }
  const recipients = recipientCount(msg)
  if (recipients > RECIPIENT_LIMIT) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `at most ${RECIPIENT_LIMIT} recipients across to, cc and bcc; got ${recipients}`,
    )
  }
  // Mailjet's ReplyTo is one address, not a list. Sending the first and
  // dropping the rest would lose a reply route without telling anyone.
  if (msg.replyTo.length > 1) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      `Mailjet accepts a single \`replyTo\`; got ${msg.replyTo.length}`,
    )
  }
  const forbidden = Object.keys(msg.headers).find((name) =>
    FORBIDDEN_HEADERS.has(name.toLowerCase()),
  )
  if (forbidden) {
    return createError(DRIVER, "INVALID_OPTIONS", `header "${forbidden}" may not be overridden`)
  }
  if (msg.template && !templateId(msg.template.id)) {
    return createError(
      DRIVER,
      "INVALID_OPTIONS",
      "`template.id` must be Mailjet's numeric template id — it has no aliases",
    )
  }
  return null
}

/** "If a recipient is specified twice (in the to, cc, or bcc), it is
 *  counted only once." */
function recipientCount(msg: NormalizedMessage): number {
  const seen = new Set<string>()
  for (const address of [...msg.to, ...msg.cc, ...msg.bcc]) seen.add(address.email.toLowerCase())
  return seen.size
}

/** Split a run of messages into requests the recipient cap will not refuse.
 *  Counting messages is not enough: the cap is on the recipients across the
 *  whole payload, and one message may carry fifty of them. */
function splitRuns(entries: readonly Entry[]): Entry[][] {
  const runs: Entry[][] = []
  let current: Entry[] = []
  let recipients = 0

  for (const entry of entries) {
    const count = recipientCount(entry.msg)
    if (current.length > 0 && recipients + count > RECIPIENT_LIMIT) {
      runs.push(current)
      current = []
      recipients = 0
    }
    current.push(entry)
    recipients += count
  }
  if (current.length > 0) runs.push(current)
  return runs
}

function toMessage(msg: NormalizedMessage): Record<string, unknown> {
  const message: Record<string, unknown> = {
    From: toAddress(msg.from),
    To: msg.to.map(toAddress),
  }
  if (msg.cc.length > 0) message.Cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) message.Bcc = msg.bcc.map(toAddress)
  if (msg.replyTo[0]) message.ReplyTo = toAddress(msg.replyTo[0])
  if (msg.subject != null) message.Subject = msg.subject
  if (msg.text != null) message.TextPart = msg.text
  if (msg.html != null) message.HTMLPart = msg.html

  const template = templateId(msg.template?.id)
  if (template != null) message.TemplateID = template
  if (msg.template?.variables) {
    // Template language processing is off by default, and without it the
    // recipient reads the raw `{{var:…}}` markers instead of the values.
    message.TemplateLanguage = true
    message.Variables = { ...msg.template.variables }
  }

  const files = msg.attachments.filter((attachment) => !attachment.cid)
  const inlined = msg.attachments.filter((attachment) => attachment.cid)
  if (files.length > 0) message.Attachments = files.map(toMailjetAttachment)
  if (inlined.length > 0) {
    message.InlinedAttachments = inlined.map((attachment) => ({
      ...toMailjetAttachment(attachment),
      ContentID: attachment.cid,
    }))
  }

  if (Object.keys(msg.headers).length > 0) message.Headers = { ...msg.headers }
  // CustomID is the handle Mailjet echoes on every event for the message
  // and indexes it by; it does not deduplicate, so `features.idempotency`
  // stays off.
  if (msg.idempotencyKey) message.CustomID = msg.idempotencyKey
  // A campaign is a bare name, so every tag — the first one included — is
  // also carried in the payload. Otherwise tag[0].value would be the one
  // thing the caller set that reached nobody.
  if (msg.tags[0]) message.CustomCampaign = msg.tags[0].name
  const payload: Record<string, string> = { ...msg.metadata }
  for (const tag of msg.tags) payload[tag.name] = tag.value
  if (Object.keys(payload).length > 0) message.EventPayload = JSON.stringify(payload)

  // Both are rejected outright when there is no HTML part to instrument.
  if (msg.html != null || msg.template) {
    if (msg.tracking?.opens != null) {
      message.TrackOpens = msg.tracking.opens ? "enabled" : "disabled"
    }
    if (msg.tracking?.clicks != null) {
      message.TrackClicks = msg.tracking.clicks ? "enabled" : "disabled"
    }
  }
  return message
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name ? { Email: address.email, Name: address.name } : { Email: address.email }
}

function toMailjetAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    ContentType: attachment.contentType ?? "application/octet-stream",
    Filename: attachment.filename,
    Base64Content: attachmentToBase64(attachment),
  }
}

function toResult(
  entry: MailjetMessage,
  msg: NormalizedMessage,
  sandbox: boolean,
): Result<EmailResult> {
  if (entry.Status !== "success") {
    const errors = entry.Errors ?? []
    const message =
      errors.map(describeError).filter(Boolean).join("; ") ||
      `message status "${entry.Status ?? "unknown"}"`
    const status = errors[0]?.StatusCode
    return err(
      createError(DRIVER, status == null ? "PROVIDER" : classifyStatus(status), message, {
        ...(status == null ? {} : { status }),
        cause: entry,
      }),
    )
  }

  const recipient = entry.To?.[0] ?? entry.Cc?.[0] ?? entry.Bcc?.[0]
  // Sandbox validates and drops the message, so it comes back accepted with
  // an empty MessageUUID and a MessageID of 0 — a missing id there is the
  // documented answer, not a broken response.
  const id =
    recipient?.MessageUUID ||
    (recipient?.MessageID ? String(recipient.MessageID) : "") ||
    (sandbox ? "sandbox" : "")
  if (!id) {
    return err(createError(DRIVER, "PROVIDER", "response carried no MessageUUID", { cause: entry }))
  }
  return ok({
    id,
    driver: DRIVER,
    ...(msg.stream ? { stream: msg.stream } : {}),
    at: new Date(),
    provider: entry as Record<string, unknown>,
  })
}

/** Mailjet reports every problem with a message at once and names the
 *  properties each one is about; keeping only the first would send the
 *  caller back for another round trip per mistake. */
function describeError(error: MailjetError): string {
  const message = error.ErrorMessage ?? error.ErrorCode ?? ""
  const related = error.ErrorRelatedTo
  return related && related.length > 0 ? `${related.join(", ")}: ${message}` : message
}

function messagesOf(body: unknown): MailjetMessage[] | null {
  if (!body || typeof body !== "object") return null
  const messages = (body as { Messages?: unknown }).Messages
  return Array.isArray(messages) ? (messages as MailjetMessage[]) : null
}

/** The parsed body of a failed request. `httpJson` leaves it on the error's
 *  cause, which is the only way to reach a per-message report that arrived
 *  alongside a 400. */
function causeBody(error: EmailError): unknown {
  const cause = error.cause
  return cause && typeof cause === "object" ? (cause as { body?: unknown }).body : null
}

/** Mailjet addresses templates by a numeric id. A non-numeric one is a
 *  caller mistake, not something to send and have rejected. */
function templateId(id: string | undefined): number | null {
  if (id == null) return null
  const numeric = Number(id)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null
}
