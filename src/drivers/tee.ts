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
import { createError, toEmailError } from "../core/error.ts"
import { err } from "../core/result.ts"

/** One message one secondary leg would not take. */
export interface TeeFailure {
  readonly driver: string
  /** Position in the list handed to tee — `0` for a single `send()`. */
  readonly index: number
  readonly error: EmailError
}

export interface TeeOptions {
  /** Called once per message a secondary rejected. */
  onSecondaryError?: (failure: TeeFailure) => void
  /** Name reported on results and errors. Default: `tee`. */
  name?: string
}

/** Where the secondaries' failures are left on `SendContext.meta`, which
 *  the core copies onto every `EmailResult` and `EmailError` of the send.
 *  Appended to rather than replaced, so nested tees and a retried attempt
 *  each keep their record. */
export const TEE_META_KEY = "tee"

/**
 * Send the same message through several drivers at once — to shadow a new
 * provider against the incumbent, or to mirror real mail into a local
 * catcher while developing.
 *
 * The first driver is the primary and its result is the send's result. A
 * secondary's failure never fails the send: a mirror that cannot take the
 * message must not stop the message, which is the whole difference between
 * this and `fallback`. It is not swallowed either — every rejection is
 * appended to `ctx.meta.tee`, which reaches the caller on `result.meta` and
 * on `error.meta`, and is handed to `onSecondaryError` as it happens.
 *
 * ```ts
 * const { data } = await createEmail({
 *   driver: tee([resend({ apiKey }), mock()]),
 * }).send(msg)
 * data?.meta?.tee // the shadow's failures, if any
 * ```
 */
export function tee(drivers: readonly EmailDriver[], options: TeeOptions = {}): EmailDriver {
  if (drivers.length === 0) throw createError("tee", "INVALID_OPTIONS", "no drivers given")
  const name = options.name ?? "tee"
  const handlers = drivers.map((driver) => ({ driver, handle: driverHandler(driver) }))
  const initialize = createInitializer()

  async function runLeg(
    leg: { driver: EmailDriver; handle: ReturnType<typeof driverHandler> },
    msgs: readonly NormalizedMessage[],
    ctx: SendContext,
  ): Promise<readonly Result<EmailResult>[]> {
    try {
      await initialize(leg.driver)
      return await leg.handle(msgs, { ...ctx, driver: leg.driver.name })
    } catch (error) {
      const failure = err<EmailResult>(toEmailError(leg.driver.name, error))
      return msgs.map(() => failure)
    }
  }

  async function run(
    msgs: readonly NormalizedMessage[],
    ctx: SendContext,
  ): Promise<readonly Result<EmailResult>[]> {
    // Every leg starts at once and every leg is awaited. Concurrent
    // because a shadow only measures anything if it runs under the same
    // conditions as the primary, and running in series would charge the
    // caller the mirror's latency on top of the real send rather than the
    // slowest leg's. Awaited because a dropped promise never finishes on a
    // runtime that freezes the isolate at the response, and because
    // `ctx.meta` is snapshotted the moment the pipeline returns — a mirror
    // reporting after that reports to nobody.
    const legs = await Promise.all(handlers.map((leg) => runLeg(leg, msgs, ctx)))

    for (const [leg, produced] of legs.entries()) {
      if (leg === 0) continue
      const driver = handlers[leg]!.driver.name
      for (const [index, result] of produced.entries()) {
        if (!result.error) continue
        record(ctx, { driver, index, error: result.error })
      }
    }

    const primary = legs[0] ?? []
    return msgs.map((_, index) => primary[index] ?? err<EmailResult>(noResult(name)))
  }

  function record(ctx: SendContext, failure: TeeFailure): void {
    const existing = ctx.meta[TEE_META_KEY]
    if (Array.isArray(existing)) existing.push(failure)
    else ctx.meta[TEE_META_KEY] = [failure]
    options.onSecondaryError?.(failure)
  }

  return {
    name,
    // The primary's, because the primary is the leg whose outcome is
    // returned. A secondary that cannot do something only ever produces a
    // recorded failure.
    features: drivers[0]?.features,
    getInstance: () => drivers,
    async dispose() {
      await Promise.all(drivers.map((driver) => driver.dispose?.()))
    },
    // Availability tracks the primary alone, for the same reason: a mirror
    // being down is not a reason to stop sending.
    async isAvailable() {
      try {
        return (await drivers[0]?.isAvailable?.()) ?? true
      } catch {
        return false
      }
    },

    async send(msg, ctx) {
      return (await run([msg], ctx))[0] ?? err<EmailResult>(noResult(name))
    },
    sendBatch: (msgs, ctx) => run(msgs, ctx),
  }
}

function noResult(driver: string) {
  return createError(driver, "PROVIDER", "no result for message")
}
