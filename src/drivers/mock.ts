import type { DriverFactory, EmailMessage, EmailResult } from "../types.ts"
import { defineDriver } from "../_define.ts"

/** Options for the `mock` driver — a drop-in replacement used in tests that
 *  records every sent message instead of hitting the network. */
export interface MockDriverOptions {
  /** When true, drivers simulate a rejection on every send — useful for
   *  exercising `onError` middleware. */
  fail?: boolean
  /** Inspect or mutate the captured inbox. Exposed via `driver.inbox` too. */
  inbox?: EmailMessage[]
}

/** Driver with an injected `inbox` you can assert against. Also returned as
 *  `driver.getInstance()`. */
const mock: DriverFactory<MockDriverOptions, EmailMessage[]> = defineDriver<
  MockDriverOptions,
  EmailMessage[]
>((options) => {
  const inbox: EmailMessage[] = options?.inbox ?? []
  let counter = 0

  return {
    name: "mock",
    options,
    flags: {
      attachments: true,
      html: true,
      text: true,
      batch: true,
      replyTo: true,
      customHeaders: true,
      tagging: true,
      idempotency: true,
      scheduling: true,
    },
    getInstance: () => inbox,
    async isAvailable() {
      return !options?.fail
    },
    send(msg, ctx) {
      if (options?.fail) {
        return {
          data: null,
          error: new (class extends Error {})(`[unemail] [mock] configured to fail`) as never,
        }
      }
      inbox.push(msg)
      const result: EmailResult = {
        id: `mock_${++counter}_${Date.now()}`,
        driver: "mock",
        stream: ctx.stream,
        at: new Date(),
      }
      return { data: result, error: null }
    },
    async sendBatch(msgs, ctx) {
      const out: EmailResult[] = []
      for (const msg of msgs) {
        const r = await this.send(msg, ctx)
        if (r.error) return r as never
        out.push(r.data!)
      }
      return { data: out, error: null }
    },
  }
})

export default mock
