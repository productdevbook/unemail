import type { ParsedEmail } from "../parse/index.ts"
import type { InboundAdapter } from "./index.ts"
import type { EmailAddress } from "../types.ts"

/** Postmark inbound-webhook adapter. Postmark delivers JSON, not raw MIME,
 *  so we translate its schema straight to \`ParsedEmail\` without touching
 *  postal-mime. */
export interface PostmarkInboundOptions {
  /** Postmark's inbound URL can be protected by HTTP Basic auth — pass
   *  the expected \`"user:pass"\` here to enable verification. */
  basicAuth?: string
}

interface PostmarkInboundPayload {
  MessageID?: string
  Date?: string
  Subject?: string
  From?: string
  FromFull?: { Email?: string; Name?: string }
  To?: string
  ToFull?: Array<{ Email?: string; Name?: string }>
  Cc?: string
  CcFull?: Array<{ Email?: string; Name?: string }>
  Bcc?: string
  BccFull?: Array<{ Email?: string; Name?: string }>
  ReplyTo?: string
  TextBody?: string
  HtmlBody?: string
  Headers?: Array<{ Name?: string; Value?: string }>
  Attachments?: Array<{
    Name?: string
    Content?: string
    ContentType?: string
    ContentID?: string
  }>
}

export default function postmarkInbound(options: PostmarkInboundOptions = {}): InboundAdapter {
  return {
    name: "postmark-inbound",
    accepts(request) {
      if (request.method !== "POST") return false
      return (request.headers.get("user-agent") ?? "").toLowerCase().includes("postmark")
    },
    verify(request) {
      if (!options.basicAuth) return true
      const auth = request.headers.get("authorization") ?? ""
      if (!auth.startsWith("Basic ")) return false
      const decoded = atobSafe(auth.slice(6))
      return decoded === options.basicAuth
    },
    async parse(request) {
      const body = (await request.json()) as PostmarkInboundPayload
      return mapPayload(body)
    },
  }
}

function mapPayload(body: PostmarkInboundPayload): ParsedEmail {
  const from = body.FromFull
    ? toAddress(body.FromFull)
    : body.From
      ? parseSimple(body.From)
      : undefined
  return {
    messageId: body.MessageID,
    date: body.Date ? new Date(body.Date) : undefined,
    subject: body.Subject,
    from,
    to: (body.ToFull ?? [])
      .map(toAddress)
      .concat(body.To && !body.ToFull ? [parseSimple(body.To)] : []),
    cc: (body.CcFull ?? [])
      .map(toAddress)
      .concat(body.Cc && !body.CcFull ? [parseSimple(body.Cc)] : []),
    bcc: (body.BccFull ?? [])
      .map(toAddress)
      .concat(body.Bcc && !body.BccFull ? [parseSimple(body.Bcc)] : []),
    replyTo: body.ReplyTo ? parseSimple(body.ReplyTo) : undefined,
    references: [],
    text: body.TextBody,
    html: body.HtmlBody,
    headers: Object.fromEntries(
      (body.Headers ?? [])
        .filter((h): h is { Name: string; Value: string } => Boolean(h.Name && h.Value))
        .map((h) => [h.Name.toLowerCase(), h.Value]),
    ),
    attachments: (body.Attachments ?? []).map((a) => ({
      filename: a.Name ?? "attachment",
      contentType: a.ContentType,
      content: b64ToBytes(a.Content ?? ""),
      cid: a.ContentID?.replace(/[<>]/g, ""),
      disposition: "attachment" as const,
    })),
  }
}

function toAddress(a: { Email?: string; Name?: string }): EmailAddress {
  return { email: a.Email ?? "", name: a.Name || undefined }
}

function parseSimple(value: string): EmailAddress {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value)
  if (match) return { email: match[2]!.trim(), name: match[1]?.trim() || undefined }
  return { email: value.trim() }
}

function b64ToBytes(value: string): Uint8Array {
  const g = globalThis as {
    Buffer?: { from: (v: string, enc: string) => Uint8Array }
  }
  if (g.Buffer) return g.Buffer.from(value, "base64")
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function atobSafe(value: string): string {
  try {
    return atob(value)
  } catch {
    return ""
  }
}
