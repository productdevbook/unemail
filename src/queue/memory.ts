import type { EmailMessage } from "../types.ts"
import type { EmailQueue, QueueEnqueueOptions, QueueItem } from "./index.ts"

export interface MemoryQueueOptions {
  /** Maximum items allowed in the queue. Defaults to \`Infinity\`. */
  maxSize?: number
  /** Clock source — injected for tests. Default: \`Date.now\`. */
  now?: () => number
}

/** Simple in-memory queue. Fine for single-instance servers and tests.
 *  For multi-process deployments use the unstorage adapter or plug a
 *  SaaS driver (QStash, SQS). */
export function memoryQueue(options: MemoryQueueOptions = {}): EmailQueue {
  const maxSize = options.maxSize ?? Number.POSITIVE_INFINITY
  const now = options.now ?? Date.now
  const items: QueueItem[] = []
  let counter = 0

  return {
    name: "memory",
    enqueue(msg: EmailMessage, opts: QueueEnqueueOptions = {}) {
      if (items.length >= maxSize)
        throw new Error(`[unemail/queue/memory] max size ${maxSize} reached`)
      const stamp = now()
      const scheduled = msg.scheduledAt ? new Date(msg.scheduledAt).getTime() : 0
      const visible = Math.max(stamp + (opts.delayMs ?? 0), scheduled)
      const item: QueueItem = {
        id: opts.id ?? `mq_${++counter}_${stamp.toString(36)}`,
        msg,
        attempts: 0,
        nextAttemptAt: visible,
        createdAt: stamp,
      }
      items.push(item)
      return item
    },
    pull(limit: number, now: number) {
      const eligible: QueueItem[] = []
      for (const item of items) {
        if (item.nextAttemptAt <= now) eligible.push(item)
        if (eligible.length >= limit) break
      }
      return eligible
    },
    ack(id: string) {
      const idx = items.findIndex((i) => i.id === id)
      if (idx >= 0) items.splice(idx, 1)
    },
    fail(id: string, error: Error, nextAttemptAt: number) {
      const item = items.find((i) => i.id === id)
      if (!item) return
      item.attempts++
      item.nextAttemptAt = nextAttemptAt
      item.lastError = error.message
    },
    size() {
      return items.length
    },
  }
}

export default memoryQueue
