import type { DriverWithInstance, EmailResult, NormalizedMessage, Result } from "../core/types.ts"
import { defineDriver } from "../core/define.ts"
import { createError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"

/** The captured mailbox, also returned by `driver.getInstance()`. */
export interface MockInbox {
  /** Every message the driver accepted, in order, already normalized. */
  readonly messages: readonly NormalizedMessage[]
  /** Messages whose recipients include `address`, case-insensitively. */
  find: (address: string) => readonly NormalizedMessage[]
  /** The most recent message, or `undefined`. */
  last: () => NormalizedMessage | undefined
  clear: () => void
}

export interface MockDriverOptions {
  /** Fail every send with this code. Use it to exercise retry, circuit
   *  breaker, and failover without a network. */
  fail?: boolean | { code?: "NETWORK" | "AUTH" | "RATE_LIMIT" | "PROVIDER"; message?: string }
  /** Fail only the messages this predicate matches — for testing partial
   *  batch failures, which is where most batch bugs live. */
  failWhen?: (msg: NormalizedMessage, index: number) => boolean
  /** Artificial delay per send, in milliseconds. */
  latencyMs?: number
  /** Reuse an inbox across instances. */
  inbox?: MockInbox
}

/**
 * An in-memory driver that records instead of sending.
 *
 * ```ts
 * const driver = mock()
 * const email = createEmail({ driver, defaults: { from: "a@b.com" } })
 * await email.send({ to: "c@d.com", subject: "hi", text: "hello" })
 * expect(driver.getInstance().last()?.subject).toBe("hi")
 * ```
 */
const mock: (options?: MockDriverOptions) => DriverWithInstance<MockInbox> = defineDriver<
  MockDriverOptions | void,
  MockInbox
>((options) => {
  const opts = options || {}
  const inbox = opts.inbox ?? createInbox()
  let counter = 0

  function failure(): Result<EmailResult> {
    const spec = typeof opts.fail === "object" ? opts.fail : {}
    return err(createError("mock", spec.code ?? "PROVIDER", spec.message ?? "configured to fail"))
  }

  return {
    name: "mock",
    features: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      scheduling: true,
      idempotency: true,
      tagging: true,
      templates: true,
      tracking: true,
      replyTo: true,
      customHeaders: true,
      sandbox: true,
    },

    getInstance: () => inbox,
    isAvailable: () => opts.fail !== true,

    async send(msg, ctx) {
      if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs))
      if (opts.fail || opts.failWhen?.(msg, 0)) return failure()
      ;(inbox.messages as NormalizedMessage[]).push(msg)
      return ok({
        id: `mock_${++counter}`,
        driver: "mock",
        ...(ctx.stream ? { stream: ctx.stream } : {}),
        at: new Date(),
      })
    },

    async sendBatch(msgs, ctx) {
      const results: Result<EmailResult>[] = []
      for (const [index, msg] of msgs.entries()) {
        if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs))
        if (opts.fail || opts.failWhen?.(msg, index)) {
          results.push(failure())
          continue
        }
        ;(inbox.messages as NormalizedMessage[]).push(msg)
        results.push(
          ok({
            id: `mock_${++counter}`,
            driver: "mock",
            ...(ctx.stream ? { stream: ctx.stream } : {}),
            at: new Date(),
          }),
        )
      }
      return results
    },
  }
})

export default mock

/** Build a standalone inbox, for sharing one across several mock drivers. */
export function createInbox(): MockInbox {
  const messages: NormalizedMessage[] = []
  return {
    messages,
    find(address) {
      const target = address.toLowerCase()
      return messages.filter((msg) =>
        [...msg.to, ...msg.cc, ...msg.bcc].some((a) => a.email.toLowerCase() === target),
      )
    },
    last: () => messages.at(-1),
    clear: () => {
      messages.length = 0
    },
  }
}
