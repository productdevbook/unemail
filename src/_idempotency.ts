import type { EmailResult, IdempotencyStore } from "./types.ts"

/** Default in-memory idempotency store with TTL eviction.
 *
 *  Fine for single-instance servers and tests. For multi-process or
 *  serverless deployments, plug in an `unstorage`-backed store or a
 *  custom `IdempotencyStore` implementation. */
export function memoryIdempotencyStore(defaultTtlSeconds = 3600): IdempotencyStore {
  const store = new Map<string, { value: EmailResult; expiresAt: number }>()
  return {
    get(key) {
      const entry = store.get(key)
      if (!entry) return null
      if (entry.expiresAt <= Date.now()) {
        store.delete(key)
        return null
      }
      return entry.value
    },
    set(key, value, ttlSeconds) {
      const ttl = (ttlSeconds ?? defaultTtlSeconds) * 1000
      store.set(key, { value, expiresAt: Date.now() + ttl })
    },
  }
}
