import type { EmailErrorCode } from "../../types.ts"
import { createError, EmailError } from "../../errors.ts"

const DRIVER = "smtp"

/** Map an SMTP reply code to our cross-driver error taxonomy. */
export function mapReplyCode(code: number): { code: EmailErrorCode; retryable: boolean } {
  if (code === 0 || Number.isNaN(code)) return { code: "NETWORK", retryable: true }
  if (code === 421 || code === 450 || code === 451 || code === 452 || code === 454)
    return { code: "NETWORK", retryable: true }
  if (code >= 400 && code < 500) return { code: "NETWORK", retryable: true }
  if (code === 500 || code === 501 || code === 502)
    return { code: "INVALID_OPTIONS", retryable: false }
  if (code === 503) return { code: "PROVIDER", retryable: false }
  if (code === 530 || code === 535) return { code: "AUTH", retryable: false }
  if (code === 550 || code === 551 || code === 553) return { code: "PROVIDER", retryable: false }
  if (code >= 500) return { code: "PROVIDER", retryable: false }
  return { code: "PROVIDER", retryable: false }
}

/** Surface an SMTP reply as an `EmailError`. */
export function replyError(replyCode: number, raw: string, stage?: string): EmailError {
  const { code, retryable } = mapReplyCode(replyCode)
  const prefix = stage ? `${stage}: ` : ""
  return createError(DRIVER, code, `${prefix}${replyCode} ${raw}`, {
    status: replyCode,
    retryable,
    cause: { replyCode, raw, stage },
  })
}

/** Surface a socket/network error. */
export function wrapNetworkError(err: unknown, stage?: string): EmailError {
  const prefix = stage ? `${stage}: ` : ""
  const msg = err instanceof Error ? err.message : String(err)
  return createError(DRIVER, "NETWORK", `${prefix}${msg}`, { retryable: true, cause: err })
}

/** Surface a timeout. */
export function timeoutError(stage: string, ms: number): EmailError {
  return createError(DRIVER, "TIMEOUT", `${stage} timed out after ${ms}ms`, { retryable: true })
}

/** Surface cancellation (dispose / abort signal). */
export function cancelledError(reason = "cancelled"): EmailError {
  return createError(DRIVER, "CANCELLED", reason, { retryable: false })
}
