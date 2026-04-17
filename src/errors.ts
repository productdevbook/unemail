import { type EmailErrorCode, EmailError } from "./types.ts"

/** Construct an `EmailError` with a consistent `[unemail] [driver] ...`
 *  prefix so users can grep logs for a single provider. */
export function createError(
  driver: string,
  code: EmailErrorCode,
  message: string,
  init?: { status?: number; retryable?: boolean; cause?: unknown },
): EmailError {
  return new EmailError({
    driver,
    code,
    message: `[unemail] [${driver}] ${message}`,
    status: init?.status,
    retryable: init?.retryable,
    cause: init?.cause,
  })
}

/** Error for missing required options — surfaced at driver initialization
 *  so misconfiguration fails fast. */
export function createRequiredError(driver: string, name: string | readonly string[]): EmailError {
  const names = Array.isArray(name) ? name.join(", ") : String(name)
  return createError(driver, "INVALID_OPTIONS", `Missing required option(s): ${names}`)
}

/** Normalize any thrown value into a typed `EmailError`. Preserves an
 *  existing `EmailError` unchanged so retry/status info survives. */
export function toEmailError(driver: string, error: unknown): EmailError {
  if (error instanceof EmailError) return error
  if (error instanceof Error)
    return createError(driver, "PROVIDER", error.message, { cause: error })
  return createError(driver, "PROVIDER", String(error), { cause: error })
}

export { EmailError }
