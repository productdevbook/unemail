import type { EmailMessage } from "../types.ts"
import type { EmailQueue, QueueEnqueueOptions, QueueItem } from "./index.ts"

/** A minimal subset of the unstorage \`Storage\` interface — we only need
 *  these four methods, so we don't force a peer dep. Users pass any
 *  unstorage instance (redis, upstash, fs, mongodb, etc.). */
export interface UnstorageLike {
  getItem: <T = unknown>(key: string) => Promise<T | null>
  setItem: (key: string, value: unknown) => Promise<void>
  removeItem: (key: string) => Promise<void>
  getKeys: (base?: string) => Promise<string[]>
}

export interface UnstorageQueueOptions {
  storage: UnstorageLike
  /** Key prefix. Default: \`"unemail:queue:"\`. */
  prefix?: string
}

/** Queue backed by any unstorage driver — turn the in-memory queue into a
 *  durable one by swapping this in. Each item lives under
 *  \`\${prefix}\${id}\`. */
export function unstorageQueue(options: UnstorageQueueOptions): EmailQueue {
  const prefix = options.prefix ?? "unemail:queue:"
  const key = (id: string) => `${prefix}${id}`
  let counter = 0

  return {
    name: "unstorage",
    async enqueue(msg: EmailMessage, opts: QueueEnqueueOptions = {}) {
      const stamp = Date.now()
      const scheduled = msg.scheduledAt ? new Date(msg.scheduledAt).getTime() : 0
      const visible = Math.max(stamp + (opts.delayMs ?? 0), scheduled)
      const item: QueueItem = {
        id: opts.id ?? `uq_${++counter}_${stamp.toString(36)}`,
        msg,
        attempts: 0,
        nextAttemptAt: visible,
        createdAt: stamp,
      }
      await options.storage.setItem(key(item.id), item)
      return item
    },
    async pull(limit: number, now: number) {
      const keys = await options.storage.getKeys(prefix)
      const out: QueueItem[] = []
      for (const k of keys) {
        if (out.length >= limit) break
        const raw = (await options.storage.getItem(k)) as QueueItem | null
        if (!raw) continue
        if (raw.nextAttemptAt <= now) out.push(raw)
      }
      return out
    },
    async ack(id: string) {
      await options.storage.removeItem(key(id))
    },
    async fail(id: string, error: Error, nextAttemptAt: number) {
      const item = (await options.storage.getItem(key(id))) as QueueItem | null
      if (!item) return
      item.attempts++
      item.nextAttemptAt = nextAttemptAt
      item.lastError = error.message
      await options.storage.setItem(key(id), item)
    },
    async size() {
      const keys = await options.storage.getKeys(prefix)
      return keys.length
    },
  }
}

export default unstorageQueue
