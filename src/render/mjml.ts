import type { EmailMessage } from "../types.ts"
import type { Renderer } from "./_middleware.ts"

/** MJML adapter. Accepts a `mjml:` string on `email.send()`.
 *
 *  Uses the optional peer `mjml` (or `mjml-browser` in the browser).
 *  Compiled output goes into `msg.html`. */
export interface MjmlRenderOptions {
  /** Override the compiler for tests. */
  compile?: (source: string) => Promise<string> | string
  /** Validation level forwarded to mjml. Default: "soft". */
  validationLevel?: "strict" | "soft" | "skip"
}

export function mjmlRenderer(options: MjmlRenderOptions = {}): Renderer {
  let cached: ((source: string) => Promise<string>) | null = null
  const resolveCompile = async () => {
    if (cached) return cached
    if (options.compile) {
      const user = options.compile
      cached = async (s) => user(s)
      return cached
    }
    try {
      const mod: unknown = await import("mjml" as string)
      const fn = (typeof mod === "function" ? mod : (mod as { default?: unknown }).default) as
        | ((src: string, opts?: unknown) => { html: string; errors?: unknown[] })
        | undefined
      if (typeof fn !== "function") throw new Error("mjml is not a function")
      cached = async (src) => {
        const result = fn(src, { validationLevel: options.validationLevel ?? "soft" })
        return result.html
      }
      return cached
    } catch (err) {
      throw new Error(
        "[unemail/render/mjml] requires `mjml` as a peer dependency. " +
          `Install it or pass \`compile\` via options. Original error: ${(err as Error).message}`,
      )
    }
  }

  return {
    name: "mjml",
    match: (msg: EmailMessage) => typeof msg.mjml === "string" && msg.mjml.length > 0,
    async render(msg) {
      const compile = await resolveCompile()
      return compile(msg.mjml as string)
    },
  }
}

export default mjmlRenderer
