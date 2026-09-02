import type { EmailAddress, EmailMessage, NormalizedMessage } from "./types.ts"
import { dedupeAddresses, isValidEmail, toAddressList } from "./address.ts"
import { createError } from "./error.ts"

/** Fields an instance can supply once instead of on every message. */
export type MessageDefaults = Pick<
  EmailMessage,
  "from" | "replyTo" | "headers" | "tags" | "metadata" | "stream"
>

const CORE = "unemail"

/**
 * Turn user input into the shape drivers consume: addresses parsed, lists
 * always present, headers validated, derived headers applied.
 *
 * This runs exactly once per message, at the edge of the library. It is
 * why no driver in this repo parses an address or guards a header.
 *
 * Throws `EmailError(INVALID_OPTIONS)`; `createEmail()` catches and
 * returns it as a `Result`, so callers still never see a throw.
 */
export function normalizeMessage(
  input: EmailMessage,
  defaults: MessageDefaults = {},
): NormalizedMessage {
  const fromList = toAddressList(input.from ?? defaults.from)
  const from = fromList[0]
  if (!from) throw invalid("`from` is required (set it on the message or as an instance default)")

  const to = dedupeAddresses(toAddressList(input.to))
  if (to.length === 0) throw invalid("`to` must contain at least one recipient")

  // Deduped across fields, not just within them: an address left in both
  // `to` and `cc` is one copy on the SMTP/SES envelope but two entries for
  // an API driver, so the same message would behave differently depending
  // on which transport happened to be configured.
  const cc = without(dedupeAddresses(toAddressList(input.cc)), to)
  const bcc = without(dedupeAddresses(toAddressList(input.bcc)), [...to, ...cc])
  const replyTo = dedupeAddresses(toAddressList(input.replyTo ?? defaults.replyTo))

  for (const [field, list] of [
    ["from", [from]],
    ["to", to],
    ["cc", cc],
    ["bcc", bcc],
    ["replyTo", replyTo],
  ] as const) {
    for (const address of list) {
      if (!isValidEmail(address.email)) {
        throw invalid(`\`${field}\` contains an invalid address: ${JSON.stringify(address.email)}`)
      }
    }
  }

  // A template carries its own subject, and a subject sent alongside one
  // overrides it — which is almost never what the caller meant.
  if (input.subject == null && input.template == null) {
    throw invalid("`subject` is required unless `template` is set")
  }
  if (input.subject != null && typeof input.subject !== "string") {
    throw invalid("`subject` must be a string")
  }

  const hasBody =
    input.text != null ||
    input.html != null ||
    input.content != null ||
    input.raw != null ||
    input.template != null
  if (!hasBody) {
    throw invalid("message has no body — set one of `text`, `html`, `content`, `template`, `raw`")
  }

  for (const [index, attachment] of (input.attachments ?? []).entries()) {
    const hasContent = attachment.content != null
    const hasUrl = attachment.url != null
    if (hasContent === hasUrl) {
      throw invalid(
        `attachments[${index}] must set exactly one of \`content\` and \`url\`` +
          (hasContent ? ", not both" : ""),
      )
    }
  }

  const headers = buildHeaders(input, defaults)
  const html =
    input.preheader && input.html ? injectPreheader(input.html, input.preheader) : input.html

  const message: NormalizedMessage = {
    ...((input.stream ?? defaults.stream) ? { stream: input.stream ?? defaults.stream } : {}),
    from,
    to,
    cc,
    bcc,
    replyTo,
    ...(input.subject == null ? {} : { subject: input.subject }),
    ...(input.text == null ? {} : { text: input.text }),
    ...(html == null ? {} : { html }),
    ...(input.content == null ? {} : { content: input.content }),
    headers,
    attachments: input.attachments ?? [],
    tags: [...(defaults.tags ?? []), ...(input.tags ?? [])],
    metadata: { ...defaults.metadata, ...input.metadata },
    ...(input.idempotencyKey == null ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(input.scheduledAt == null ? {} : { scheduledAt: parseDate(input.scheduledAt) }),
    ...(input.template == null ? {} : { template: input.template }),
    ...(input.tracking == null ? {} : { tracking: input.tracking }),
    ...(input.sandbox == null ? {} : { sandbox: input.sandbox }),
    ...(input.raw == null ? {} : { raw: input.raw }),
  }

  return Object.freeze(message)
}

/** Derive a new message from a normalized one. The only supported way for
 *  middleware to change a message — the caller's object is never touched,
 *  so a template object stays reusable across sends. */
export function patchMessage(
  message: NormalizedMessage,
  patch: Partial<NormalizedMessage>,
): NormalizedMessage {
  return Object.freeze({ ...message, ...patch })
}

/** Case-insensitive header lookup, since callers write `Message-ID`,
 *  `message-id`, and `Message-Id` interchangeably. */
export function getHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

/** True when a header is already set under any casing. */
export function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return getHeader(headers, name) !== undefined
}

function buildHeaders(
  input: EmailMessage,
  defaults: MessageDefaults,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { ...defaults.headers, ...input.headers }

  for (const [name, value] of Object.entries(headers)) {
    // A newline in a header value lets a caller append arbitrary headers
    // (and a body) to the message — RFC 5322 §2.2 forbids it outright.
    if (/[\r\n]/.test(value) || /[\r\n:]/.test(name)) {
      throw invalid(`header ${JSON.stringify(name)} contains a line break`)
    }
  }

  const unsubscribe = input.unsubscribe
  if (unsubscribe && (unsubscribe.url || unsubscribe.mailto)) {
    const parts: string[] = []
    if (unsubscribe.url) parts.push(`<${unsubscribe.url}>`)
    if (unsubscribe.mailto) parts.push(`<mailto:${unsubscribe.mailto}>`)
    if (!hasHeader(headers, "list-unsubscribe")) headers["List-Unsubscribe"] = parts.join(", ")
    const oneClick = unsubscribe.oneClick ?? Boolean(unsubscribe.url)
    if (oneClick && unsubscribe.url && !hasHeader(headers, "list-unsubscribe-post")) {
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    }
  }

  return Object.freeze(headers)
}

/** Hidden span most clients read as the preview line. The trailing
 *  zero-width joiners stop the client from spilling body text into the
 *  preview after the preheader ends. */
function injectPreheader(html: string, preheader: string): string {
  const block =
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">` +
    `${escapeHtml(preheader)}${"&#8204;&nbsp;".repeat(60)}</div>`
  const bodyOpen = /<body[^>]*>/i.exec(html)
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length
    return html.slice(0, at) + block + html.slice(at)
  }
  return block + html
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function parseDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw invalid(`\`scheduledAt\` is not a valid date: ${value}`)
  return date
}

/** Drop every address already present in `taken`. */
function without(
  addresses: readonly EmailAddress[],
  taken: readonly EmailAddress[],
): EmailAddress[] {
  const seen = new Set(taken.map((address) => address.email.toLowerCase()))
  return addresses.filter((address) => !seen.has(address.email.toLowerCase()))
}

function invalid(message: string) {
  return createError(CORE, "INVALID_OPTIONS", message)
}
