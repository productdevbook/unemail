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
import { formatAddress, formatAddressList } from "../core/address.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { stringToBase64 } from "./_base64.ts"
import { chunk } from "./_chunk.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface MailgunOptions {
  /** Account API key, or a domain sending key. */
  apiKey: string
  /** The sending domain, as it appears in the Mailgun dashboard. */
  domain: string
  /** Which Mailgun region the domain lives in. A domain created in the EU
   *  is not reachable on the US host at all. Default: `us`. */
  region?: "us" | "eu"
  /** Override the base URL — for a gateway or a test stub. Wins over
   *  `region`. */
  endpoint?: string
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Send every message in test mode — accepted and dropped. A message's
   *  own `sandbox` wins over this. */
  sandbox?: boolean
  /** Dedicated IP pool id for every message this driver sends. */
  ipPool?: string
}

const DRIVER = "mailgun"
const HOSTS = { us: "https://api.mailgun.net", eu: "https://api.eu.mailgun.net" } as const
/** "The maximum number of recipients allowed for batch is 1,000." */
const BATCH_LIMIT = 1000
/** "A single message may be marked with up to 3 tags." */
const TAG_LIMIT = 3
const TAG_LENGTH = 128

/**
 * Mailgun, over the Messages API.
 *
 * `sendBatch` uses Mailgun's own batch sending: messages that differ only
 * in their recipient go out as one request with `recipient-variables`, so
 * each person gets an individual copy rather than seeing the others in the
 * `To` header. Anything with attachments, cc, bcc or more than one
 * recipient keeps a request of its own — batch sending fans out on `to`
 * alone, and merging those would change who receives what.
 *
 * ```ts
 * createEmail({ driver: mailgun({ apiKey, domain: "mg.acme.com", region: "eu" }) })
 * ```
 */
const mailgun: DriverFactory<MailgunOptions> = defineDriver<MailgunOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  if (!options.domain) throw createRequiredError(DRIVER, "domain")
  const endpoint = (options.endpoint ?? HOSTS[options.region ?? "us"]).replace(/\/$/, "")
  const url = `${endpoint}/v3/${encodeURIComponent(options.domain)}/messages`
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  function post(form: FormData, ctx: SendContext) {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url,
      headers: { authorization: `Basic ${stringToBase64(`api:${options.apiKey}`)}` },
      // Multipart, not JSON: the Messages API takes files, and only fetch
      // knows the boundary it will write.
      bodyInit: form,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
      classify(status, parsed) {
        // A 401 answers with a bare JSON string rather than the usual
        // `{ message }` envelope, which would otherwise be reported as a
        // status code and nothing else.
        const message = typeof parsed === "string" ? parsed : null
        return { code: classifyStatus(status), ...(message ? { message } : {}) }
      },
    })
  }

  /** One request for a run of messages that differ only in recipient. */
  async function deliver(run: readonly Entry[], ctx: SendContext): Promise<Result<EmailResult>[]> {
    const form = new FormData()
    for (const [name, value] of run[0]!.fields) form.append(name, value)

    const recipients = run.flatMap((entry) => entry.msg.to)
    for (const address of recipients) form.append("to", formatAddress(address))
    for (const address of run[0]!.msg.cc) form.append("cc", formatAddress(address))
    for (const address of run[0]!.msg.bcc) form.append("bcc", formatAddress(address))
    for (const attachment of run[0]!.msg.attachments) appendAttachment(form, attachment)

    if (run.length > 1) {
      // Without recipient-variables Mailgun sends one message addressed to
      // everybody, so each recipient would see the whole list.
      form.append("recipient-variables", JSON.stringify(recipientVariables(recipients)))
    }

    const response = await post(form, ctx)
    if (response.error) return run.map(() => err<EmailResult>(response.error))

    const body = (response.data ?? {}) as { id?: string; message?: string }
    if (!body.id) {
      const missing = err<EmailResult>(
        createError(DRIVER, "PROVIDER", "response did not contain a message id", { cause: body }),
      )
      return run.map(() => missing)
    }
    // The send response quotes the Message-ID in angle brackets while every
    // other Mailgun API — events, logs, the message-id filter — spells the
    // same value without them.
    const id = body.id.replace(/^<|>$/g, "")
    return run.map((entry) => ok(toResult(id, entry.msg, body as Record<string, unknown>)))
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
    },

    isAvailable: () => Boolean(options.apiKey && options.domain),

    async send(msg, ctx) {
      const fields = toFields(msg, options)
      if (fields.error) return err(fields.error)
      return (await deliver([{ index: 0, msg, fields: fields.data }], ctx))[0]!
    },

    async sendBatch(msgs, ctx) {
      const results: (Result<EmailResult> | undefined)[] = Array.from({ length: msgs.length })
      const groups = new Map<string, Entry[]>()
      const solo: Entry[] = []

      for (const [index, msg] of msgs.entries()) {
        const fields = toFields(msg, options)
        if (fields.error) {
          results[index] = err(fields.error)
          continue
        }
        const entry: Entry = { index, msg, fields: fields.data }
        if (!canBatch(msg)) {
          solo.push(entry)
          continue
        }
        const key = JSON.stringify(fields.data)
        const group = groups.get(key)
        if (group) group.push(entry)
        else groups.set(key, [entry])
      }

      for (const group of groups.values()) {
        for (const run of chunk(group, BATCH_LIMIT)) {
          const produced = await deliver(run, ctx)
          for (const [slot, entry] of run.entries()) results[entry.index] = produced[slot]!
        }
      }
      for (const entry of solo) results[entry.index] = (await deliver([entry], ctx))[0]!
      return results.map(
        (result) =>
          result ?? err<EmailResult>(createError(DRIVER, "PROVIDER", "no result for message")),
      )
    },
  }
})

