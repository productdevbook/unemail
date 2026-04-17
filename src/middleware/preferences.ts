import type { EmailDriver, EmailMessage } from "../types.ts"
import type { PreferenceStore } from "../preferences/index.ts"
import { createError } from "../errors.ts"
import { normalizeAddresses } from "../_normalize.ts"

export interface PreferencesMiddlewareOptions {
  store: PreferenceStore
  /** How to pick the category for a message. By default reads the
   *  first `EmailTag` named `"category"`, then falls back to
   *  `msg.stream`. Messages without a category pass through. */
  categoryFor?: (msg: EmailMessage) => string | null
  /** When true, block the entire send if ANY recipient has opted out.
   *  Default: false — drop the opt-outs and continue. */
  strict?: boolean
}

/** Check the preference store before `driver.send`. Recipients who
 *  opted out of the resolved category are removed. */
export function withPreferences(
  driver: EmailDriver,
  options: PreferencesMiddlewareOptions,
): EmailDriver {
  const resolveCategory = options.categoryFor ?? defaultCategoryFor
  return {
    ...driver,
    async send(msg, ctx) {
      const category = resolveCategory(msg)
      if (!category) return driver.send(msg, ctx)
      const recipients = [
        ...normalizeAddresses(msg.to),
        ...normalizeAddresses(msg.cc),
        ...normalizeAddresses(msg.bcc),
      ]
      const allowed = new Set<string>()
      const blocked: string[] = []
      for (const r of recipients) {
        const ok = await options.store.allows(r.email, category)
        if (ok) allowed.add(r.email.toLowerCase())
        else blocked.push(r.email)
      }
      if (blocked.length === 0) return driver.send(msg, ctx)
      if (options.strict || allowed.size === 0) {
        return {
          data: null,
          error: createError(
            driver.name,
            "PROVIDER",
            `opted out of category "${category}": ${blocked.join(", ")}`,
            { retryable: false },
          ),
        }
      }
      return driver.send(keep(msg, allowed), ctx)
    },
  }
}

function defaultCategoryFor(msg: EmailMessage): string | null {
  const tag = msg.tags?.find((t) => t.name.toLowerCase() === "category")
  if (tag) return tag.value
  return msg.stream ?? null
}

function keep(msg: EmailMessage, allowed: Set<string>): EmailMessage {
  const filter = (input: EmailMessage["to"] | undefined) => {
    if (!input) return undefined
    const list = normalizeAddresses(input).filter((a) => allowed.has(a.email.toLowerCase()))
    return list.length ? list : undefined
  }
  return { ...msg, to: filter(msg.to) ?? msg.to, cc: filter(msg.cc), bcc: filter(msg.bcc) }
}
