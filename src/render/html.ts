/** Lightweight HTML → plain-text fallback for the text alternative of an
 *  HTML email. Not a full DOM parser — handles the patterns email clients
 *  actually care about (line breaks, block tags, links, entities).
 *
 *  Intentionally zero-dep: text fallback is nice-to-have and keeps the
 *  render entries Workers-parseable. If you need perfect fidelity, set
 *  `text` explicitly on the message. */

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "blockquote",
  "pre",
  "hr",
])

/** Convert an HTML string into a reasonable plain-text equivalent. */
export function htmlToText(html: string): string {
  // Strip scripts + styles entirely (case-insensitive).
  let out = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")

  // <br> → newline.
  out = out.replace(/<br\s*\/?>/gi, "\n")

  // <a href="..."> inner </a> → "inner (href)" if link text ≠ href.
  out = out.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const stripped = stripTags(inner).trim()
    return stripped && stripped !== href ? `${stripped} (${href})` : href
  })

  // Block tags → wrap with newlines.
  out = out.replace(/<\/?([a-z0-9]+)[^>]*>/gi, (match, tag: string) => {
    const name = tag.toLowerCase()
    if (BLOCK_TAGS.has(name)) return "\n"
    return ""
  })

  out = decodeEntities(out)
  out = out.replace(/[ \t]+\n/g, "\n")
  out = out.replace(/\n{3,}/g, "\n\n")
  return out.trim()
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "")
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&(?:apos);/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
}
