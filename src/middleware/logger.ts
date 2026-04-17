import type { EmailMessage, Middleware, Result } from "../types.ts"
import type { EmailError } from "../errors.ts"
import type { EmailResult, SendContext } from "../types.ts"
import { normalizeAddresses } from "../_normalize.ts"

/** Structured log entry emitted by `withLogger`. Consumers can pipe this
 *  into Pino, Winston, Logflare, Axiom, or \`console\`. */
export interface LogEntry {
  event: "send.start" | "send.success" | "send.error"
  at: string
  driver: string
  stream?: string
  attempt: number
  messageId?: string
  durationMs?: number
  recipient?: string
  subject?: string
  error?: {
    code: string
    message: string
    status?: number
    retryable: boolean
  }
  /** User-extensible metadata forwarded from \`ctx.meta\`. */
  meta?: Record<string, unknown>
}

export interface LoggerOptions {
  /** Sink for log entries. Default: \`console.info\` for start/success,
   *  \`console.error\` for errors. */
  sink?: (entry: LogEntry) => void
  /** Include the first 120 chars of the subject in logs. Default: true. */
  includeSubject?: boolean
  /** Include the first recipient's email address. Default: true. */
  includeRecipient?: boolean
  /** Redact the local-part of emails (ada@acme.com → a***@acme.com).
   *  Default: false. */
  redactLocalPart?: boolean
}

/** Middleware that emits structured log entries around every send. Zero
 *  runtime dependencies — use \`sink\` to plug in any logger. */
export function withLogger(options: LoggerOptions = {}): Middleware {
  const sink = options.sink ?? defaultSink
  const includeSubject = options.includeSubject ?? true
  const includeRecipient = options.includeRecipient ?? true
  const redact = options.redactLocalPart ?? false

  return {
    name: "logger",
    beforeSend(msg, ctx) {
      ctx.meta.__loggerStart = Date.now()
      sink(baseEntry("send.start", msg, ctx, { includeSubject, includeRecipient, redact }))
    },
    afterSend(msg, ctx, result) {
      const entry = baseEntry("send.success", msg, ctx, {
        includeSubject,
        includeRecipient,
        redact,
      })
      const start = ctx.meta.__loggerStart
      if (typeof start === "number") entry.durationMs = Date.now() - start
      attachResult(entry, result)
      sink(entry)
    },
    onError(msg, ctx, error) {
      const entry = baseEntry("send.error", msg, ctx, { includeSubject, includeRecipient, redact })
      const start = ctx.meta.__loggerStart
      if (typeof start === "number") entry.durationMs = Date.now() - start
      entry.error = serializeError(error)
      sink(entry)
    },
  }
}

interface LogFieldOptions {
  includeSubject: boolean
  includeRecipient: boolean
  redact: boolean
}

function baseEntry(
  event: LogEntry["event"],
  msg: EmailMessage,
  ctx: SendContext,
  fields: LogFieldOptions,
): LogEntry {
  const entry: LogEntry = {
    event,
    at: new Date().toISOString(),
    driver: ctx.driver,
    attempt: ctx.attempt,
  }
  if (ctx.stream) entry.stream = ctx.stream
  if (fields.includeSubject && msg.subject) entry.subject = truncate(msg.subject, 120)
  if (fields.includeRecipient) {
    const first = normalizeAddresses(msg.to)[0]?.email
    if (first) entry.recipient = fields.redact ? redactEmail(first) : first
  }
  const userMeta = dropPrefixed(ctx.meta, "__logger")
  if (userMeta) entry.meta = userMeta
  return entry
}

function attachResult(entry: LogEntry, result: Result<EmailResult>): void {
  if (result.data) entry.messageId = result.data.id
  if (result.error) entry.error = serializeError(result.error)
}

function serializeError(err: EmailError): LogEntry["error"] {
  return {
    code: err.code,
    message: err.message,
    status: err.status,
    retryable: err.retryable,
  }
}

function defaultSink(entry: LogEntry): void {
  const fn = entry.event === "send.error" ? console.error : console.info
  fn(JSON.stringify(entry))
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function redactEmail(email: string): string {
  const at = email.indexOf("@")
  if (at < 2) return email
  return `${email[0]}***${email.slice(at)}`
}

function dropPrefixed(
  meta: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  let has = false
  for (const [k, v] of Object.entries(meta)) {
    if (k.startsWith(prefix)) continue
    out[k] = v
    has = true
  }
  return has ? out : undefined
}
