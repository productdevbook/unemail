import type { EmailDriver, EmailMessage, EmailResult, IdempotencyStore } from "../types.ts"
import { memoryIdempotencyStore } from "../_idempotency.ts"
import { normalizeAddresses } from "../_normalize.ts"

/** Strategy for computing the dedupe key.
 *  - `"idempotencyKey"` — use `msg.idempotencyKey` only.
 *  - `"contentHash"` — hash subject + body + recipient list.
 *  - `"recipient+subject"` — lightweight: hash recipient + subject
 *    (good enough for "don't double-send this notification"). */
export type DedupeStrategy = "idempotencyKey" | "contentHash" | "recipient+subject"

export interface DedupeOptions {
  store?: IdempotencyStore
  strategy?: DedupeStrategy
  ttlSeconds?: number
  /** Custom key resolver. Overrides `strategy`. */
  keyFn?: (msg: EmailMessage) => string | null
}

/** Wrap a driver so repeated sends within `ttlSeconds` return the
 *  cached success instead of hitting the provider again. */
export function withDedupe(driver: EmailDriver, options: DedupeOptions = {}): EmailDriver {
  const store = options.store ?? memoryIdempotencyStore()
  const strategy = options.strategy ?? "idempotencyKey"
  const ttl = options.ttlSeconds ?? 300
  const keyFn = options.keyFn ?? defaultKeyFn(strategy)
  return {
    ...driver,
    async send(msg, ctx) {
      const key = keyFn(msg)
      if (!key) return driver.send(msg, ctx)
      const cached = await store.get(key)
      if (cached) return { data: cached, error: null }
      const result = await driver.send(msg, ctx)
      if (result.data) await store.set(key, result.data, ttl)
      return result
    },
  }
}

function defaultKeyFn(strategy: DedupeStrategy): (msg: EmailMessage) => string | null {
  switch (strategy) {
    case "idempotencyKey":
      return (m) => m.idempotencyKey ?? null
    case "recipient+subject":
      return (m) => {
        const rcpts = normalizeAddresses(m.to)
          .map((a) => a.email.toLowerCase())
          .sort()
          .join(",")
        return `rcpt:${rcpts}|subj:${m.subject}`
      }
    case "contentHash":
      return (m) => {
        const rcpts = normalizeAddresses(m.to)
          .map((a) => a.email.toLowerCase())
          .sort()
          .join(",")
        return `rcpt:${rcpts}|subj:${m.subject}|body:${hash(m.text ?? "") ^ hash(m.html ?? "")}`
      }
  }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

// Re-export so consumers get a single place to find it.
export type { EmailDriver, EmailResult }
