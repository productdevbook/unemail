/**
 * HTML → plain text, for the `text/plain` alternative every HTML email
 * should carry. Not a DOM parser: it handles the constructs that matter in
 * a mail body and nothing else, which is what keeps it dependency-free and
 * usable inside a Worker.
 *
 * Set `text` yourself when the fidelity matters.
 *
 * @module
 */

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

export function htmlToText(html: string): string {
  let out = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
  out = out.replace(/<br\s*\/?>/gi, "\n")

  // Keep the destination of a link — a plain-text reader that cannot see
  // the anchor still needs somewhere to go.
  out = out.replace(
    /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim()
      return label && label !== href ? `${label} (${href})` : href
    },
  )

  out = out.replace(/<\/?([a-z0-9]+)[^>]*>/gi, (_, tag: string) =>
    BLOCK_TAGS.has(tag.toLowerCase()) ? "\n" : "",
  )

  return decodeEntities(out)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function decodeEntities(value: string): string {
  return (
    value
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&(?:#39|apos);/g, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      // Last, so an escaped `&amp;lt;` does not decode twice into `<`.
      .replace(/&amp;/g, "&")
  )
}
