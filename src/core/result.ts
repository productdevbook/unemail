import type { BatchResult, EmailResult, Result } from "./types.ts"
import type { EmailError } from "./error.ts"

/** Wrap a value as a success. */
export function ok<T>(data: T): Result<T> {
  return { data, error: null }
}

/** Wrap an error as a failure. */
export function err<T = never>(error: EmailError): Result<T> {
  return { data: null, error }
}

/** Narrow a `Result` to its success branch. */
export function isOk<T>(result: Result<T>): result is { data: T; error: null } {
  return result.error === null
}

/** Throw on failure, return the value on success. For callers who prefer
 *  exceptions to branching — `const sent = unwrap(await email.send(msg))`. */
export function unwrap<T>(result: Result<T>): T {
  if (result.error) throw result.error
  return result.data
}

/** Summarize positional per-message results. Never loses a partial
 *  success: `sent` holds what got through even when `ok` is false. */
export function toBatchResult(results: readonly Result<EmailResult>[]): BatchResult {
  const sent: EmailResult[] = []
  const failed: { index: number; error: EmailError }[] = []
  for (const [index, result] of results.entries()) {
    if (result.error) failed.push({ index, error: result.error })
    else sent.push(result.data)
  }
  return { results, sent, failed, ok: failed.length === 0 }
}
