import type { Attachment, EmailAddress, EmailMessage } from "../../types.ts"
import { formatAddress, normalizeAddresses } from "../../_normalize.ts"

/** Inputs used to assemble the MIME document. Kept separate from
 *  `EmailMessage` so the builder can be unit-tested in isolation. */
export interface MimeInput {
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  replyTo: EmailAddress[]
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: ReadonlyArray<Attachment>
  date?: Date
  messageId?: string
}

/** Output of `buildMime()` — the serialized RFC 5322 message plus the list
 *  of envelope recipients (to/cc/bcc merged) for `RCPT TO`. */
export interface MimeOutput {
  envelope: {
    from: string
    rcpt: string[]
  }
  body: string
  headers: Record<string, string>
}

export function normalizeMimeInput(
  msg: EmailMessage,
  messageId: string,
  date: Date = new Date(),
): MimeInput {
  const fromList = normalizeAddresses(msg.from)
  const from = fromList[0]
  if (!from) throw new Error("`from` is required")
  return {
    from,
    to: normalizeAddresses(msg.to),
    cc: normalizeAddresses(msg.cc),
    bcc: normalizeAddresses(msg.bcc),
    replyTo: normalizeAddresses(msg.replyTo),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers: msg.headers,
    attachments: msg.attachments,
    date,
    messageId,
  }
}

export function buildMime(input: MimeInput): MimeOutput {
  const boundary = `----unemail_${randomBoundary()}`
  const altBoundary = `----unemail_alt_${randomBoundary()}`
  const hasAttachments = (input.attachments?.length ?? 0) > 0
  const hasBothBodies = Boolean(input.text && input.html)

  const headers: Record<string, string> = {
    From: formatAddress(input.from),
    To: input.to.map(formatAddress).join(", "),
    Subject: encodeHeader(input.subject),
    "Message-ID": input.messageId ?? "",
    Date: (input.date ?? new Date()).toUTCString(),
    "MIME-Version": "1.0",
  }
  if (input.cc.length) headers.Cc = input.cc.map(formatAddress).join(", ")
  if (input.replyTo.length) headers["Reply-To"] = input.replyTo.map(formatAddress).join(", ")
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) headers[k] = v
  }

  const body = hasAttachments
    ? buildMultipartMixed(input, boundary, altBoundary, hasBothBodies, headers)
    : hasBothBodies
      ? buildMultipartAlternative(input, altBoundary, headers)
      : buildSinglePart(input, headers)

  const rendered = renderHeaders(headers) + "\r\n" + body

  return {
    envelope: {
      from: input.from.email,
      rcpt: dedupe([...input.to, ...input.cc, ...input.bcc].map((a) => a.email)),
    },
    headers,
    body: rendered,
  }
}

function renderHeaders(headers: Record<string, string>): string {
  const lines: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === "") continue
    lines.push(`${name}: ${foldHeader(value)}`)
  }
  return lines.join("\r\n") + "\r\n"
}

function buildSinglePart(input: MimeInput, headers: Record<string, string>): string {
  if (input.html) {
    headers["Content-Type"] = "text/html; charset=utf-8"
    headers["Content-Transfer-Encoding"] = "quoted-printable"
    return encodeQuotedPrintable(input.html)
  }
  headers["Content-Type"] = "text/plain; charset=utf-8"
  headers["Content-Transfer-Encoding"] = "quoted-printable"
  return encodeQuotedPrintable(input.text ?? "")
}

function buildMultipartAlternative(
  input: MimeInput,
  boundary: string,
  headers: Record<string, string>,
): string {
  headers["Content-Type"] = `multipart/alternative; boundary="${boundary}"`
  const parts: string[] = []
  if (input.text) {
    parts.push(
      [
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        encodeQuotedPrintable(input.text),
      ].join("\r\n"),
    )
  }
  if (input.html) {
    parts.push(
      [
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        encodeQuotedPrintable(input.html),
      ].join("\r\n"),
    )
  }
  parts.push(`--${boundary}--`)
  return parts.join("\r\n")
}

