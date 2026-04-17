import type { Attachment, EmailAddress } from "../types.ts"

/** Unified shape every parser and inbound adapter produces. Mirrors the
 *  shape of \`postal-mime\` with the addresses normalized into our own
 *  \`EmailAddress\` struct. */
export interface ParsedEmail {
  messageId?: string
  date?: Date
  subject?: string
  from?: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  replyTo?: EmailAddress
  inReplyTo?: string
  references: string[]
  text?: string
  html?: string
  headers: Record<string, string>
  attachments: ParsedAttachment[]
}

/** Attachment discovered during parsing. \`content\` is the raw bytes. */
export interface ParsedAttachment extends Omit<Attachment, "content"> {
  content: Uint8Array
}

export interface ParseEmailOptions {
  /** Override the parser for tests. Defaults to the `postal-mime` peer. */
  parse?: (raw: unknown) => Promise<PostalMimeLike>
}

/** A subset of \`postal-mime\`'s result shape we actually read. */
interface PostalMimeLike {
  messageId?: string
  date?: string | Date
  subject?: string
  from?: { address?: string; name?: string }
  to?: Array<{ address?: string; name?: string }>
  cc?: Array<{ address?: string; name?: string }>
  bcc?: Array<{ address?: string; name?: string }>
  replyTo?: Array<{ address?: string; name?: string }> | { address?: string; name?: string }
  inReplyTo?: string
  references?: string | string[]
  text?: string
  html?: string
  headers?: Array<{ key: string; value: string }> | Record<string, string>
  attachments?: Array<{
    filename?: string
    mimeType?: string
    contentType?: string
    content?: Uint8Array | ArrayBuffer | string
    contentId?: string
    disposition?: string
  }>
}

/** Parse a raw MIME message into a \`ParsedEmail\`. Works on every runtime
 *  \`postal-mime\` supports (Node, Bun, Deno, browsers, Cloudflare Workers).
 *
 *  Accepts the same inputs \`postal-mime\`'s \`parse\` does: \`string\`,
 *  \`ArrayBuffer\`, \`Uint8Array\`, \`Blob\`, or a \`ReadableStream\`. */
export async function parseEmail(
  raw: unknown,
  options: ParseEmailOptions = {},
): Promise<ParsedEmail> {
  const parse = options.parse ?? (await resolvePostalMime())
  const mail = await parse(raw)
  return normalizeParsed(mail)
}

async function resolvePostalMime(): Promise<(raw: unknown) => Promise<PostalMimeLike>> {
  try {
    const mod = await import("postal-mime" as string)
    const PostalMime = (mod.default ?? mod.PostalMime ?? mod) as
      | { parse?: (raw: unknown) => Promise<PostalMimeLike> }
      | (new () => { parse: (raw: unknown) => Promise<PostalMimeLike> })
    // Static form (newer versions): `PostalMime.parse(raw)`.
    if (typeof (PostalMime as { parse?: unknown }).parse === "function") {
      return (PostalMime as { parse: (raw: unknown) => Promise<PostalMimeLike> }).parse.bind(
        PostalMime,
      )
    }
    // Instance form: `new PostalMime().parse(raw)`.
    if (typeof PostalMime === "function") {
      return async (raw) => {
        const instance = new (PostalMime as new () => {
          parse: (r: unknown) => Promise<PostalMimeLike>
        })()
        return instance.parse(raw)
      }
    }
    throw new Error("unsupported postal-mime export shape")
  } catch (err) {
    throw new Error(
      "[unemail/parse] requires `postal-mime` as a peer dependency. " +
        `Install it or pass \`parse\` via options. Original error: ${(err as Error).message}`,
    )
  }
}

export function normalizeParsed(mail: PostalMimeLike): ParsedEmail {
  const replyTo = Array.isArray(mail.replyTo) ? mail.replyTo[0] : mail.replyTo
  return {
    messageId: mail.messageId,
    date: mail.date ? new Date(mail.date) : undefined,
    subject: mail.subject,
    from: mail.from ? toAddress(mail.from) : undefined,
    to: (mail.to ?? []).map(toAddress),
    cc: (mail.cc ?? []).map(toAddress),
    bcc: (mail.bcc ?? []).map(toAddress),
    replyTo: replyTo ? toAddress(replyTo) : undefined,
    inReplyTo: mail.inReplyTo,
    references: normalizeRefs(mail.references),
    text: mail.text,
    html: mail.html,
    headers: normalizeHeaders(mail.headers),
    attachments: (mail.attachments ?? []).map(toAttachment),
  }
}

function toAddress(a: { address?: string; name?: string }): EmailAddress {
  return { email: a.address ?? "", name: a.name || undefined }
}

function normalizeRefs(refs: string | string[] | undefined): string[] {
  if (!refs) return []
  if (Array.isArray(refs)) return refs
  return refs.split(/\s+/).filter(Boolean)
}

function normalizeHeaders(
  headers: Array<{ key: string; value: string }> | Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {}
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {}
    for (const { key, value } of headers) out[key.toLowerCase()] = value
    return out
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
  return out
}

function toAttachment(a: {
  filename?: string
  mimeType?: string
  contentType?: string
  content?: Uint8Array | ArrayBuffer | string
  contentId?: string
  disposition?: string
}): ParsedAttachment {
  const content = normalizeContent(a.content)
  return {
    filename: a.filename ?? "attachment",
    contentType: a.mimeType ?? a.contentType,
    content,
    cid: a.contentId?.replace(/[<>]/g, ""),
    disposition: a.disposition === "inline" ? "inline" : "attachment",
  }
}

function normalizeContent(content: Uint8Array | ArrayBuffer | string | undefined): Uint8Array {
  if (!content) return new Uint8Array()
  if (content instanceof Uint8Array) return content
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  return new TextEncoder().encode(content)
}