export default mailgun

/** A message and the form fields that are the same for everyone it could
 *  share a request with — everything but `to`, cc, bcc and attachments. */
interface Entry {
  index: number
  msg: NormalizedMessage
  fields: [string, string][]
}

/** Batch sending fans out on `to` and nothing else: a cc, a bcc or a second
 *  recipient would be copied to every individual message, and attachments
 *  cannot be compared cheaply enough to be sure two messages carry the
 *  same ones. */
function canBatch(msg: NormalizedMessage): boolean {
  return (
    msg.to.length === 1 &&
    msg.cc.length === 0 &&
    msg.bcc.length === 0 &&
    msg.attachments.length === 0
  )
}

function recipientVariables(
  recipients: readonly EmailAddress[],
): Record<string, Record<string, string>> {
  const variables: Record<string, Record<string, string>> = {}
  for (const address of recipients) {
    variables[address.email] = {
      email: address.email,
      ...(address.name ? { name: address.name } : {}),
    }
  }
  return variables
}

function toFields(
  msg: NormalizedMessage,
  options: MailgunOptions,
): { data: [string, string][]; error: null } | { data: null; error: EmailError } {
  if (msg.tags.length > TAG_LIMIT) {
    return {
      data: null,
      error: createError(
        DRIVER,
        "INVALID_OPTIONS",
        `at most ${TAG_LIMIT} tags per message; got ${msg.tags.length}`,
      ),
    }
  }
  const long = msg.tags.find((tag) => tag.name.length > TAG_LENGTH)
  if (long) {
    return {
      data: null,
      error: createError(
        DRIVER,
        "INVALID_OPTIONS",
        `tag "${long.name.slice(0, 32)}" is longer than ${TAG_LENGTH} characters`,
      ),
    }
  }

  const fields: [string, string][] = [
    ["from", formatAddress(msg.from)],
    ["subject", msg.subject ?? ""],
  ]
  if (msg.text != null) fields.push(["text", msg.text])
  if (msg.html != null) fields.push(["html", msg.html])
  if (msg.replyTo.length > 0) fields.push(["h:Reply-To", formatAddressList(msg.replyTo)])
  for (const [name, value] of Object.entries(msg.headers)) fields.push([`h:${name}`, value])
  // Mailgun echoes `v:` variables back as `user-variables` on every event
  // the message produces.
  for (const [name, value] of Object.entries(msg.metadata)) fields.push([`v:${name}`, value])
  // A tag has no value of its own here, so the pair is carried as a
  // variable too rather than dropping half of what the caller set.
  for (const tag of msg.tags) {
    fields.push(["o:tag", tag.name])
    fields.push([`v:${tag.name}`, tag.value])
  }

  if (msg.template) {
    // Mailgun addresses stored templates by name, which is what `alias`
    // means everywhere else in this library.
    const name = msg.template.alias ?? msg.template.id
    if (!name) {
      return {
        data: null,
        error: createError(
          DRIVER,
          "INVALID_OPTIONS",
          "`template.alias` or `template.id` is required",
        ),
      }
    }
    fields.push(["template", name])
    if (msg.template.variables) {
      fields.push(["t:variables", JSON.stringify(msg.template.variables)])
    }
  }

  // RFC 2822, which is what `o:deliverytime` parses.
  if (msg.scheduledAt) fields.push(["o:deliverytime", msg.scheduledAt.toUTCString()])
  if (msg.sandbox ?? options.sandbox) fields.push(["o:testmode", "yes"])
  if (msg.tracking?.opens != null) fields.push(["o:tracking-opens", yesNo(msg.tracking.opens)])
  if (msg.tracking?.clicks != null) fields.push(["o:tracking-clicks", yesNo(msg.tracking.clicks)])
  if (options.ipPool) fields.push(["o:sending-ip-pool", options.ipPool])

  return { data: fields, error: null }
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no"
}

function appendAttachment(form: FormData, attachment: Attachment): void {
  const blob = toBlob(attachment)
  // Mailgun derives an inline part's Content-ID from its filename, so a
  // `cid` has to become the name for `<img src="cid:...">` to resolve.
  const inline =
    attachment.cid ?? (attachment.disposition === "inline" ? attachment.filename : null)
  if (inline) form.append("inline", blob, inline)
  else form.append("attachment", blob, attachment.filename)
}

function toBlob(attachment: Attachment): Blob {
  const type = attachment.contentType ?? "application/octet-stream"
  const content = attachment.content
  if (content == null) {
    // The core refuses a url attachment before a driver without
    // `features.remoteAttachments` is reached.
    throw new Error(`[unemail] [mailgun] attachment ${attachment.filename} has no content`)
  }
  if (typeof content !== "string") return new Blob([copyBytes(content)], { type })
  // A string is text unless the caller declared it encoded; decoding it
  // here is what keeps the bytes on the wire identical to what every other
  // driver sends for the same attachment.
  return attachment.encoding === "base64"
    ? new Blob([base64ToBytes(content)], { type })
    : new Blob([content], { type })
}

/** Blob will not take a view that might sit over a `SharedArrayBuffer`. */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
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
