import type {
  BatchResult,
  EmailDriver,
  EmailMessage,
  EmailResult,
  Middleware,
  NormalizedMessage,
  Result,
  SendContext,
  SendHandler,
  SendStatus,
} from "./types.ts"
import type { MessageDefaults } from "./message.ts"
import { compose, driverHandler } from "./define.ts"
import { createUnsupportedError, toEmailError } from "./error.ts"
import { err, ok, toBatchResult } from "./result.ts"
import { normalizeMessage } from "./message.ts"

/** Everything `createEmail()` accepts. Only `driver` is required. */
export interface CreateEmailOptions {
  /** The driver every message goes to unless `stream` routes it elsewhere. */
  driver: EmailDriver
  /** Named drivers, routed by `message.stream`. Same as calling `mount()`. */
  mounts?: Readonly<Record<string, EmailDriver>>
  /** Middleware, outermost first. Same as calling `use()` in order. */
  use?: readonly Middleware[]
  /** Fields applied to every message that does not set them itself. */
  defaults?: MessageDefaults
  /** Cancels in-flight sends for the whole instance. */
  signal?: AbortSignal
}

/** Options accepted by `sendStream()`. */
export interface SendStreamOptions {
  /** Messages handed to the pipeline at once. Larger values let a driver
   *  batch natively; smaller values yield sooner. Default: 50. */
  chunkSize?: number
}

/** The handle returned by `createEmail()`. */
export interface Email {
  /** The default driver. */
  readonly driver: EmailDriver

  /** Append middleware. Returns `this`, so calls chain. */
  use: (middleware: Middleware) => Email
  /** Route messages carrying this `stream` to `driver`. */
  mount: (stream: string, driver: EmailDriver) => Email
  unmount: (stream: string, options?: { dispose?: boolean }) => Promise<void>
  getMount: (stream?: string) => EmailDriver
  getMounts: () => readonly { stream: string; driver: EmailDriver }[]
  /** Whether the driver believes it can send. Never throws. */
  isAvailable: (stream?: string) => Promise<boolean>

  send: (message: EmailMessage) => Promise<Result<EmailResult>>
  /** Send many. Never short-circuits: `result.results[i]` always
   *  corresponds to `messages[i]`, failed or not. */
  sendBatch: (messages: readonly EmailMessage[]) => Promise<BatchResult>
  /** Same as `sendBatch` without holding every result in memory. */
  sendStream: (
    messages: Iterable<EmailMessage> | AsyncIterable<EmailMessage>,
    options?: SendStreamOptions,
  ) => AsyncIterable<Result<EmailResult>>

  cancel: (id: string, options?: { stream?: string }) => Promise<Result<void>>
  retrieve: (id: string, options?: { stream?: string }) => Promise<Result<SendStatus>>
  dispose: () => Promise<void>
}

/**
 * Build an email instance.
 *
 * ```ts
 * const email = createEmail({
 *   driver: resend({ apiKey: process.env.RESEND_API_KEY! }),
 *   defaults: { from: "Acme <hi@acme.com>" },
 *   use: [withRetry()],
 * })
 *
 * const { data, error } = await email.send({ to, subject, html })
 * ```
 */
