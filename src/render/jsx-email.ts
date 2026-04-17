import type { EmailMessage } from "../types.ts"
import type { Renderer } from "./_middleware.ts"

/** jsx-email adapter. Accepts a `jsx:` prop on `email.send()`.
 *
 *  Uses the optional peer `jsx-email`. Loaded lazily so zero-dep users
 *  don't pay for it. */
export interface JsxEmailRenderOptions {
  /** Override the renderer for tests. */
  render?: (element: unknown) => Promise<string> | string
  /** Inline CSS in the output. Default: true. */
  inlineCss?: boolean
}

export function jsxEmailRenderer(options: JsxEmailRenderOptions = {}): Renderer {
  let cached: ((element: unknown) => Promise<string>) | null = null
  const resolveRender = async () => {
    if (cached) return cached
    if (options.render) {
      const user = options.render
      cached = async (el) => user(el)
      return cached
    }
    try {
      const mod = await import("jsx-email" as string)
      const render = mod.render as (el: unknown, opts?: unknown) => Promise<string>
      if (!render) throw new Error("jsx-email has no `render` export")
      cached = async (el) => render(el, { inlineCss: options.inlineCss ?? true })
      return cached
    } catch (err) {
      throw new Error(
        "[unemail/render/jsx-email] requires `jsx-email` as a peer dependency. " +
          `Install it or pass \`render\` via options. Original error: ${(err as Error).message}`,
      )
    }
  }

  return {
    name: "jsx-email",
    match: (msg: EmailMessage) => msg.jsx != null,
    async render(msg) {
      const r = await resolveRender()
      return r(msg.jsx)
    },
  }
}

export default jsxEmailRenderer
