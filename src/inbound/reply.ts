/**
 * Extract the "new content" from a reply email — strip quoted previous
 * messages and trailing signatures.
 *
 * The world moved on from the Ruby `email_reply_parser` heuristics
 * around 2018 so we ship the same approach: look for canonical
 * header-bodied replies ("On ... wrote:") and signature dashes.
 * Covers English, Turkish, German, French, Spanish.
 *
 * @module
 */

export interface ReplyParseResult {
  /** Just the new content the author wrote. */
  text: string
  /** Everything after the new content (quoted previous message + sig). */
  quoted: string
}

const HEADER_PATTERNS: ReadonlyArray<RegExp> = [
  // English: "On Mon, Jan 1, 2026 at 3:00 PM Name <x@y> wrote:"
  /^[ \t]*On\b.*\bwrote:\s*$/im,
  // Turkish: "1 Ocak 2026 Pazartesi tarihinde Name <x@y> şunları yazdı:"
  /^[ \t]*.*tarihinde\b.*(yazd\u0131|\u015funlar\u0131 yazd\u0131):\s*$/im,
  // German: "Am 1. Januar 2026 um 15:00 schrieb Name <x@y>:"
  /^[ \t]*Am\b.*\bschrieb\b.*:\s*$/im,
  // French: "Le 1 janvier 2026 à 15:00, Name <x@y> a écrit :"
  /^[ \t]*Le\b.*\ba [eé]crit\b.*:\s*$/im,
  // Spanish: "El 1 de enero de 2026, Name <x@y> escribió:"
  /^[ \t]*El\b.*\bescribi[oó]\b.*:\s*$/im,
  // Outlook-style forwarded header block
  /^[ \t]*-----\s*Original Message\s*-----\s*$/im,
  /^[ \t]*From:\s/m,
]

/** Strip quoted history and signature; keep just the new content. */
export function stripReply(rawText: string): ReplyParseResult {
  const normalized = rawText.replace(/\r\n/g, "\n")

  // 1. Cut at the earliest header-bodied quote marker.
  let cutIndex = normalized.length
  for (const pattern of HEADER_PATTERNS) {
    const match = pattern.exec(normalized)
    if (match && match.index < cutIndex) cutIndex = match.index
  }

  // 2. Cut at the first line starting with one or more ">" chars after
  //    content, preceded by a blank line.
  const quoteMatch = /\n\s*\n(?:>[^\n]*\n?)+/g.exec(normalized)
  if (quoteMatch && quoteMatch.index < cutIndex) cutIndex = quoteMatch.index

  let text = normalized.slice(0, cutIndex).replace(/[\s\n]+$/g, "")
  const quoted = normalized.slice(cutIndex).replace(/^[\s\n]+/, "")

  // 3. Strip trailing signature block introduced by "-- \n" or common
  //    sign-offs on their own line.
  text = stripSignature(text)

  return { text, quoted }
}

const SIGN_OFF_PATTERNS: ReadonlyArray<RegExp> = [
  /\n--\s*\n[\s\S]*$/, // canonical RFC 3676
  /\n[ \t]*(Thanks|Regards|Cheers|Best|Sincerely|Yours|Sent from my [A-Za-z]+)[^\n]*\n[\s\S]*$/i,
  /\n[ \t]*(Te\u015fekk\u00fcrler|Sayg\u0131lar\u0131mla|Selamlar)[^\n]*\n[\s\S]*$/i,
]

function stripSignature(text: string): string {
  for (const pattern of SIGN_OFF_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return text.slice(0, match.index).replace(/[\s\n]+$/g, "")
  }
  return text
}
