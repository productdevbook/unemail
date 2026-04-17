import type { Email } from "../email.ts"
import type { EmailMessage } from "../types.ts"
import { createEmail } from "../email.ts"
import mock from "../drivers/mock.ts"

/** An `Email` instance plus an `inbox` that records every message sent
 *  through it. Use in tests instead of stubbing providers by hand. */
export interface TestEmail extends Email {
  readonly inbox: readonly EmailMessage[]
  /** The most recent message, or `undefined` if the inbox is empty. */
  readonly last: EmailMessage | undefined
  /** Find the first message matching a predicate. */
  find: (predicate: (msg: EmailMessage) => boolean) => EmailMessage | undefined
  /** All messages matching a predicate. */
  filter: (predicate: (msg: EmailMessage) => boolean) => EmailMessage[]
  /** Wait up to `timeout` ms for a matching message to arrive. Resolves
   *  with the message; rejects on timeout. */
  waitFor: (
    predicate: (msg: EmailMessage) => boolean,
    options?: { timeout?: number; interval?: number },
  ) => Promise<EmailMessage>
  /** Empty the inbox without disposing the driver. */
  clear: () => void
}

export interface CreateTestEmailOptions {
  /** Pre-populate the inbox (useful for regression fixtures). */
  inbox?: EmailMessage[]
  /** Pass through to the underlying mock driver. */
  fail?: boolean
}

/** Shorthand for tests: `createTestEmail()` returns a working `Email` with
 *  an `inbox` you can assert against. Exposed under `unemail/test`. */
export function createTestEmail(options: CreateTestEmailOptions = {}): TestEmail {
  const inbox: EmailMessage[] = options.inbox ?? []
  const driver = mock({ inbox, fail: options.fail })
  const email = createEmail({ driver })

  Object.defineProperties(email, {
    inbox: { get: () => inbox, enumerable: true },
    last: { get: () => inbox[inbox.length - 1], enumerable: true },
    find: {
      value: (predicate: (msg: EmailMessage) => boolean) => inbox.find(predicate),
    },
    filter: {
      value: (predicate: (msg: EmailMessage) => boolean) => inbox.filter(predicate),
    },
    clear: {
      value: () => {
        inbox.length = 0
      },
    },
    waitFor: {
      value: async (
        predicate: (msg: EmailMessage) => boolean,
        waitOpts: { timeout?: number; interval?: number } = {},
      ): Promise<EmailMessage> => {
        const timeout = waitOpts.timeout ?? 2000
        const interval = waitOpts.interval ?? 10
        const deadline = Date.now() + timeout
        while (Date.now() <= deadline) {
          const match = inbox.find(predicate)
          if (match) return match
          await new Promise((r) => setTimeout(r, interval))
        }
        throw new Error(`[unemail/test] waitFor timed out after ${timeout}ms`)
      },
    },
  })
  return email as TestEmail
}
