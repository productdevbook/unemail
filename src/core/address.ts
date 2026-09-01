import type { AddressInput, EmailAddress } from "./types.ts"

/** Parse `"Ada Lovelace <ada@acme.com>"` or a bare `"ada@acme.com"`. */
export function parseAddress(value: string): EmailAddress {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value)
  if (!match) return { email: value.trim() }
  const name = match[1]?.replace(/^"|"$/g, "").trim()
  return name ? { email: match[2]!.trim(), name } : { email: match[2]!.trim() }
}

/** Render an address back into its canonical header form, quoting the
 *  display name when it contains a character RFC 5322 treats as a
 *  delimiter. */
export function formatAddress(address: EmailAddress): string {
  if (!address.name) return address.email
  const needsQuote = /["(),:;<>@[\\\]]/.test(address.name)
  const name = needsQuote ? `"${address.name.replace(/"/g, '\\"')}"` : address.name
  return `${name} <${address.email}>`
}

/** Join a list into one header value. */
export function formatAddressList(addresses: readonly EmailAddress[]): string {
  return addresses.map(formatAddress).join(", ")
}

/** Flatten any accepted address input into a list. Unrecognized entries
 *  are dropped rather than throwing — validation happens once, in
 *  `normalizeMessage()`, where it can name the offending field. */
export function toAddressList(input: AddressInput | undefined): EmailAddress[] {
  if (input == null) return []
  const items = Array.isArray(input) ? input : [input as string | EmailAddress]
  const out: EmailAddress[] = []
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim()) out.push(parseAddress(item))
    } else if (item && typeof item === "object" && typeof item.email === "string") {
      out.push(
        item.name ? { email: item.email.trim(), name: item.name } : { email: item.email.trim() },
      )
    }
  }
  return out
}

/** Deduplicate by address, keeping the first occurrence's display name. */
export function dedupeAddresses(addresses: readonly EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>()
  const out: EmailAddress[] = []
  for (const address of addresses) {
    const key = address.email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(address)
  }
  return out
}

/** Loose syntax check — strict enough to catch a typo, lenient enough not
 *  to reject addresses that are legal but unusual. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value)
}
