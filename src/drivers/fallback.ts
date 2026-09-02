import type { EmailError } from "../core/error.ts"
import type {
  EmailDriver,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
} from "../core/types.ts"
import { driverHandler } from "../core/define.ts"
import { createInitializer } from "./_lazy-init.ts"
import { createError } from "../core/error.ts"
import { err } from "../core/result.ts"

export interface FallbackOptions {
  /** Which failures move to the next provider. Default: everything except
   *  `INVALID_OPTIONS` and `UNSUPPORTED` — a malformed message will be
   *  just as malformed at the next provider. */
  shouldFailover?: (error: EmailError) => boolean
  /** Called when a leg is abandoned. */
  onFailover?: (from: string, to: string, error: EmailError) => void
  /** Name reported on results and errors. Default: `fallback`. */
  name?: string
}

/**
 * Try each driver in order until one accepts the message.
 *
 * Failover is per message, not per batch: if 3 of 500 fail at the primary,
 * only those 3 go to the secondary — the other 497 are not re-sent, so
 * nobody receives the same mail twice.
 *
 * Compose with `wrap()` to retry inside a leg before moving on:
 *
 * ```ts
 * fallback([wrap(resend({ apiKey }), withRetry()), ses({ region })])
 * ```
 */
export function fallback(
  drivers: readonly EmailDriver[],
  options: FallbackOptions = {},
): EmailDriver {
  if (drivers.length === 0) throw createError("fallback", "INVALID_OPTIONS", "no drivers given")
  const name = options.name ?? "fallback"
  const shouldFailover = options.shouldFailover ?? defaultShouldFailover
  const handlers = drivers.map((driver) => ({ driver, handle: driverHandler(driver) }))
  const initialize = createInitializer()

  async function run(
    msgs: readonly NormalizedMessage[],
    ctx: SendContext,
  ): Promise<readonly Result<EmailResult>[]> {
    const results = Array.from({ length: msgs.length }, () => err<EmailResult>(noResult(name)))
    let pending = msgs.map((_, index) => index)

    for (const [leg, { driver, handle }] of handlers.entries()) {
      if (pending.length === 0) break
      const legCtx: SendContext = { ...ctx, driver: driver.name }
      await initialize(driver)
      const produced = await handle(
        pending.map((index) => msgs[index]!),
        legCtx,
      )

      const next: number[] = []
      for (const [slot, index] of pending.entries()) {
        const result = produced[slot] ?? err<EmailResult>(noResult(driver.name))
        results[index] = result
        if (!result.error) continue
        const successor = handlers[leg + 1]
        if (successor && shouldFailover(result.error)) {
          options.onFailover?.(driver.name, successor.driver.name, result.error)
          next.push(index)
        }
      }
      pending = next
    }

    return results
  }

  return {
    name,
    features: mergeFeatures(drivers),
    // Legs initialize lazily as each is reached: opening a connection to a
    // standby provider that is never used is wasted work.
    getInstance: () => drivers,
    async dispose() {
      await Promise.all(drivers.map((driver) => driver.dispose?.()))
    },
    async isAvailable() {
      const checks = await Promise.all(
        drivers.map(async (driver) => {
          try {
            return (await driver.isAvailable?.()) ?? true
          } catch {
            return false
          }
        }),
      )
      return checks.some(Boolean)
    },
    async send(msg, ctx) {
      return (await run([msg], ctx))[0]!
    },
    sendBatch: (msgs, ctx) => run(msgs, ctx),
  }
}

function defaultShouldFailover(error: EmailError): boolean {
  return error.code !== "INVALID_OPTIONS" && error.code !== "UNSUPPORTED"
}

/** A capability is advertised when the leg most likely to run it has it —
 *  the first driver, since later legs only see what it could not send. */
function mergeFeatures(drivers: readonly EmailDriver[]) {
  return drivers[0]?.features
}

function noResult(driver: string) {
  return createError(driver, "PROVIDER", "no result for message")
}
