/**
 * Handlebars renderer — lazy-loads the `handlebars` peer dep so the
 * core bundle stays clean.
 *
 * ```ts
 * import { handlebarsRenderer } from "unemail/render/handlebars"
 * email.use(withRender(handlebarsRenderer()))
 *
 * await email.send({
 *   from, to, subject,
 *   handlebars: "Hello {{name}}",
 *   handlebarsVars: { name: "Ada" },
 * })
 * ```
 *
 * @module
 */

import type { Renderer } from "./_middleware.ts"

export interface HandlebarsRendererOptions {
  helpers?: Record<string, (...args: unknown[]) => unknown>
  partials?: Record<string, string>
}

export function handlebarsRenderer(options: HandlebarsRendererOptions = {}): Renderer {
  const cache = new Map<string, (ctx: unknown) => string>()
  return {
    name: "handlebars",
    match: (msg) => Boolean((msg as { handlebars?: string }).handlebars),
    async render(msg) {
      const source = (msg as { handlebars?: string }).handlebars!
      const Handlebars = await loadHandlebars()
      if (options.helpers) {
        for (const [n, fn] of Object.entries(options.helpers)) Handlebars.registerHelper(n, fn)
      }
      if (options.partials) {
        for (const [n, p] of Object.entries(options.partials)) Handlebars.registerPartial(n, p)
      }
      let fn = cache.get(source)
      if (!fn) {
        fn = Handlebars.compile(source)
        cache.set(source, fn)
      }
      const vars = (msg as { handlebarsVars?: Record<string, unknown> }).handlebarsVars ?? {}
      return fn(vars)
    },
  }
}

interface HandlebarsLike {
  compile: (source: string) => (ctx: unknown) => string
  registerHelper: (name: string, fn: (...args: unknown[]) => unknown) => void
  registerPartial: (name: string, source: string) => void
}

const dynamicImport: (specifier: string) => Promise<unknown> = new Function(
  "s",
  "return import(s)",
) as (s: string) => Promise<unknown>

async function loadHandlebars(): Promise<HandlebarsLike> {
  const mod = (await dynamicImport("handlebars").catch(() => null)) as
    | { default?: HandlebarsLike }
    | HandlebarsLike
    | null
  if (!mod) throw new Error("[unemail/render/handlebars] install `handlebars` as a peer dep")
  return (
    "default" in mod ? (mod.default as HandlebarsLike) : (mod as HandlebarsLike)
  ) as HandlebarsLike
}

declare module "../types.ts" {
  interface EmailMessage {
    handlebars?: string
    handlebarsVars?: Record<string, unknown>
  }
}
