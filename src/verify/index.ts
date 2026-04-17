import type { ParsedEmail } from "../parse/index.ts"

/** DKIM / SPF / DMARC verification helpers.
 *
 *  Two modes:
 *   1. **Trust the relay** (default): parse the \`Authentication-Results\`
 *      header supplied by the MTA that delivered the message. Cheap,
 *      works on Workers, relies on the upstream being honest (typically
 *      Gmail, Google Workspace, Exchange, SES — all trustworthy).
 *   2. **Active verification**: plug in a callback to run DNS lookups +
 *      cryptographic verification. We don't bundle this because active
 *      DKIM needs DNS access (Workers require \`dns-over-https\`) and a
 *      real crypto validator — not worth reinventing. When the callback
 *      is present it overrides the parsed header result. */

export type AuthResult =
  | "pass"
  | "fail"
  | "neutral"
  | "softfail"
  | "temperror"
  | "permerror"
  | "none"

export interface AuthenticationResults {
  dkim: AuthResult
  spf: AuthResult
  dmarc: AuthResult
  authenticatedDomain?: string
  raw?: string
}

export interface VerifyOptions {
  /** Optional callback for active verification. Receives the parsed
   *  email; should return fresh results (authoritative lookups, etc.). */
  verify?: (mail: ParsedEmail) => Promise<AuthenticationResults> | AuthenticationResults
}

const UNKNOWN: AuthenticationResults = { dkim: "none", spf: "none", dmarc: "none" }

/** Run all three checks. Returns the callback result if provided,
 *  otherwise the parsed \`Authentication-Results\` header. */
export async function verifyAll(
  mail: ParsedEmail,
  options: VerifyOptions = {},
): Promise<AuthenticationResults> {
  if (options.verify) return options.verify(mail)
  return parseAuthenticationResults(mail.headers["authentication-results"])
}

export function verifyDkim(mail: ParsedEmail): AuthResult {
  return parseAuthenticationResults(mail.headers["authentication-results"]).dkim
}

export function verifySpf(mail: ParsedEmail): AuthResult {
  return parseAuthenticationResults(mail.headers["authentication-results"]).spf
}

export function verifyDmarc(mail: ParsedEmail): AuthResult {
  return parseAuthenticationResults(mail.headers["authentication-results"]).dmarc
}

/** Parse one or more \`Authentication-Results\` headers per RFC 8601. */
export function parseAuthenticationResults(header: string | undefined): AuthenticationResults {
  if (!header) return UNKNOWN
  const result: AuthenticationResults = { dkim: "none", spf: "none", dmarc: "none", raw: header }
  // Header shape: `mta.example.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass`
  for (const entry of header.split(";")) {
    const trimmed = entry.trim()
    const match = /^(dkim|spf|dmarc)=([a-z]+)/i.exec(trimmed)
    if (!match) continue
    const method = match[1]!.toLowerCase() as "dkim" | "spf" | "dmarc"
    const outcome = match[2]!.toLowerCase() as AuthResult
    result[method] = outcome
    if (method === "dkim") {
      const domain = /header\.d=([^\s;]+)/i.exec(trimmed)
      if (domain) result.authenticatedDomain = domain[1]
    }
  }
  return result
}
