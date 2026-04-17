import type { EmailAddress, EmailAddressInput } from "./types.ts"

/**
 * Normalize any accepted address input to an array of `EmailAddress` —
 * drivers should not re-implement this parsing.
 *
 * Accepts:
 *   - `"ada@acme.com"`
 *   - `"Ada Lovelace <ada@acme.com>"`
 *   - `{ email, name? }`
 *   - arrays of the above (mixed)
 */
export function normalizeAddresses(input: EmailAddressInput | undefined): EmailAddress[] {
  if (input == null) return []
  const list = Array.isArray(input) ? input : [input]
  const out: EmailAddress[] = []
  for (const item of list) {
    if (typeof item === "string") {
      out.push(parseAddress(item))
    } else if (item && typeof item === "object" && "email" in item) {
      out.push({ email: String(item.email), name: item.name })
    }
  }
  return out
}

/** Parse `"Name <email@x>"` or a bare `"email@x"` into an `EmailAddress`. */
export function parseAddress(value: string): EmailAddress {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value)
  if (match) {
    const name = match[1]?.replace(/^"|"$/g, "").trim() || undefined
    return { email: match[2]!.trim(), name }
  }
  return { email: value.trim() }
}

/** Format an `EmailAddress` back into its canonical header form. */
export function formatAddress(addr: EmailAddress): string {
  if (!addr.name) return addr.email
  const needsQuote = /["(),:;<>@[\\\]]/.test(addr.name)
  const name = needsQuote ? `"${addr.name.replace(/"/g, '\\"')}"` : addr.name
  return `${name} <${addr.email}>`
}

/** Basic RFC-5322-ish address syntax validator. Strict enough to catch
 *  typos but not so strict that it rejects RFC-valid edge cases. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
