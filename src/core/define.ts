import type {
  DriverFactory,
  EmailDriver,
  EmailResult,
  Middleware,
  NormalizedMessage,
  Result,
  SendContext,
  SendHandler,
} from "./types.ts"
import { err, ok } from "./result.ts"
import type { EmailError } from "./error.ts"
import { createUnsupportedError, toEmailError } from "./error.ts"

/**
 * Declare a driver. Purely a typing helper — it makes `TOpts` required
 * when it has required fields, so a missing API key is a compile error
 * rather than a throw on the first send.
 *
 * ```ts
 * export default defineDriver<{ apiKey: string }>((options) => ({
 *   name: "acme",
 *   features: { html: true },
 *   send: (msg) => post(options.apiKey, msg),
 * }))
 * ```
 */
export function defineDriver<TOpts = void, TInstance = unknown>(
  factory: DriverFactory<TOpts, TInstance>,
): DriverFactory<TOpts, TInstance> {
  return factory
}

/**
 * Declare a middleware. One shape covers retry, logging, rate limiting and
 * everything else: wrap the next handler and return the results.
 *
 * The unit of work is a list, so a middleware sees the whole batch and can
 * act on part of it — retry re-sends only the failed indices, even when
 * the driver reached the provider in a single request.
 *
 * ```ts
 * const timing = defineMiddleware("timing", (next) => async (msgs, ctx) => {
 *   const start = Date.now()
 *   const results = await next(msgs, ctx)
 *   ctx.meta.durationMs = Date.now() - start
 *   return results
 * })
 * ```
 */
export function defineMiddleware(
  name: string,
  handle: (next: SendHandler) => SendHandler,
): Middleware {
  return { name, handle }
}

/** Lift a per-message function into a middleware, for the common case
 *  where the batch is irrelevant. Messages are processed concurrently. */
export function perMessage(
  name: string,
  handle: (
    next: (msg: NormalizedMessage, ctx: SendContext) => Promise<Result<EmailResult>>,
  ) => (msg: NormalizedMessage, ctx: SendContext) => Promise<Result<EmailResult>>,
): Middleware {
  return defineMiddleware(name, (next) => {
    const one = handle(async (msg, ctx) => (await next([msg], ctx))[0]!)
    return async (msgs, ctx) => Promise.all(msgs.map((msg) => one(msg, ctx)))
  })
}

/**
 * Compose middleware around a handler. The first registered middleware is
 * the outermost, so `use(logger); use(retry)` logs once around all the
 * retries rather than once per attempt.
 */
export function compose(middleware: readonly Middleware[], handler: SendHandler): SendHandler {
  let composed = handler
  for (let i = middleware.length - 1; i >= 0; i--) {
    composed = guard(middleware[i]!.name, middleware[i]!.handle(composed))
  }
  return composed
}

/**
 * Attach middleware to a single driver rather than a whole instance. This
 * is what makes retry compose with failover: each leg retries on its own
 * before the fallback moves to the next.
 *
 * ```ts
 * fallback([wrap(resend(...), withRetry()), wrap(ses(...), withRetry())])
 * ```
 */
export function wrap<TInstance>(
  driver: EmailDriver<TInstance>,
  ...middleware: readonly Middleware[]
): EmailDriver<TInstance> {
  if (middleware.length === 0) return driver
  const handler = compose(middleware, driverHandler(driver))
  return {
    ...driver,
    send: async (msg, ctx) => (await handler([msg], ctx))[0]!,
    sendBatch: (msgs, ctx) => handler(msgs, ctx),
  }
}

/**
 * The terminal handler: hand the list to the driver. Uses `sendBatch` when
 * the driver has one, otherwise sends sequentially — and either way
 * returns exactly one result per input.
 */
