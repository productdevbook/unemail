/**
 * LiquidJS renderer — lazy-loads the `liquidjs` peer.
 *
 * ```ts
 * import { liquidRenderer } from "unemail/render/liquid"
 * email.use(withRender(liquidRenderer()))
 *
 * await email.send({
 *   ..., liquid: "Hello {{ name }}", liquidVars: { name: "Ada" },
 * })
 * ```
 *
 * @module
 */

import type { EmailMessage } from "../types.ts"
import type { Renderer } from "./_middleware.ts"

export interface LiquidRendererOptions {
  /** LiquidJS engine options passed through to `new Liquid(options)`. */
  engineOptions?: Record<string, unknown>
}

interface LiquidLike {
  parseAndRender: (tpl: string, ctx?: Record<string, unknown>) => Promise<string>
}

interface LiquidCtor {
  new (options?: Record<string, unknown>): LiquidLike
}

const dynamicImport: (specifier: string) => Promise<unknown> = new Function(
  "s",
  "return import(s)",
) as (s: string) => Promise<unknown>

export function liquidRenderer(options: LiquidRendererOptions = {}): Renderer {
  let engine: LiquidLike | null = null
  return {
    name: "liquid",
    match: (msg) => Boolean((msg as { liquid?: string }).liquid),
    async render(msg) {
      if (!engine) {
        const mod = (await dynamicImport("liquidjs").catch(() => null)) as {
          Liquid?: LiquidCtor
        } | null
        if (!mod?.Liquid)
          throw new Error("[unemail/render/liquid] install `liquidjs` as a peer dep")
        engine = new mod.Liquid(options.engineOptions)
      }
      const source = (msg as { liquid?: string }).liquid!
      const vars = (msg as { liquidVars?: Record<string, unknown> }).liquidVars ?? {}
      return engine.parseAndRender(source, vars)
    },
  }
}

declare module "../types.ts" {
  interface EmailMessage {
    liquid?: string
    liquidVars?: Record<string, unknown>
  }
}
