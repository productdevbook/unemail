import type { EmailMessage, Middleware } from "../types.ts"

export type ScrubStrategy = "hash" | "mask" | "drop"

export interface PiiScrubberOptions {
  /** Which fields to scrub from observable events (logger, telemetry,
   *  event stream). The actual outgoing email is never mutated. */
  redact?: ReadonlyArray<"recipient" | "subject" | "body" | "attachments">
  strategy?: ScrubStrategy
  /** Sink that receives the scrubbed message. Replace the default
   *  `logger.sink` or `telemetry.attributes` extractor with
   *  `(msg) => scrubbed(msg)` to opt in. */
  sink?: (scrubbed: Record<string, unknown>) => void
}

/** Return a sanitized shape of an EmailMessage. Not a middleware in
 *  the Middleware shape — intended to be used inside your logger /
 *  telemetry sink, so the actual send pipeline is untouched. */
export function scrubPii(
  msg: EmailMessage,
  options: PiiScrubberOptions = {},
): Record<string, unknown> {
  const redact = new Set(options.redact ?? ["recipient", "subject", "body"])
  const strategy = options.strategy ?? "mask"
  const out: Record<string, unknown> = {
    stream: msg.stream,
    from: anonAddress(getEmail(msg.from), strategy),
  }
  if (redact.has("recipient")) {
    out.to = anonAddressList(msg.to, strategy)
    if (msg.cc) out.cc = anonAddressList(msg.cc, strategy)
    if (msg.bcc) out.bcc = anonAddressList(msg.bcc, strategy)
  } else {
    out.to = msg.to
  }
  out.subject = redact.has("subject") ? apply(msg.subject, strategy) : msg.subject
  if (msg.text) out.text = redact.has("body") ? apply(msg.text, strategy) : msg.text
  if (msg.html) out.html = redact.has("body") ? apply(msg.html, strategy) : msg.html
  if (msg.attachments?.length) {
    out.attachments = msg.attachments.map((a) =>
      redact.has("attachments")
        ? { filename: apply(a.filename, strategy), contentType: a.contentType }
        : { filename: a.filename, contentType: a.contentType },
    )
  }
  return out
}

function getEmail(input: EmailMessage["from"]): string {
  if (typeof input === "string") return input
  if (input && typeof input === "object" && "email" in input) return input.email
  return "unknown"
}

function anonAddressList(input: unknown, strategy: ScrubStrategy): string[] {
  const list = Array.isArray(input) ? input : [input]
  return list.map((v) => {
    if (typeof v === "string") return anonAddress(extractEmail(v), strategy)
    if (v && typeof v === "object" && "email" in (v as Record<string, unknown>))
      return anonAddress((v as { email: string }).email, strategy)
    return "unknown"
  })
}

function extractEmail(value: string): string {
  const match = /<([^>]+)>/.exec(value)
  return match ? match[1]! : value
}

function anonAddress(address: string, strategy: ScrubStrategy): string {
  const at = address.lastIndexOf("@")
  if (at < 0) return apply(address, strategy)
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  return `${apply(local, strategy)}@${domain}`
}

function apply(value: string, strategy: ScrubStrategy): string {
  if (strategy === "drop") return "***"
  if (strategy === "mask") return value.length <= 2 ? "*" : value[0] + "***"
  return hash32(value).toString(36)
}

function hash32(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h >>> 0
}

/** Optional plugin middleware — logs a scrubbed view of each message
 *  via the provided sink. For wrapping your existing logger/telemetry
 *  prefer calling `scrubPii(msg, opts)` directly. */
export function withPiiLogging(
  options: Required<Pick<PiiScrubberOptions, "sink">> & PiiScrubberOptions,
): Middleware {
  return {
    name: "pii-log",
    beforeSend(msg) {
      options.sink(scrubPii(msg, options))
    },
  }
}