export function createEmail(options: CreateEmailOptions): Email {
  const mounts = new Map<string, EmailDriver>(Object.entries(options.mounts ?? {}))
  const middleware: Middleware[] = [...(options.use ?? [])]
  const defaults = options.defaults ?? {}

  // Composition is rebuilt whenever `use()` changes the chain; `revision`
  // is what invalidates the per-driver cache.
  const pipelines = new Map<EmailDriver, { revision: number; handler: SendHandler }>()
  const initializing = new Map<EmailDriver, Promise<void>>()
  let revision = 0

  const api: Email = {
    get driver() {
      return options.driver
    },

    use(mw) {
      middleware.push(mw)
      revision++
      return api
    },

    mount(stream, driver) {
      mounts.set(stream, driver)
      return api
    },

    async unmount(stream, opts = {}) {
      const driver = mounts.get(stream)
      if (!driver) return
      mounts.delete(stream)
      pipelines.delete(driver)
      initializing.delete(driver)
      if (opts.dispose ?? true) await driver.dispose?.()
    },

    getMount(stream) {
      return (stream ? mounts.get(stream) : undefined) ?? options.driver
    },

    getMounts() {
      return [...mounts].map(([stream, driver]) => ({ stream, driver }))
    },

    async isAvailable(stream) {
      const driver = api.getMount(stream)
      if (!driver.isAvailable) return true
      try {
        return await driver.isAvailable()
      } catch {
        return false
      }
    },

    async send(message) {
      const results = await dispatch([message])
      return results[0]!
    },

    async sendBatch(messages) {
      return toBatchResult(await dispatch(messages))
    },

    sendStream(messages, opts = {}) {
      const chunkSize = Math.max(1, opts.chunkSize ?? 50)
      return {
        async *[Symbol.asyncIterator]() {
          let chunk: EmailMessage[] = []
          for await (const message of messages) {
            chunk.push(message)
            if (chunk.length < chunkSize) continue
            yield* await dispatch(chunk)
            chunk = []
          }
          if (chunk.length > 0) yield* await dispatch(chunk)
        },
      }
    },

    async cancel(id, opts = {}) {
      const driver = api.getMount(opts.stream)
      if (!driver.cancel) return err(createUnsupportedError(driver.name, "cancel()"))
      try {
        await ensureInitialized(driver)
        return await driver.cancel(id)
      } catch (error) {
        return err(toEmailError(driver.name, error))
      }
    },

    async retrieve(id, opts = {}) {
      const driver = api.getMount(opts.stream)
      if (!driver.retrieve) return err(createUnsupportedError(driver.name, "retrieve()"))
      try {
        await ensureInitialized(driver)
        return await driver.retrieve(id)
      } catch (error) {
        return err(toEmailError(driver.name, error))
      }
    },

    async dispose() {
      const drivers = new Set<EmailDriver>([options.driver, ...mounts.values()])
      mounts.clear()
      pipelines.clear()
      initializing.clear()
      await Promise.all([...drivers].map((driver) => driver.dispose?.()))
    },
  }

  /**
   * Normalize, group by destination driver, run each group through that
   * driver's pipeline, and stitch the results back into input order.
   *
   * A message that fails normalization takes only its own slot with it —
   * one bad address in a batch of a thousand does not stop the other 999.
   */
  async function dispatch(
    messages: readonly EmailMessage[],
  ): Promise<readonly Result<EmailResult>[]> {
    // Pre-filled, so a slot no driver claims still reports something
    // rather than reading back as a hole.
    const results = Array.from({ length: messages.length }, () =>
      err<EmailResult>(missingResult("unemail")),
    )
    const groups = new Map<EmailDriver, { indices: number[]; msgs: NormalizedMessage[] }>()

    for (const [index, message] of messages.entries()) {
      let normalized: NormalizedMessage
      try {
        normalized = normalizeMessage(message, defaults)
      } catch (error) {
        results[index] = err(toEmailError("unemail", error))
        continue
      }
      const driver = api.getMount(normalized.stream)
      let group = groups.get(driver)
      if (!group) {
        group = { indices: [], msgs: [] }
        groups.set(driver, group)
      }
      group.indices.push(index)
      group.msgs.push(normalized)
    }

    await Promise.all(
      [...groups].map(async ([driver, group]) => {
        const ctx: SendContext = {
          driver: driver.name,
          ...(group.msgs[0]?.stream ? { stream: group.msgs[0].stream } : {}),
          attempt: 1,
          ...(options.signal ? { signal: options.signal } : {}),
          meta: {},
        }
        let produced: readonly Result<EmailResult>[]
        try {
          await ensureInitialized(driver)
          produced = await pipelineFor(driver)(group.msgs, ctx)
        } catch (error) {
          const failure = err<EmailResult>(toEmailError(driver.name, error))
          produced = group.msgs.map(() => failure)
        }
        for (const [slot, index] of group.indices.entries()) {
          results[index] = attachMeta(produced[slot] ?? err(missingResult(driver.name)), ctx.meta)
        }
      }),
    )

    return results
  }

  function pipelineFor(driver: EmailDriver): SendHandler {
    const cached = pipelines.get(driver)
    if (cached && cached.revision === revision) return cached.handler
    const handler = compose(middleware, driverHandler(driver))
    pipelines.set(driver, { revision, handler })
    return handler
  }

  /**
   * Initialize a driver at most once, per driver.
   *
   * The promise is stored before it is awaited: two concurrent sends share
   * one initialization instead of racing past a half-open connection. It
   * is keyed by driver rather than by instance so a driver mounted after
   * the first send still gets initialized.
   */
  function ensureInitialized(driver: EmailDriver): Promise<void> {
    let pending = initializing.get(driver)
    if (pending) return pending
    pending = (async () => {
      try {
        await driver.initialize?.()
      } catch (error) {
        initializing.delete(driver)
        throw toEmailError(driver.name, error)
      }
    })()
    initializing.set(driver, pending)
    return pending
  }

  return api
}

/** Copy the context's notes onto the outcome. This is the only point at
 *  which the per-send context is still in scope and the result already
 *  exists, so without it `SendContext.meta` would be write-only. */
function attachMeta(
  result: Result<EmailResult>,
  meta: Record<string, unknown>,
): Result<EmailResult> {
  if (Object.keys(meta).length === 0) return result
  const snapshot = Object.freeze({ ...meta })
  if (result.error) {
    result.error.meta = snapshot
    return result
  }
  return { data: { ...result.data, meta: snapshot }, error: null }
}

function missingResult(driver: string) {
  return toEmailError(driver, new Error("pipeline produced no result for this message"))
}

export { ok }
