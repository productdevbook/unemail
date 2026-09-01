import type { EmailResult, MaybePromise, Middleware, Result, SendContext } from "../core/types.ts"
import { defineMiddleware } from "../core/define.ts"
import { createError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"

/** Minimal KV contract — small enough that an `unstorage` driver, a Redis
 *  client, or a Workers KV namespace all fit in a few lines. */
export interface IdempotencyStore {
  get: (key: string) => MaybePromise<EmailResult | null>
  set: (key: string, value: EmailResult, ttlSeconds?: number) => MaybePromise<void>
}

export interface IdempotencyOptions {
  /** Where results are remembered. Default: an in-process TTL map, which
   *  only deduplicates within one process — pass a shared store if you
   *  run more than one instance. */
  store?: IdempotencyStore
  /** How long a result is remembered. Default: 86_400 (24h). */
  ttlSeconds?: number
}

/**
 * Return the previous result instead of sending again when a message
 * carries an `idempotencyKey` that has already succeeded.
 *
 * Only successes are remembered: a failed send is not a decision, and
 * retrying it is the whole point of the key.
 *
 * ```ts
 * email.use(withIdempotency({ store: redisStore }))
 * await email.send({ ...msg, idempotencyKey: `welcome:${userId}` })
 * ```
 */
export function withIdempotency(options: IdempotencyOptions = {}): Middleware {
  const store = options.store ?? memoryIdempotencyStore()
  const ttlSeconds = options.ttlSeconds ?? 86_400

  return defineMiddleware("idempotency", (next) => async (msgs, ctx) => {
    const results: (Result<EmailResult> | undefined)[] = Array.from(msgs, () => undefined)
    const pending: number[] = []

    await Promise.all(
      msgs.map(async (msg, index) => {
        if (!msg.idempotencyKey) {
          pending.push(index)
          return
        }
        const cached = await store.get(cacheKey(ctx, msg.idempotencyKey))
        if (cached) results[index] = ok(cached)
        else pending.push(index)
      }),
    )

    if (pending.length > 0) {
      pending.sort((a, b) => a - b)
      const produced = await next(
        pending.map((index) => msgs[index]!),
        ctx,
      )
      await Promise.all(
        pending.map(async (index, slot) => {
          const result = produced[slot]
          if (!result) return
          results[index] = result
          const key = msgs[index]!.idempotencyKey
          if (key && result.data) {
            await store.set(cacheKey(ctx, key), result.data, ttlSeconds)
          }
        }),
      )
    }

    return results.map(
      (result) =>
        result ?? err<EmailResult>(createError(ctx.driver, "PROVIDER", "no result for message")),
    )
  })
}

/** In-process TTL map. Fine for a single instance; not shared across
 *  processes, so it does not survive a restart or reach a sibling pod. */
export function memoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, { value: EmailResult; expiresAt: number }>()
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return null
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key)
        return null
      }
      return entry.value
    },
    set(key, value, ttlSeconds = 86_400) {
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
    },
  }
}

// Keyed by destination, not by key alone: the same logical key sent to two
// providers — or to two streams of one provider — is two different
// deliveries, and returning one's id for the other would make `retrieve()`
// lie about which message it is reporting on.
function cacheKey(ctx: SendContext, key: string): string {
  return `${ctx.driver}:${ctx.stream ?? ""}:${key}`
}
