import type { EmailErrorCode } from "./types.ts"

/** Every failure the library reports. Drivers never throw raw errors past
 *  their own boundary — `toEmailError()` wraps whatever they catch, so
 *  `error.code` and `error.retryable` are always meaningful. */
export class EmailError extends Error {
  override readonly name = "EmailError"
  readonly driver: string
  readonly code: EmailErrorCode
  readonly status?: number
  readonly retryable: boolean
  override readonly cause?: unknown
  /** Whatever middleware left on `SendContext.meta` for this send. Set by
   *  the core after the pipeline returns, so it is absent on an error a
   *  driver constructs and inspects itself. */
  meta?: Readonly<Record<string, unknown>>

  constructor(init: {
    driver: string
    code: EmailErrorCode
    message: string
    status?: number
    retryable?: boolean
    cause?: unknown
  }) {
    super(init.message)
    this.driver = init.driver
    this.code = init.code
    this.status = init.status
    this.retryable = init.retryable ?? RETRYABLE_BY_DEFAULT.has(init.code)
    this.cause = init.cause
  }
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<EmailErrorCode> = new Set<EmailErrorCode>([
  "NETWORK",
  "RATE_LIMIT",
  "TIMEOUT",
])

/** Build an `EmailError` with the `[unemail] [driver]` prefix, so one
 *  provider's failures are greppable in a mixed log. */
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

/** Missing driver options. Raised from the factory so misconfiguration
 *  fails at construction rather than on the first send. */
export function createRequiredError(driver: string, name: string | readonly string[]): EmailError {
  const names = Array.isArray(name) ? name.join(", ") : String(name)
  return createError(driver, "INVALID_OPTIONS", `missing required option(s): ${names}`)
}

/** Raised when a message asks for something the driver cannot do. */
export function createUnsupportedError(driver: string, what: string): EmailError {
  return createError(driver, "UNSUPPORTED", `${what} is not supported by "${driver}"`)
}

/** Normalize any thrown value. An existing `EmailError` passes through
 *  untouched so its `retryable` and `status` survive re-wrapping. */
export function toEmailError(driver: string, error: unknown): EmailError {
  if (error instanceof EmailError) return error
  if (isAbort(error)) return createError(driver, "CANCELLED", "aborted", { cause: error })
  if (error instanceof Error) {
    return createError(driver, "PROVIDER", error.message, { cause: error })
  }
  return createError(driver, "PROVIDER", String(error), { cause: error })
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}
