/**
 * Narrow, dependency-free helpers for the `Result<T>` discriminated
 * union. Import when you prefer fluent semantics over discriminating
 * `{ data, error }` by hand.
 *
 * @module
 */

import type { EmailError, Result } from "../types.ts"

export function isOk<T>(r: Result<T>): r is { data: T; error: null } {
  return r.error === null
}

export function isErr<T>(r: Result<T>): r is { data: null; error: EmailError } {
  return r.error !== null
}

/** Return `data` or throw the `error`. Intentionally dramatic — only
 *  use when you're sure the caller wants a throw. */
export function unwrap<T>(r: Result<T>): T {
  if (r.error) throw r.error
  return r.data
}

/** Return `data` if Ok, `fallback` otherwise. */
export function unwrapOr<T>(r: Result<T>, fallback: T): T {
  return r.error ? fallback : r.data
}

/** Apply `f` to `data` if Ok; pass through the Err unchanged. */
export function mapOk<T, U>(r: Result<T>, f: (t: T) => U): Result<U> {
  if (r.error) return r as unknown as Result<U>
  return { data: f(r.data), error: null }
}

/** Transform the `error` while preserving Ok. */
export function mapErr<T>(r: Result<T>, f: (e: EmailError) => EmailError): Result<T> {
  if (!r.error) return r
  return { data: null, error: f(r.error) }
}

/** Run `f` and capture any thrown `EmailError` into a `Result`. Any
 *  non-EmailError exception re-throws. */
export async function tryAsync<T>(
  f: () => Promise<T>,
  wrap: (err: unknown) => EmailError,
): Promise<Result<T>> {
  try {
    return { data: await f(), error: null }
  } catch (err) {
    return { data: null, error: wrap(err) }
  }
}
