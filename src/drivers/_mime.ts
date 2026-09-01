import type { Attachment, EmailAddress, NormalizedMessage } from "../core/types.ts"
import { formatAddress } from "../core/address.ts"
import { getHeader } from "../core/message.ts"
import { attachmentToBase64, stringToBase64 } from "./_base64.ts"

/**
 * RFC 5322 / 2045 message builder, shared by SMTP (which transmits it) and
 * SES (which posts it as raw content). Zero dependencies and no Node
 * built-ins, so it runs unchanged in a Worker.
 *
 * @module
 */

export interface MimeInput {
  from: EmailAddress
  to: readonly EmailAddress[]
  cc: readonly EmailAddress[]
  bcc: readonly EmailAddress[]
  replyTo: readonly EmailAddress[]
  subject: string
  text?: string
  html?: string
  headers?: Readonly<Record<string, string>>
  attachments?: readonly Attachment[]
  date?: Date
  messageId: string
}

export interface MimeOutput {
  /** `MAIL FROM` and the `RCPT TO` list — to/cc/bcc merged and deduped.
   *  Bcc appears here and never in the rendered headers. */
  envelope: { from: string; rcpt: string[] }
  headers: Record<string, string>
  body: string
}

/** Adapt an already-normalized message for the builder. */
export function toMimeInput(
  msg: NormalizedMessage,
  messageId: string,
  date: Date = new Date(),
): MimeInput {
  return {
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    replyTo: msg.replyTo,
    subject: msg.subject,
    ...(msg.text == null ? {} : { text: msg.text }),
    ...(msg.html == null ? {} : { html: msg.html }),
    headers: msg.headers,
    attachments: msg.attachments,
    date,
    messageId,
  }
}

/** A `Message-ID` with the sending domain in it, which is what receivers
 *  expect and what DKIM alignment checks read. */
export function generateMessageId(domain: string): string {
  const random = Math.random().toString(36).slice(2, 12)
  const time = Date.now().toString(36)
  return `<${time}.${random}@${domain}>`
}

/** Read the caller's `Message-ID` if they set one, otherwise mint one. */
export function resolveMessageId(msg: NormalizedMessage, fallbackDomain: string): string {
  return getHeader(msg.headers, "message-id") ?? generateMessageId(fallbackDomain)
}

export function buildMime(input: MimeInput): MimeOutput {
  const mixedBoundary = boundary("mixed")
  const altBoundary = boundary("alt")
  const hasAttachments = (input.attachments?.length ?? 0) > 0
  const hasAlternatives = Boolean(input.text && input.html)

  const headers: Record<string, string> = {
    From: formatAddress(input.from),
    To: input.to.map(formatAddress).join(", "),
    Subject: encodeHeaderValue(input.subject),
    "Message-ID": input.messageId,
    Date: (input.date ?? new Date()).toUTCString(),
    "MIME-Version": "1.0",
  }
  if (input.cc.length > 0) headers.Cc = input.cc.map(formatAddress).join(", ")
  if (input.replyTo.length > 0) {
    headers["Reply-To"] = input.replyTo.map(formatAddress).join(", ")
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    // Bcc is an envelope concern; putting it in the document would show
    // every blind recipient to every other one.
    if (name.toLowerCase() === "bcc") continue
    headers[name] = value
  }

  const body = hasAttachments
    ? buildMixed(input, mixedBoundary, altBoundary, hasAlternatives, headers)
    : hasAlternatives
      ? buildAlternative(input, altBoundary, headers)
      : buildSingle(input, headers)

  return {
    envelope: {
      from: input.from.email,
      rcpt: [...new Set([...input.to, ...input.cc, ...input.bcc].map((a) => a.email))],
    },
    headers,
    body: renderHeaders(headers) + "\r\n" + body,
  }
}

/**
 * Dot-stuff a body for `DATA` per RFC 5321 §4.5.2 — a line that starts
 * with `.` gets a second one, so the payload can never contain the
 * `\r\n.\r\n` sequence that ends the transmission.
 */
export function dotStuff(body: string): string {
  return body.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..")
}

function buildSingle(input: MimeInput, headers: Record<string, string>): string {
  const isHtml = Boolean(input.html)
  headers["Content-Type"] = `text/${isHtml ? "html" : "plain"}; charset=utf-8`
  headers["Content-Transfer-Encoding"] = "quoted-printable"
  return encodeQuotedPrintable((isHtml ? input.html : input.text) ?? "")
}

