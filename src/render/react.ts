import type { EmailMessage } from "../types.ts"
import type { Renderer, WithRenderOptions } from "./_middleware.ts"
import { withRender } from "./_middleware.ts"

/** React Email adapter. Accepts a `react:` prop on `email.send()`.
 *
 *  Requires the optional peer `@react-email/render` (or the bundled
 *  renderer from `react-email`). We resolve it lazily so users who don't
 *  use React pay nothing — the module is Workers-parseable even without
 *  the peer installed. */
export interface ReactRenderOptions {
  /** Bring-your-own renderer — useful for testing or custom setups. */
  render?: (element: unknown) => Promise<string> | string
  /** Pretty-print the rendered HTML. Forwarded to `@react-email/render`. */
  pretty?: boolean
}

export function reactRenderer(options: ReactRenderOptions = {}): Renderer {
  let cached: ((element: unknown) => Promise<string>) | null = null
  const resolveRender = async (): Promise<(element: unknown) => Promise<string>> => {
    if (cached) return cached
    if (options.render) {
      const userRender = options.render
      cached = async (el) => userRender(el)
      return cached
    }
    try {
      const mod = await import("@react-email/render" as string)
      const render = (mod.render ?? mod.default?.render) as
        | undefined
        | ((el: unknown, opts?: { pretty?: boolean }) => Promise<string> | string)
      if (!render) throw new Error("@react-email/render has no `render` export")
      cached = async (el) => render(el, { pretty: options.pretty ?? false })
      return cached
    } catch (err) {
      throw new Error(
        "[unemail/render/react] requires `@react-email/render` as a peer dependency. " +
          `Install it or pass \`render\` via options. Original error: ${(err as Error).message}`,
      )
    }
  }

  return {
    name: "react",
    match: (msg: EmailMessage) => msg.react != null,
    async render(msg) {
      const r = await resolveRender()
      return r(msg.react)
    },
  }
}

/** Convenience factory identical in spirit to the other drivers:
 *
 *  ```ts
 *  import { withRender } from "unemail"
 *  import reactRender from "unemail/render/react"
 *
 *  email.use(withRender(reactRender()))
 *  ```
 *
 *  Default export mirrors the driver convention for consistency.
 */
export default reactRenderer

export type { Renderer, WithRenderOptions }
export { withRender }
