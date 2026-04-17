import type { EmailDriver, EmailMessage } from "../types.ts"
import type { SuppressionStore } from "../suppression/index.ts"
import { createError } from "../errors.ts"
import { normalizeAddresses } from "../_normalize.ts"

/** Behavior when a recipient is suppressed.
 *  - `"error"` — return an `EmailError` with code `PROVIDER` and
 *    suppression metadata.
 *  - `"drop"` — strip the suppressed recipients and continue. If
 *    every recipient is suppressed, behaves like `"error"`. */
export type SuppressionPolicy = "error" | "drop"

export interface SuppressionOptions {
  store: SuppressionStore
  policy?: SuppressionPolicy
  /** Hook fired for each suppressed recipient. */
  onBlocked?: (recipient: string, reason: string) => void
}

/** Wrap a driver so `send()` checks the suppression store before the
 *  request leaves the process. */
export function withSuppression(driver: EmailDriver, options: SuppressionOptions): EmailDriver {
  const policy = options.policy ?? "error"
  return {
    ...driver,
    async send(msg, ctx) {
      const all = [
        ...normalizeAddresses(msg.to),
        ...normalizeAddresses(msg.cc),
        ...normalizeAddresses(msg.bcc),
      ]
      const blocked: Array<{ recipient: string; reason: string }> = []
      const allowed = new Set<string>()
      for (const addr of all) {
        const rec = await options.store.has(addr.email)
        if (rec) {
          blocked.push({ recipient: addr.email, reason: String(rec.reason) })
          options.onBlocked?.(addr.email, String(rec.reason))
        } else {
          allowed.add(addr.email.toLowerCase())
        }
      }
      if (blocked.length === 0) return driver.send(msg, ctx)

      if (policy === "error" || allowed.size === 0) {
        return {
          data: null,
          error: createError(
            driver.name,
            "PROVIDER",
            `recipient suppressed: ${blocked.map((b) => b.recipient).join(", ")}`,
            { retryable: false },
          ),
        }
      }

      return driver.send(filterRecipients(msg, allowed), ctx)
    },
  }
}

function filterRecipients(msg: EmailMessage, allowed: Set<string>): EmailMessage {
  const keep = (input: EmailMessage["to"] | undefined) => {
    if (!input) return undefined
    const list = normalizeAddresses(input).filter((a) => allowed.has(a.email.toLowerCase()))
    return list.length ? list : undefined
  }
  return { ...msg, to: keep(msg.to) ?? msg.to, cc: keep(msg.cc), bcc: keep(msg.bcc) }
}
