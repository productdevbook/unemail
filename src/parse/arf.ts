/**
 * RFC 5965 (Abuse Reporting Format) parser — turn an FBL complaint
 * into a structured record. Zero-dep.
 *
 * @module
 */

export interface ArfReport {
  feedbackType?: string
  userAgent?: string
  version?: string
  originalMailFrom?: string
  originalRcptTo?: string
  reportedDomain?: string
  arrivalDate?: Date
  sourceIp?: string
  reportedMessageId?: string
  reportedHeaders?: Record<string, string>
}

/** Parse a raw ARF message (multipart/report with
 *  `report-type=feedback-report`). We look for the `message/feedback-report`
 *  part and the embedded original headers. */
export function parseArf(raw: string): ArfReport {
  const report = extractPart(raw, "message/feedback-report")
  const fields = parseKv(report)
  const headers = extractOriginalHeaders(raw)
  return {
    feedbackType: fields["feedback-type"],
    userAgent: fields["user-agent"],
    version: fields.version,
    originalMailFrom: fields["original-mail-from"],
    originalRcptTo: fields["original-rcpt-to"],
    reportedDomain: fields["reported-domain"],
    arrivalDate: fields["arrival-date"] ? new Date(fields["arrival-date"]) : undefined,
    sourceIp: fields["source-ip"],
    reportedMessageId: headers["message-id"],
    reportedHeaders: headers,
  }
}

function extractPart(raw: string, contentType: string): string {
  const re = new RegExp(
    `content-type:\\s*${contentType}[^]*?\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n--|$)`,
    "i",
  )
  const m = re.exec(raw)
  return m ? m[1]!.trim() : ""
}

function parseKv(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]!.toLowerCase()] = m[2]!.trim()
  }
  return out
}

function extractOriginalHeaders(raw: string): Record<string, string> {
  const part = extractPart(raw, "message/rfc822-headers") || extractPart(raw, "message/rfc822")
  const out: Record<string, string> = {}
  for (const line of part.split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]!.toLowerCase()] = m[2]!.trim()
  }
  return out
}
