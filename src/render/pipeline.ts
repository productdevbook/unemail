/**
 * Composable HTML transforms applied after rendering. Use via
 * middleware so the pipeline runs just before `driver.send`:
 *
 * ```ts
 * email.use(htmlPipeline(withPreheader(), inlineCss(), cidRewrite()))
 * ```
 *
 * Each transform is a pure function over the rendered HTML string.
 *
 * @module
 */

import type { EmailMessage, Middleware } from "../types.ts"

export type HtmlTransform = (html: string, msg: EmailMessage) => string | Promise<string>

/** Pipe `EmailMessage.html` through each transform in order. */
export function htmlPipeline(...transforms: HtmlTransform[]): Middleware {
  return {
    name: "html-pipeline",
    async beforeSend(msg) {
      if (!msg.html) return
      let html = msg.html
      for (const t of transforms) html = await t(html, msg)
      ;(msg as { html?: string }).html = html
    },
  }
}

/** Inject a hidden preheader snippet (Litmus-approved) before the
 *  visible content. Uses `msg.preheader` when present, or falls back
 *  to the supplied function. */
export interface PreheaderOptions {
  /** Explicit text to use. Overrides `msg.preheader`. */
  text?: string | ((msg: EmailMessage) => string | undefined)
}

export function withPreheader(options: PreheaderOptions = {}): HtmlTransform {
  return (html, msg) => {
    const record = msg as { preheader?: string }
    const resolved =
      typeof options.text === "function" ? options.text(msg) : (options.text ?? record.preheader)
    if (!resolved) return html
    const hidden =
      `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">` +
      escapeHtml(resolved) +
      "\u00A0\u200C".repeat(60) +
      `</div>`
    // Insert immediately after the opening <body> (or at top).
    return /<body[^>]*>/i.test(html)
      ? html.replace(/<body([^>]*)>/i, (match) => `${match}${hidden}`)
      : `${hidden}${html}`
  }
}

/** Dark-mode CSS hook — injects Outlook.com / Apple Mail dark-mode
 *  meta tags + a `[data-ogsc]` scope. Consumers supply the rules. */
export interface DarkModeOptions {
  /** CSS block applied via `[data-ogsc]` (Outlook.com) and
   *  `@media (prefers-color-scheme: dark)`. */
  darkCss?: string
}

export function darkModeHook(options: DarkModeOptions = {}): HtmlTransform {
  const head =
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="supported-color-schemes" content="light dark">` +
    (options.darkCss
      ? `<style>@media (prefers-color-scheme: dark) {${options.darkCss}}[data-ogsc] body {${options.darkCss}}</style>`
      : "")
  return (html) => {
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => `${m}${head}`)
    return `<head>${head}</head>${html}`
  }
}

/** CID auto-rewrite — scan for `<img src="…">` tags whose src matches
 *  a CID on one of the message attachments and rewrite to `cid:<id>`. */
export function cidRewrite(): HtmlTransform {
  return (html, msg) => {
    if (!msg.attachments?.length) return html
    const byUrl = new Map<string, string>()
    for (const a of msg.attachments) {
      if (a.cid && a.filename) {
        byUrl.set(a.filename, a.cid)
      }
    }
    return html.replace(/<img([^>]*?)src=(["'])([^"']+)\2/gi, (full, attrs, quote, src) => {
      const basename = src.split("/").pop() ?? src
      const cid = byUrl.get(basename) ?? byUrl.get(src)
      if (!cid) return full
      return `<img${attrs}src=${quote}cid:${cid}${quote}`
    })
  }
}

/** CSS inliner — lazy-loads `juice` if you have it installed. Passes
 *  through HTML unchanged when juice isn't available. */
export function inlineCss(): HtmlTransform {
  return async (html) => {
    const juice = await import("juice").catch(() => null)
    if (!juice) return html
    const fn = (juice as unknown as { default?: (html: string) => string }).default ?? juice
    return (fn as (html: string) => string)(html)
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
