/**
 * MTA-STS (RFC 8461) + TLS-RPT (RFC 8460) helpers. Two parts:
 *
 *  - `generateMtaStsPolicy(...)` produces the text file you serve at
 *    `https://mta-sts.<domain>/.well-known/mta-sts.txt`.
 *  - `parseTlsRpt(json)` normalizes TLS-RPT JSON reports into a typed
 *    record.
 *
 * DNS side (the TXT records at `_mta-sts.<domain>` and `_smtp._tls.<domain>`)
 * stays your responsibility — it's one line per domain.
 *
 * @module
 */

export interface MtaStsPolicyOptions {
  mode: "enforce" | "testing" | "none"
  /** Authorized MX patterns. */
  mx: ReadonlyArray<string>
  /** Policy lifetime in seconds. RFC 8461 recommends ≤ 604800 (7 days). */
  maxAgeSeconds: number
}

/** Produce the RFC 8461 policy body. */
export function generateMtaStsPolicy(options: MtaStsPolicyOptions): string {
  const lines = [`version: STSv1`, `mode: ${options.mode}`]
  for (const mx of options.mx) lines.push(`mx: ${mx}`)
  lines.push(`max_age: ${options.maxAgeSeconds}`)
  return lines.join("\r\n") + "\r\n"
}

export interface TlsRptReport {
  organizationName?: string
  dateRange?: { start: Date; end: Date }
  contactInfo?: string
  reportId?: string
  policies: ReadonlyArray<TlsRptPolicy>
}

export interface TlsRptPolicy {
  policyType?: "tlsa" | "sts" | "no-policy-found"
  policyDomain?: string
  totalSuccessful?: number
  totalFailure?: number
  failureDetails?: ReadonlyArray<{ resultType?: string; sendingMtaIp?: string; count?: number }>
}

/** Parse a TLS-RPT JSON report. Accepts a string or already-parsed
 *  object; normalizes camelCase fields. */
export function parseTlsRpt(input: string | Record<string, unknown>): TlsRptReport {
  const raw = typeof input === "string" ? (JSON.parse(input) as Record<string, unknown>) : input
  const policies: TlsRptPolicy[] = []
  const rawPolicies = raw.policies as Array<Record<string, unknown>> | undefined
  if (Array.isArray(rawPolicies)) {
    for (const p of rawPolicies) {
      const policy = (p.policy ?? {}) as Record<string, unknown>
      const summary = (p.summary ?? {}) as Record<string, unknown>
      policies.push({
        policyType: policy["policy-type"] as TlsRptPolicy["policyType"],
        policyDomain: policy["policy-domain"] as string | undefined,
        totalSuccessful: summary["total-successful-session-count"] as number | undefined,
        totalFailure: summary["total-failure-session-count"] as number | undefined,
        failureDetails: (p["failure-details"] as Array<Record<string, unknown>> | undefined)?.map(
          (d) => ({
            resultType: d["result-type"] as string | undefined,
            sendingMtaIp: d["sending-mta-ip"] as string | undefined,
            count: d["failed-session-count"] as number | undefined,
          }),
        ),
      })
    }
  }
  const dateRange = raw["date-range"] as Record<string, string> | undefined
  return {
    organizationName: raw["organization-name"] as string | undefined,
    dateRange:
      dateRange && dateRange["start-datetime"]
        ? {
            start: new Date(dateRange["start-datetime"]),
            end: new Date(dateRange["end-datetime"]!),
          }
        : undefined,
    contactInfo: raw["contact-info"] as string | undefined,
    reportId: raw["report-id"] as string | undefined,
    policies,
  }
}
