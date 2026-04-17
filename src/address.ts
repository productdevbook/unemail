/**
 * Strictly-validated RFC 5322 / RFC 6532 (SMTPUTF8) address primitive.
 * Use at system boundaries (user input, API payloads) to reject
 * malformed addresses before they reach a driver.
 *
 * @module
 */

import type { EmailAddress, EmailAddressInput, Result } from "./types.ts"
import { createError } from "./errors.ts"

/** Opaque tag — callers can rely on `Address.parse` returning a
 *  validated instance instead of re-validating. */
const VALIDATED: unique symbol = Symbol("unemail.Address")

export interface Address extends EmailAddress {
  readonly [VALIDATED]: true
  readonly local: string
  readonly domain: string
  toString: () => string
}

/** Validate + parse an input string or `EmailAddress`. Returns a
 *  `Result<Address>` so callers can pattern-match instead of
 *  try/catch. SMTPUTF8 allowed when `smtpUtf8` is true (default). */
export function parseAddress(
  input: string | EmailAddress,
  options: { smtpUtf8?: boolean } = {},
): Result<Address> {
  const smtpUtf8 = options.smtpUtf8 ?? true
  let email: string
  let name: string | undefined
  if (typeof input === "string") {
    const parsed = splitNameAddr(input)
    email = parsed.email
    name = parsed.name
  } else {
    email = input.email
    name = input.name
  }
  email = email.trim()
  if (!email) return err("empty address")
  const at = email.lastIndexOf("@")
  if (at <= 0 || at === email.length - 1) return err(`no local/domain: "${email}"`)
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (!isValidLocal(local, smtpUtf8)) return err(`invalid local-part: "${local}"`)
  if (!isValidDomain(domain)) return err(`invalid domain: "${domain}"`)
  const addr: Address = {
    email,
    name,
    local,
    domain,
    [VALIDATED]: true,
    toString: () => (name ? `"${escapeName(name)}" <${email}>` : email),
  }
  return { data: addr, error: null }
}

/** Convenience: throw on failure. Use only when you're certain the
 *  input is validated elsewhere. */
export function mustParseAddress(
  input: string | EmailAddress,
  options: { smtpUtf8?: boolean } = {},
): Address {
  const result = parseAddress(input, options)
  if (result.error) throw result.error
  return result.data
}

/** Parse any of the shapes accepted by `EmailAddressInput` into an
 *  array of validated `Address`es, short-circuiting on the first
 *  failure. */
export function parseAddresses(
  input: EmailAddressInput,
  options: { smtpUtf8?: boolean } = {},
): Result<Address[]> {
  const list = Array.isArray(input) ? input : [input]
  const out: Address[] = []
  for (const item of list) {
    const r = parseAddress(item as string | EmailAddress, options)
    if (r.error) return r as Result<Address[]>
    out.push(r.data)
  }
  return { data: out, error: null }
}

function splitNameAddr(value: string): { email: string; name?: string } {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^>]+)>\s*$/.exec(value)
  if (match) {
    const name = (match[1] ?? match[2] ?? "").trim()
    return { email: match[3]!.trim(), name: name || undefined }
  }
  return { email: value.trim() }
}

function isValidLocal(local: string, smtpUtf8: boolean): boolean {
  if (local.length === 0 || local.length > 64) return false
  // Allow quoted-string form
  if (local.startsWith('"') && local.endsWith('"')) return local.length >= 2
  const atom = smtpUtf8
    ? /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.\u0080-\u{10FFFF}]+$/u
    : /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/
  if (!atom.test(local)) return false
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false
  return true
}

function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false
  if (domain.startsWith("[") && domain.endsWith("]")) return domain.length > 2
  if (domain.includes("..") || domain.startsWith(".") || domain.endsWith(".")) return false
  for (const label of domain.split(".")) {
    if (label.length === 0 || label.length > 63) return false
    if (
      !/^[A-Za-z0-9\u0080-\u{10FFFF}]([A-Za-z0-9\-\u0080-\u{10FFFF}]*[A-Za-z0-9\u0080-\u{10FFFF}])?$/u.test(
        label,
      )
    )
      return false
  }
  return true
}

function escapeName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function err<T>(message: string): Result<T> {
  return { data: null, error: createError("unemail", "INVALID_OPTIONS", message) }
}
