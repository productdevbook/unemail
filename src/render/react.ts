import type { MessageContent } from "../core/types.ts"
import type { Renderer } from "./index.ts"
import { createError } from "../core/error.ts"

/** `content` shape this renderer claims. */
export interface ReactContent extends MessageContent {
  type: "react"
  /** A React element — typically a `react-email` component. */
  element: unknown
}

export interface ReactRendererOptions {
  /** Supply your own renderer instead of loading `@react-email/render`.
   *  Useful for a pinned version, or for `renderToStaticMarkup`. */
  render?: (element: unknown, options?: { plainText?: boolean }) => Promise<string> | string
  /** Also produce the text alternative with `react-email`'s own plain-text
   *  pass, which reads better than deriving it from the HTML.
   *  Default: true when `@react-email/render` supplies it. */
  plainText?: boolean
}

/**
 * Render `react-email` components.
 *
 * `@react-email/render` is an optional peer dependency — it is imported on
 * first use, so nothing is pulled into a bundle that does not call this.
 *
 * ```ts
 * import reactRenderer from "unemail/render/react"
 *
 * email.use(withRender(reactRenderer()))
 * await email.send({ to, subject, content: { type: "react", element: <Welcome /> } })
 * ```
 */
export default function reactRenderer(options: ReactRendererOptions = {}): Renderer {
  let load: Promise<NonNullable<ReactRendererOptions["render"]>> | null = null

  function resolveRender() {
    if (options.render) return Promise.resolve(options.render)
    load ??= import("@react-email/render").then(
      (mod) => mod.render,
      (cause) => {
        throw createError(
          "render/react",
          "INVALID_OPTIONS",
          "`@react-email/render` is not installed — add it, or pass `render` explicitly",
          { cause },
        )
      },
    )
    return load
  }

  return {
    name: "react",
    type: "react",
    async render(content) {
      const element = (content as ReactContent).element
      if (element == null) {
        throw createError("render/react", "INVALID_OPTIONS", "`content.element` is required")
      }
      const render = await resolveRender()
      const html = await render(element)
      if (options.plainText === false) return { html }
      try {
        return { html, text: await render(element, { plainText: true }) }
      } catch {
        // Older `@react-email/render` has no plainText mode; the render
        // middleware derives text from the HTML instead.
        return { html }
      }
    },
  }
}
