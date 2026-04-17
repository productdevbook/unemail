import type { DriverFactory, EmailMessage, EmailResult, Result } from "../types.ts"
import { defineDriver } from "../_define.ts"
import { normalizeAddresses } from "../_normalize.ts"
import { createError, createRequiredError } from "../errors.ts"
import { httpJson } from "./_http.ts"

/** The Loops transactional API takes \`transactionalId\` + \`email\` + \`dataVariables\`.
 *  Map from our \`EmailMessage\`: \`headers["x-loops-transactional-id"]\` or
 *  the driver's default \`transactionalId\` option carries the id;
 *  \`dataVariables\` come from \`msg.tags\` (repurposed as vars since Loops
 *  doesn't have free-form tag support). */
export interface LoopsDriverOptions {
  apiKey: string
  /** Default Loops transactionalId if the message doesn't specify one. */
  transactionalId?: string
  endpoint?: string
  fetch?: typeof fetch
}

const DRIVER = "loops"

const loops: DriverFactory<LoopsDriverOptions> = defineDriver<LoopsDriverOptions>((options) => {
  if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")
  const endpoint = options.endpoint ?? "https://app.loops.so"
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function")
    throw createError(DRIVER, "INVALID_OPTIONS", "fetch is unavailable; pass `fetch` explicitly")

  return {
    name: DRIVER,
    options,
    flags: {
      templates: true,
      tracking: true,
      tagging: true,
    },

    async isAvailable() {
      return Boolean(options.apiKey)
    },

    async send(msg) {
      const transactionalId =
        msg.template?.id ?? msg.headers?.["x-loops-transactional-id"] ?? options.transactionalId
      if (!transactionalId) {
        return {
          data: null,
          error: createError(
            DRIVER,
            "INVALID_OPTIONS",
            "transactionalId is required: pass via msg.template.id, headers['x-loops-transactional-id'] or driver options",
          ),
        }
      }
      const to = normalizeAddresses(msg.to)[0]
      if (!to) {
        return {
          data: null,
          error: createError(DRIVER, "INVALID_OPTIONS", "`to` is required"),
        }
      }
      const dataVariables: Record<string, unknown> = {
        ...(msg.template?.variables ?? {}),
      }
      for (const t of msg.tags ?? []) dataVariables[t.name] = t.value

      const res = await httpJson({
        fetch: fetchImpl,
        driver: DRIVER,
        url: `${endpoint}/api/v1/transactional`,
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: {
          transactionalId,
          email: to.email,
          dataVariables,
        },
      })
      if (res.error) return res as Result<EmailResult>
      const body = (res.data ?? {}) as { success?: boolean }
      return {
        data: {
          id: `loops_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          driver: DRIVER,
          at: new Date(),
          provider: body as Record<string, unknown>,
        },
        error: null,
      }
    },
  }
})

export default loops
