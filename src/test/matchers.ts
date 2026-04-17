import type { EmailMessage } from "../types.ts"
import { normalizeAddresses } from "../_normalize.ts"

/** A partial message shape used in assertions. Each field is loose:
 *  strings and RegExps are both accepted for `subject` / `text` / `html`,
 *  and `to`/`from`/`cc`/`bcc` match any supplied address. */
export interface EmailMatch {
  from?: string | RegExp
  to?: string | RegExp
  cc?: string | RegExp
  bcc?: string | RegExp
  subject?: string | RegExp
  text?: string | RegExp
  html?: string | RegExp
  stream?: string
}

/** Check whether `actual` satisfies all fields declared in `expected`. */
export function matchesEmail(
  actual: EmailMessage,
  expected: EmailMatch,
): { pass: boolean; diff: string | null } {
  for (const [key, value] of Object.entries(expected)) {
    if (value == null) continue
    const got = pickField(actual, key as keyof EmailMatch)
    if (!fieldMatches(got, value)) {
      return {
        pass: false,
        diff: `expected ${key}=${formatExpected(value)} but got ${JSON.stringify(got)}`,
      }
    }
  }
  return { pass: true, diff: null }
}

function pickField(msg: EmailMessage, key: keyof EmailMatch): string | string[] | undefined {
  if (key === "from" || key === "to" || key === "cc" || key === "bcc") {
    const value = msg[key] as EmailMessage["to"] | undefined
    return normalizeAddresses(value).map((a) => a.email)
  }
  const value = (msg as unknown as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

function fieldMatches(got: string | string[] | undefined, expected: string | RegExp): boolean {
  if (got == null) return false
  const values = Array.isArray(got) ? got : [got]
  return values.some((v) => (expected instanceof RegExp ? expected.test(v) : v === expected))
}

function formatExpected(value: unknown): string {
  if (value instanceof RegExp) return value.toString()
  return JSON.stringify(value)
}

/** Vitest-compatible matcher: `expect(email).toHaveSent(match)`. Register
 *  from a test setup file:
 *
 *  ```ts
 *  import { expect } from "vitest"
 *  import { emailMatchers } from "unemail/test"
 *  expect.extend(emailMatchers)
 *  ```
 */
export const emailMatchers = {
  toHaveSent(
    received: { inbox: readonly EmailMessage[] },
    match: EmailMatch,
  ): {
    pass: boolean
    message: () => string
  } {
    if (!received || !Array.isArray(received.inbox))
      return {
        pass: false,
        message: () =>
          `toHaveSent: received value does not expose an inbox; pass a TestEmail instance`,
      }
    const hits: string[] = []
    for (const msg of received.inbox) {
      const { pass, diff } = matchesEmail(msg, match)
      if (pass)
        return { pass: true, message: () => `expected no email to match ${JSON.stringify(match)}` }
      if (diff) hits.push(diff)
    }
    return {
      pass: false,
      message: () =>
        `expected an email to match ${JSON.stringify(match)}; checked ${received.inbox.length} message(s):\n  - ${hits.join("\n  - ")}`,
    }
  },
}