function buildAlternative(
  input: MimeInput,
  bound: string,
  headers: Record<string, string>,
): string {
  headers["Content-Type"] = `multipart/alternative; boundary="${bound}"`
  const parts: string[] = []
  // Least-preferred first: a client picks the last part it can render.
  if (input.text) parts.push(part(bound, "text/plain", input.text))
  if (input.html) parts.push(part(bound, "text/html", input.html))
  parts.push(`--${bound}--`)
  return parts.join("\r\n")
}

function buildMixed(
  input: MimeInput,
  outer: string,
  inner: string,
  hasAlternatives: boolean,
  headers: Record<string, string>,
): string {
  headers["Content-Type"] = `multipart/mixed; boundary="${outer}"`
  const partHeaders: Record<string, string> = {}
  const content = hasAlternatives
    ? buildAlternative(input, inner, partHeaders)
    : buildSingle(input, partHeaders)

  const parts = [
    [
      `--${outer}`,
      `Content-Type: ${partHeaders["Content-Type"] ?? "text/plain; charset=utf-8"}`,
      ...(partHeaders["Content-Transfer-Encoding"]
        ? [`Content-Transfer-Encoding: ${partHeaders["Content-Transfer-Encoding"]}`]
        : []),
      "",
      content,
    ].join("\r\n"),
  ]
  for (const attachment of input.attachments ?? []) parts.push(renderAttachment(outer, attachment))
  parts.push(`--${outer}--`)
  return parts.join("\r\n")
}

function part(bound: string, contentType: string, content: string): string {
  return [
    `--${bound}`,
    `Content-Type: ${contentType}; charset=utf-8`,
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(content),
  ].join("\r\n")
}

function renderAttachment(bound: string, attachment: Attachment): string {
  const contentType = attachment.contentType ?? "application/octet-stream"
  const disposition = attachment.disposition ?? (attachment.cid ? "inline" : "attachment")
  const name = encodeHeaderValue(attachment.filename)
  const lines = [
    `--${bound}`,
    `Content-Type: ${contentType}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${name}"`,
  ]
  if (attachment.cid) lines.push(`Content-ID: <${attachment.cid}>`)
  lines.push("", foldBase64(attachmentToBase64(attachment.content)))
  return lines.join("\r\n")
}

function renderHeaders(headers: Record<string, string>): string {
  const lines: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === "") continue
    lines.push(`${name}: ${foldHeader(value)}`)
  }
  return lines.join("\r\n") + "\r\n"
}

/** RFC 5322 §2.1.1 caps a line at 998 octets; 76 keeps it comfortable and
 *  matches what every other mailer emits. */
function foldHeader(value: string, max = 76): string {
  if (value.length <= max) return value
  const lines: string[] = []
  let current = ""
  for (const word of value.split(" ")) {
    if (current && current.length + word.length + 1 > max) {
      lines.push(current)
      current = ` ${word}`
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  return lines.join("\r\n")
}

/** RFC 2047 encoded-word, so a non-ASCII subject survives the 7-bit
 *  header channel. */
function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?utf-8?B?${stringToBase64(value)}?=`
}

function encodeQuotedPrintable(input: string): string {
  const out: string[] = []
  for (const char of input) {
    if (char === "\n") {
      out.push("\r\n")
      continue
    }
    if (char === "\r") continue
    const code = char.codePointAt(0)!
    if (code === 0x20 || code === 0x09 || (code >= 0x21 && code <= 0x7e && char !== "=")) {
      out.push(char)
      continue
    }
    for (const byte of new TextEncoder().encode(char)) {
      out.push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    }
  }
  return softWrap(out.join(""), 76)
}

/** Wrap with soft line breaks, never splitting an `=XX` escape. */
function softWrap(input: string, max: number): string {
  return input
    .split("\r\n")
    .map((line) => {
      if (line.length <= max) return line
      const out: string[] = []
      let rest = line
      while (rest.length > max - 1) {
        let cut = max - 1
        while (cut > 0 && (rest[cut - 1] === "=" || (cut >= 2 && rest[cut - 2] === "="))) cut--
        out.push(`${rest.slice(0, cut)}=`)
        rest = rest.slice(cut)
      }
      out.push(rest)
      return out.join("\r\n")
    })
    .join("\r\n")
}

function foldBase64(value: string, width = 76): string {
  const chunks: string[] = []
  for (let i = 0; i < value.length; i += width) chunks.push(value.slice(i, i + width))
  return chunks.join("\r\n")
}

function boundary(kind: string): string {
  return `----unemail_${kind}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
}
