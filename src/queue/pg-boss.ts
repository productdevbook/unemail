/**
 * pg-boss queue adapter. Uses pg-boss's native delay + attempt
 * semantics. Structural so we don't force the peer dep.
 *
 * @module
 */

import type { EmailMessage } from "../types.ts"
import type { EmailQueue, QueueEnqueueOptions, QueueItem } from "./index.ts"

export interface PgBossLike {
  send: (
    name: string,
    data: unknown,
    opts?: { startAfter?: Date; singletonKey?: string },
  ) => Promise<string | null>
  fetch?: (name: string, limit?: number) => Promise<Array<{ id: string; data: unknown }> | null>
  complete?: (id: string) => Promise<void>
  fail?: (id: string, error?: unknown) => Promise<void>
  getQueueSize?: (name: string) => Promise<number>
}

export interface PgBossQueueOptions {
  boss: PgBossLike
  name?: string
}

export function pgBossQueue(options: PgBossQueueOptions): EmailQueue {
  const name = options.name ?? "email"
  return {
    name: "pg-boss",
    async enqueue(msg: EmailMessage, opts: QueueEnqueueOptions = {}) {
      const scheduled = msg.scheduledAt ? new Date(msg.scheduledAt) : null
      const delayed = opts.delayMs ? new Date(Date.now() + opts.delayMs) : null
      const startAfter =
        scheduled && delayed
          ? scheduled > delayed
            ? scheduled
            : delayed
          : (scheduled ?? delayed ?? undefined)
      const id = await options.boss.send(name, msg, {
        startAfter,
        singletonKey: opts.id,
      })
      return {
        id: id ?? opts.id ?? `pgb_${Date.now().toString(36)}`,
        msg,
        attempts: 0,
        nextAttemptAt: startAfter ? startAfter.getTime() : Date.now(),
        createdAt: Date.now(),
      }
    },
    async pull(limit = 10) {
      const rows = await options.boss.fetch?.(name, limit)
      if (!rows) return []
      return rows.map(
        (r): QueueItem => ({
          id: r.id,
          msg: r.data as EmailMessage,
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: Date.now(),
        }),
      )
    },
    async ack(id: string) {
      await options.boss.complete?.(id)
    },
    async fail(id: string, err: Error) {
      await options.boss.fail?.(id, err.message)
    },
    async size() {
      return (await options.boss.getQueueSize?.(name)) ?? 0
    },
  }
}

export default pgBossQueue
