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

function inboxOf(received: unknown): readonly EmailMessage[] | null {
  const v = received as { inbox?: unknown } | null | undefined
  if (v && Array.isArray(v.inbox)) return v.inbox as readonly EmailMessage[]
  return null
}

/** Vitest-compatible matchers: register from a test setup file.
 *
 *  ```ts
 *  import { expect } from "vitest"
 *  import { emailMatchers } from "unemail/test"
 *  expect.extend(emailMatchers)
 *  ```
 *
 *  Adds:
 *  - `toHaveSent(match)` — any sent email matches the partial.
 *  - `toHaveSentTo(address)` — any sent email contains this recipient.
 *  - `toHaveSentWithSubject(pattern)` — subject matches exact or regex.
 *  - `toHaveSentWithAttachment(filename | predicate)`.
 *  - `toHaveSentMatching(predicate)` — fully custom.
 */
export const emailMatchers = {
  toHaveSent(
    received: { inbox: readonly EmailMessage[] },
    match: EmailMatch,
  ): { pass: boolean; message: () => string } {
    const inbox = inboxOf(received)
    if (!inbox)
      return {
        pass: false,
        message: () =>
          `toHaveSent: received value does not expose an inbox; pass a TestEmail instance`,
      }
    const hits: string[] = []
    for (const msg of inbox) {
      const { pass, diff } = matchesEmail(msg, match)
      if (pass)
        return { pass: true, message: () => `expected no email to match ${JSON.stringify(match)}` }
      if (diff) hits.push(diff)
    }
    return {
      pass: false,
      message: () =>
        `expected an email to match ${JSON.stringify(match)}; checked ${inbox.length} message(s):\n  - ${hits.join("\n  - ")}`,
    }
  },

  toHaveSentTo(
    received: { inbox: readonly EmailMessage[] },
    recipient: string,
  ): { pass: boolean; message: () => string } {
    const inbox = inboxOf(received)
    if (!inbox)
      return {
        pass: false,
        message: () =>
          `toHaveSentTo: received value does not expose an inbox; pass a TestEmail instance`,
      }
    for (const msg of inbox) {
      const emails = [
        ...normalizeAddresses(msg.to),
        ...normalizeAddresses(msg.cc),
        ...normalizeAddresses(msg.bcc),
      ].map((a) => a.email.toLowerCase())
      if (emails.includes(recipient.toLowerCase()))
        return { pass: true, message: () => `expected no email to be sent to ${recipient}` }
    }
    return {
      pass: false,
      message: () =>
        `expected an email to ${recipient}; ${inbox.length} message(s) checked but none matched`,
    }
  },

  toHaveSentWithSubject(
    received: { inbox: readonly EmailMessage[] },
    pattern: string | RegExp,
  ): { pass: boolean; message: () => string } {
    const inbox = inboxOf(received)
    if (!inbox)
      return {
        pass: false,
        message: () =>
          `toHaveSentWithSubject: received value does not expose an inbox; pass a TestEmail instance`,
      }
    for (const msg of inbox) {
      const ok = pattern instanceof RegExp ? pattern.test(msg.subject) : msg.subject === pattern
      if (ok)
        return {
          pass: true,
          message: () => `expected no email with subject ${formatExpected(pattern)}`,
        }
    }
    return {
      pass: false,
      message: () =>
        `expected an email with subject ${formatExpected(pattern)}; got ${inbox.map((m) => JSON.stringify(m.subject)).join(", ")}`,
    }
  },

  toHaveSentWithAttachment(
    received: { inbox: readonly EmailMessage[] },
    match: string | ((a: NonNullable<EmailMessage["attachments"]>[number]) => boolean),
  ): { pass: boolean; message: () => string } {
    const inbox = inboxOf(received)
    if (!inbox)
      return {
        pass: false,
        message: () =>
          `toHaveSentWithAttachment: received value does not expose an inbox; pass a TestEmail instance`,
      }
    const predicate =
      typeof match === "string" ? (a: { filename: string }) => a.filename === match : match
    for (const msg of inbox) {
      if ((msg.attachments ?? []).some(predicate))
        return { pass: true, message: () => `expected no email with a matching attachment` }
    }
    return {
      pass: false,
      message: () =>
        `expected an email with an attachment matching ${typeof match === "string" ? match : "<predicate>"}; checked ${inbox.length} message(s)`,
    }
  },

  toHaveSentMatching(
    received: { inbox: readonly EmailMessage[] },
    predicate: (msg: EmailMessage) => boolean,
  ): { pass: boolean; message: () => string } {
    const inbox = inboxOf(received)
    if (!inbox)
      return {
        pass: false,
        message: () =>
          `toHaveSentMatching: received value does not expose an inbox; pass a TestEmail instance`,
      }
    for (const msg of inbox) {
      if (predicate(msg))
        return { pass: true, message: () => `expected no email to match the predicate` }
    }
    return {
      pass: false,
      message: () => `expected an email to match the predicate; ${inbox.length} checked`,
    }
  },
}

/** Snapshot helper — returns a stable, serializable view of an email.
 *  Volatile fields (Message-ID, Date, random boundaries) are normalized
 *  so snapshots survive reruns. */
export function toEmailSnapshot(msg: EmailMessage): Record<string, unknown> {
  const snap: Record<string, unknown> = {
    from: normalizeAddresses(msg.from).map((a) => a.email),
    to: normalizeAddresses(msg.to).map((a) => a.email),
    subject: msg.subject,
  }
  if (msg.cc) snap.cc = normalizeAddresses(msg.cc).map((a) => a.email)
  if (msg.bcc) snap.bcc = normalizeAddresses(msg.bcc).map((a) => a.email)
  if (msg.text) snap.text = msg.text
  if (msg.html) snap.html = msg.html
  if (msg.headers) snap.headers = sanitizeHeaders(msg.headers)
  if (msg.attachments)
    snap.attachments = msg.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      disposition: a.disposition,
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
    }))
  return snap
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === "message-id" || lower === "date") continue
    out[key] = value
  }
  return out
}