export function driverHandler(driver: EmailDriver): SendHandler {
  async function deliver(
    msgs: readonly NormalizedMessage[],
    ctx: SendContext,
  ): Promise<readonly Result<EmailResult>[]> {
    if (msgs.length > 1 && driver.sendBatch) {
      let results: readonly Result<EmailResult>[]
      try {
        results = await driver.sendBatch(msgs, ctx)
      } catch (error) {
        const wrapped = err<EmailResult>(toEmailError(driver.name, error))
        return msgs.map(() => wrapped)
      }
      if (results.length !== msgs.length) {
        // A driver that loses the 1:1 mapping makes every downstream
        // index meaningless, so fail the batch rather than guess.
        const mismatch = err<EmailResult>(
          toEmailError(
            driver.name,
            new Error(`sendBatch returned ${results.length} results for ${msgs.length} messages`),
          ),
        )
        return msgs.map(() => mismatch)
      }
      return results
    }

    const out: Result<EmailResult>[] = []
    for (const msg of msgs) {
      if (ctx.signal?.aborted) {
        out.push(err(toEmailError(driver.name, ctx.signal.reason ?? new Error("aborted"))))
        continue
      }
      try {
        out.push(await driver.send(msg, ctx))
      } catch (error) {
        out.push(err(toEmailError(driver.name, error)))
      }
    }
    return out
  }

  return async (msgs, ctx) => {
    if (msgs.length === 0) return []

    // Before choosing a branch: the native-batch path never reaches the
    // per-message check below, so an already-aborted send would otherwise
    // go out anyway.
    if (ctx.signal?.aborted) {
      const cancelled = err<EmailResult>(
        toEmailError(driver.name, ctx.signal.reason ?? new Error("aborted")),
      )
      return msgs.map(() => cancelled)
    }

    // A message asking for something the driver has said it cannot do is
    // refused rather than quietly sent wrong: a template-only message on a
    // driver without templates has no body at all, and `scheduledAt` on one
    // without scheduling goes out immediately. Only that message fails —
    // the rest of the batch is unaffected, as with any other failure.
    const unsupported = msgs.map((msg) => unsupportedFor(driver, msg))
    if (!unsupported.some(Boolean)) return deliver(msgs, ctx)

    const sendable = msgs.filter((_, index) => !unsupported[index])
    const produced = sendable.length > 0 ? await deliver(sendable, ctx) : []
    let slot = 0
    return msgs.map((_, index) => {
      const refusal = unsupported[index]
      return refusal ? err<EmailResult>(refusal) : produced[slot++]!
    })
  }
}

/** What this driver cannot do with this message, if anything. Only
 *  features whose absence changes what the recipient receives are checked;
 *  a driver that ignores `tags` still sends the right mail. */
function unsupportedFor(driver: EmailDriver, msg: NormalizedMessage): EmailError | null {
  const features = driver.features
  if (!features) return null
  if (msg.template && !features.templates) {
    return createUnsupportedError(driver.name, "`template`")
  }
  if (msg.scheduledAt && !features.scheduling) {
    return createUnsupportedError(driver.name, "`scheduledAt`")
  }
  if (msg.sandbox && !features.sandbox) {
    return createUnsupportedError(driver.name, "`sandbox`")
  }
  if (msg.attachments.length > 0 && features.attachments === false) {
    return createUnsupportedError(driver.name, "`attachments`")
  }
  return null
}

/** A middleware that throws must not take the batch down with it — its
 *  failure is reported per message, like any other. */
function guard(name: string, handler: SendHandler): SendHandler {
  return async (msgs, ctx) => {
    try {
      const results = await handler(msgs, ctx)
      if (results.length === msgs.length) return results
      throw new Error(`middleware "${name}" returned ${results.length} of ${msgs.length} results`)
    } catch (error) {
      const wrapped = err<EmailResult>(toEmailError(ctx.driver, error))
      return msgs.map(() => wrapped)
    }
  }
}

/** Re-exported so drivers can build results without importing `result.ts`
 *  separately. */
export { ok, err }
