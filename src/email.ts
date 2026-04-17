import type {
  EmailDriver,
  EmailMessage,
  EmailResult,
  IdempotencyStore,
  MaybePromise,
  Middleware,
  Result,
  SendContext,
} from "./types.ts"
import { memoryIdempotencyStore } from "./_idempotency.ts"
import { toEmailError } from "./errors.ts"

/** Options accepted by `createEmail()`. Only `driver` is required; the rest
 *  have sensible, zero-dependency defaults. */
export interface CreateEmailOptions {
  driver: EmailDriver
  /** When set, enables idempotency-key deduplication backed by this store.
   *  Defaults to an in-memory TTL store when `idempotency` is `true`. */
  idempotency?: boolean | { store?: IdempotencyStore; ttlSeconds?: number }
  /** Abort signal forwarded to drivers via `SendContext.signal`. */
  signal?: AbortSignal
}

/** Public handle returned by `createEmail()`. Mirrors the unstorage-style
 *  mount API so callers can route by `message.stream`. */
export interface Email {
  readonly driver: EmailDriver
  use: (middleware: Middleware) => Email
  mount: (stream: string, driver: EmailDriver) => Email
  unmount: (stream: string, dispose?: boolean) => Promise<void>
  getMount: (stream?: string) => EmailDriver
  getMounts: () => ReadonlyArray<{ stream: string; driver: EmailDriver }>
  isAvailable: (stream?: string) => Promise<boolean>
  send: (msg: EmailMessage) => Promise<Result<EmailResult>>
  sendBatch: (msgs: ReadonlyArray<EmailMessage>) => Promise<Result<ReadonlyArray<EmailResult>>>
  /** Stream the results of `sendBatch` one at a time — useful for
   *  large (5k+) fan-outs where you don't want every `EmailResult` in
   *  memory. Unlike `sendBatch` it never short-circuits on the first
   *  error; each message yields its own Result. */
  sendBatchStream: (msgs: ReadonlyArray<EmailMessage>) => AsyncIterable<Result<EmailResult>>
  dispose: () => Promise<void>
}

/** Construct an `Email` instance. This is the single entry point — every
 *  transport (SMTP, Resend, SES, Postmark, Workers, …) is a `driver` plug.
 *
 *  ```ts
 *  const email = createEmail({ driver: resend({ apiKey }) })
 *  const { data, error } = await email.send({ from, to, subject, text })
 *  ```
 */
export function createEmail(options: CreateEmailOptions): Email {
  const mounts = new Map<string, EmailDriver>()
  const middleware: Middleware[] = []
  let initialized = false

  const idempotency = resolveIdempotency(options.idempotency)

  const api: Email = {
    get driver() {
      return options.driver
    },

    use(mw) {
      middleware.push(mw)
      return api
    },

    mount(stream, driver) {
      mounts.set(stream, driver)
      return api
    },

    async unmount(stream, dispose = true) {
      const driver = mounts.get(stream)
      if (!driver) return
      mounts.delete(stream)
      if (dispose) await driver.dispose?.()
    },

    getMount(stream) {
      if (!stream) return options.driver
      return mounts.get(stream) ?? options.driver
    },

    getMounts() {
      return Array.from(mounts.entries(), ([stream, driver]) => ({ stream, driver }))
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

    async send(msg) {
      await ensureInitialized()

      if (msg.idempotencyKey && idempotency) {
        const cached = await idempotency.store.get(msg.idempotencyKey)
        if (cached) return { data: cached, error: null }
      }

      const driver = api.getMount(msg.stream)
      const ctx: SendContext = {
        driver: driver.name,
        stream: msg.stream,
        attempt: 1,
        signal: options.signal,
        meta: {},
      }

      try {
        msg = applyUnsubscribeHeaders(msg)
        await runHook("beforeSend", (mw) => mw.beforeSend?.(msg, ctx))

        let result = await driver.send(msg, ctx)

        if (result.error) {
          const recovered = await tryRecover(msg, ctx, result.error)
          if (recovered) result = recovered
        }

        if (result.data && msg.idempotencyKey && idempotency) {
          await idempotency.store.set(msg.idempotencyKey, result.data, idempotency.ttlSeconds)
        }

        await runHook("afterSend", (mw) => mw.afterSend?.(msg, ctx, result))
        return result
      } catch (error) {
        const emailError = toEmailError(driver.name, error)
        const recovered = await tryRecover(msg, ctx, emailError)
        if (recovered) return recovered
        return { data: null, error: emailError }
      }
    },

    async sendBatch(msgs) {
      await ensureInitialized()
      if (msgs.length === 0) return { data: [], error: null }
      const driver = api.getMount(msgs[0]!.stream)
      const ctx: SendContext = {
        driver: driver.name,
        stream: msgs[0]!.stream,
        attempt: 1,
        signal: options.signal,
        meta: {},
      }
      if (driver.sendBatch) return Promise.resolve(driver.sendBatch(msgs, ctx)).then(resultOrError)
      // Fallback — sequential sends honoring individual idempotency keys.
      const results: EmailResult[] = []
      for (const msg of msgs) {
        const res = await api.send(msg)
        if (res.error) return res as Result<ReadonlyArray<EmailResult>>
        results.push(res.data)
      }
      return { data: results, error: null }
    },

    sendBatchStream(msgs) {
      const api2 = api
      return {
        async *[Symbol.asyncIterator]() {
          await ensureInitialized()
          for (const msg of msgs) yield await api2.send(msg)
        },
      }
    },

    async dispose() {
      await options.driver.dispose?.()
      for (const driver of mounts.values()) await driver.dispose?.()
      mounts.clear()
    },
  }

  async function ensureInitialized() {
    if (initialized) return
    initialized = true
    await options.driver.initialize?.()
    for (const driver of mounts.values()) await driver.initialize?.()
  }

  async function runHook<K extends keyof Middleware>(
    _kind: K,
    apply: (mw: Middleware) => MaybePromise<unknown>,
  ) {
    for (const mw of middleware) await apply(mw)
  }

  async function tryRecover(
    msg: EmailMessage,
    ctx: SendContext,
    error: Parameters<Required<Middleware>["onError"]>[2],
  ) {
    for (const mw of middleware) {
      const recovered = await mw.onError?.(msg, ctx, error)
      if (recovered) return recovered
    }
    return null
  }

  return api
}

function applyUnsubscribeHeaders(msg: EmailMessage): EmailMessage {
  if (!msg.unsubscribe) return msg
  const { url, mailto, oneClick } = msg.unsubscribe
  if (!url && !mailto) return msg
  const parts: string[] = []
  if (url) parts.push(`<${url}>`)
  if (mailto) parts.push(`<mailto:${mailto}>`)
  const existing = msg.headers ?? {}
  const headers: Record<string, string> = { ...existing }
  if (!hasHeader(existing, "list-unsubscribe")) {
    headers["List-Unsubscribe"] = parts.join(", ")
  }
  const wantsOneClick = oneClick ?? Boolean(url)
  if (wantsOneClick && url && !hasHeader(existing, "list-unsubscribe-post")) {
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
  }
  return { ...msg, headers }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return true
  }
  return false
}

function resolveIdempotency(
  input: CreateEmailOptions["idempotency"],
): { store: IdempotencyStore; ttlSeconds?: number } | null {
  if (!input) return null
  if (input === true) return { store: memoryIdempotencyStore() }
  return { store: input.store ?? memoryIdempotencyStore(), ttlSeconds: input.ttlSeconds }
}

function resultOrError<T>(r: Result<T>): Result<T> {
  return r
}
