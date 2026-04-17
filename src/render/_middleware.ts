import type { EmailMessage, Middleware } from "../types.ts"
import { htmlToText } from "./html.ts"

/** Renderer contract. Each adapter (`react`, `jsx-email`, `mjml`) ships a
 *  `Renderer` that knows which message field it owns and how to turn it
 *  into HTML. Users register renderers via `withRender(...renderers)`. */
export interface Renderer {
  readonly name: string
  /** Return `true` if this renderer can handle the message (e.g. `msg.react`
   *  is non-nullish). */
  match: (msg: EmailMessage) => boolean
  /** Render the relevant field to HTML. May be async (React's renderAsync). */
  render: (msg: EmailMessage) => Promise<string> | string
}

export interface WithRenderOptions {
  /** Auto-derive `msg.text` from the rendered HTML when `text` is missing.
   *  Default: true. */
  autoText?: boolean
}

/** Middleware that resolves `msg.react`, `msg.jsx`, or `msg.mjml` into
 *  `msg.html` before the driver sees the message. Registered once per
 *  `createEmail` instance:
 *
 *  ```ts
 *  import reactRenderer from "unemail/render/react"
 *
 *  email.use(withRender(reactRenderer()))
 *  ```
 */
export function withRender(...renderers: Renderer[]): Middleware & { options: WithRenderOptions } {
  const options: WithRenderOptions = { autoText: true }
  return {
    name: "render",
    options,
    async beforeSend(msg) {
      for (const renderer of renderers) {
        if (!renderer.match(msg)) continue
        const html = await renderer.render(msg)
        // `msg` is treated as mutable here: the middleware contract allows
        // mutating the message before the driver reads it.
        ;(msg as { html?: string }).html = html
        if (!msg.text && options.autoText) {
          ;(msg as { text?: string }).text = htmlToText(html)
        }
        return
      }
    },
  }
}
