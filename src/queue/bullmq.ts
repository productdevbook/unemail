/**
 * BullMQ queue adapter. Kept structural so we don't force `bullmq` as
 * a peer dep — pass any object that exposes the three methods we use.
 *
 * ```ts
 * import { Queue } from "bullmq"
 * import { bullmqQueue } from "unemail/queue/bullmq"
 *
 * const queue = bullmqQueue({
 *   bull: new Queue("email", { connection: { host: "redis" } }),
 * })
 * ```
 *
 * Notes:
 * - `scheduledAt` / `delayMs` map to BullMQ's `delay` job option.
 * - `pull`/`ack`/`fail` are no-ops here because BullMQ drives its own
 *   worker loop; use the BullMQ Worker class with `email.send` as the
 *   processor and skip our `startWorker`.
 *
 * @module
 */

import type { EmailMessage } from "../types.ts"
import type { EmailQueue, QueueEnqueueOptions, QueueItem } from "./index.ts"

export interface BullmqLike {
  add: (
    name: string,
    data: unknown,
    opts?: { delay?: number; jobId?: string },
  ) => Promise<{ id?: string }>
  getJobCounts?: () => Promise<{ waiting?: number; delayed?: number; active?: number }>
}

export interface BullmqQueueOptions {
  bull: BullmqLike
  name?: string
}

export function bullmqQueue(options: BullmqQueueOptions): EmailQueue {
  const jobName = options.name ?? "email"
  return {
    name: "bullmq",
    async enqueue(msg: EmailMessage, opts: QueueEnqueueOptions = {}) {
      const scheduled = msg.scheduledAt ? new Date(msg.scheduledAt).getTime() : 0
      const visible = Math.max(Date.now() + (opts.delayMs ?? 0), scheduled)
      const delay = Math.max(0, visible - Date.now())
      const job = await options.bull.add(jobName, msg, { delay, jobId: opts.id })
      return {
        id: job.id ?? opts.id ?? `bull_${Date.now().toString(36)}`,
        msg,
        attempts: 0,
        nextAttemptAt: visible,
        createdAt: Date.now(),
      }
    },
    async pull(): Promise<QueueItem[]> {
      // BullMQ drives its own loop via `Worker`. Nothing to pull here.
      return []
    },
    async ack() {},
    async fail() {},
    async size() {
      const counts = await options.bull.getJobCounts?.()
      return (counts?.waiting ?? 0) + (counts?.delayed ?? 0) + (counts?.active ?? 0)
    },
  }
}

export default bullmqQueue