function buildMultipartMixed(
  input: MimeInput,
  outerBoundary: string,
  altBoundary: string,
  hasBothBodies: boolean,
  headers: Record<string, string>,
): string {
  headers["Content-Type"] = `multipart/mixed; boundary="${outerBoundary}"`
  const parts: string[] = []

  const altHeaders: Record<string, string> = {}
  const bodyPart = hasBothBodies
    ? buildMultipartAlternative(input, altBoundary, altHeaders)
    : buildSinglePart(input, altHeaders)

  parts.push(
    [
      `--${outerBoundary}`,
      `Content-Type: ${altHeaders["Content-Type"] ?? "text/plain; charset=utf-8"}`,
      ...(altHeaders["Content-Transfer-Encoding"]
        ? [`Content-Transfer-Encoding: ${altHeaders["Content-Transfer-Encoding"]}`]
        : []),
      "",
      bodyPart,
    ].join("\r\n"),
  )

  for (const a of input.attachments ?? []) {
    parts.push(renderAttachment(outerBoundary, a))
  }
  parts.push(`--${outerBoundary}--`)
  return parts.join("\r\n")
}

function renderAttachment(boundary: string, a: Attachment): string {
  const base64 =
    typeof a.content === "string"
      ? isLikelyBase64(a.content)
        ? a.content
        : toBase64FromString(a.content)
      : toBase64FromBytes(a.content)
  const folded = foldBase64(base64)
  const contentType = a.contentType ?? "application/octet-stream"
  const disposition = a.disposition ?? "attachment"
  const lines = [
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${encodeHeader(a.filename)}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${encodeHeader(a.filename)}"`,
  ]
  if (a.cid) lines.push(`Content-ID: <${a.cid}>`)
  lines.push("", folded)
  return lines.join("\r\n")
}

/** Dot-stuff a body for DATA transmission per RFC 5321 §4.5.2. Lines that
 *  begin with `.` get an extra `.` prepended so the sequence `\r\n.\r\n`
 *  never appears inside the payload. Returns a single string with CRLF
 *  line endings. */
export function dotStuff(body: string): string {
  const crlfBody = body.replace(/\r?\n/g, "\r\n")
  return crlfBody.replace(/(^|\r\n)(\.)/g, "$1.$2")
}

function foldHeader(value: string, max = 76): string {
  if (value.length <= max) return value
  const words = value.split(" ")
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (current.length + word.length + 1 > max) {
      lines.push(current)
      current = ` ${word}`
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  return lines.join("\r\n")
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  const b64 = toBase64FromString(value)
  return `=?utf-8?B?${b64}?=`
}

function encodeQuotedPrintable(input: string): string {
  const out: string[] = []
  for (const ch of input) {
    const code = ch.codePointAt(0)!
    if (ch === "\n") {
      out.push("\r\n")
      continue
    }
    if (ch === "\r") continue
    if (code === 0x20 || code === 0x09) {
      out.push(ch)
      continue
    }
    if (code >= 0x21 && code <= 0x7e && ch !== "=") {
      out.push(ch)
      continue
    }
    const bytes = new TextEncoder().encode(ch)
    for (const b of bytes) out.push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`)
  }
  return softWrap(out.join(""), 76)
}

function softWrap(input: string, max: number): string {
  const lines = input.split(/\r\n/)
  return lines
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

function toBase64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value)
  return toBase64FromBytes(bytes)
}

function toBase64FromBytes(bytes: Uint8Array): string {
  const g = globalThis as {
    Buffer?: { from: (b: Uint8Array) => { toString: (enc: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length > 0 && value.length % 4 === 0
}

function foldBase64(b64: string, width = 76): string {
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += width) chunks.push(b64.slice(i, i + width))
  return chunks.join("\r\n")
}

function randomBoundary(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
