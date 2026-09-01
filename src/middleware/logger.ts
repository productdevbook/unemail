import type { Middleware, NormalizedMessage } from "../core/types.ts"
import { defineMiddleware } from "../core/define.ts"

/** One structured record per pipeline trip. */
export interface LogEntry {
  readonly level: "info" | "error"
  readonly driver: string
  readonly stream?: string
  readonly attempt: number
  readonly count: number
  readonly sent: number
  readonly failed: number
  readonly durationMs: number
  /** Present when at least one message failed. */
  readonly errors?: readonly { readonly code: string; readonly message: string }[]
  /** Omitted unless `redact` is set to `"none"`. */
  readonly messages?: readonly { readonly to: string; readonly subject: string }[]
}

export interface LoggerOptions {
  /** Where entries go. Default: `console.log` / `console.error`. */
  log?: (entry: LogEntry) => void
  /** `addresses` (default) logs counts only. `none` includes recipients
   *  and subjects — do not enable it where logs leave your control. */
  redact?: "addresses" | "none"
}

/**
 * Structured logging around the whole pipeline.
 *
 * Register it first so it measures everything inside it, retries included:
 *
 * ```ts
 * email.use(withLogger()).use(withRetry())
 * ```
 */
export function withLogger(options: LoggerOptions = {}): Middleware {
  const redact = options.redact ?? "addresses"
  const log = options.log ?? defaultLog

  return defineMiddleware("logger", (next) => async (msgs, ctx) => {
    const startedAt = Date.now()
    const results = await next(msgs, ctx)
    const errors = results.flatMap((result) =>
      result.error ? [{ code: result.error.code, message: result.error.message }] : [],
    )

    log({
      level: errors.length > 0 ? "error" : "info",
      driver: ctx.driver,
      ...(ctx.stream ? { stream: ctx.stream } : {}),
      attempt: ctx.attempt,
      count: msgs.length,
      sent: results.length - errors.length,
      failed: errors.length,
      durationMs: Date.now() - startedAt,
      ...(errors.length > 0 ? { errors } : {}),
      ...(redact === "none" ? { messages: msgs.map(describe) } : {}),
    })

    return results
  })
}

function describe(msg: NormalizedMessage) {
  return { to: msg.to.map((address) => address.email).join(", "), subject: msg.subject }
}

function defaultLog(entry: LogEntry) {
  if (entry.level === "error") console.error("[unemail]", entry)
  else console.log("[unemail]", entry)
}
