/**
 * Locale-aware renderer wrapper. Picks one of the registered
 * sub-renderers based on `msg.locale` and falls through to the
 * default. Combine with Handlebars / Liquid / React for a simple
 * i18n-first pipeline.
 *
 * ```ts
 * email.use(withRender(i18nRenderer({
 *   fallback: handlebarsRenderer(),
 *   byLocale: { tr: handlebarsRenderer({ ... }), en: handlebarsRenderer({ ... }) },
 * })))
 * ```
 *
 * @module
 */

import type { EmailMessage } from "../types.ts"
import type { Renderer } from "./_middleware.ts"

export interface I18nRendererOptions {
  byLocale: Record<string, Renderer>
  fallback: Renderer
  /** Override how the locale is resolved. Defaults to
   *  `msg.locale || msg.template?.locale || msg.headers?.["accept-language"]`. */
  resolveLocale?: (msg: EmailMessage) => string | undefined
}

export function i18nRenderer(options: I18nRendererOptions): Renderer {
  const resolve =
    options.resolveLocale ??
    ((msg: EmailMessage) => {
      const anyMsg = msg as {
        locale?: string
        template?: { locale?: string }
        headers?: Record<string, string>
      }
      return (
        anyMsg.locale ??
        anyMsg.template?.locale ??
        anyMsg.headers?.["accept-language"]?.split(",")[0]
      )
    })
  return {
    name: "i18n",
    match: (msg) => pick(msg, options, resolve).match(msg),
    render: (msg) => pick(msg, options, resolve).render(msg),
  }
}

function pick(
  msg: EmailMessage,
  options: I18nRendererOptions,
  resolve: (msg: EmailMessage) => string | undefined,
): Renderer {
  const loc = resolve(msg)
  if (loc && options.byLocale[loc]) return options.byLocale[loc]
  if (loc) {
    const lang = loc.split("-")[0]
    if (lang && options.byLocale[lang]) return options.byLocale[lang]
  }
  return options.fallback
}
