import type { EmailMessage, MaybePromise } from "../types.ts"

/** A persisted queue record. Producers enqueue; workers pull + process. */
export interface QueueItem {
  id: string
  msg: EmailMessage
  attempts: number
  nextAttemptAt: number
  createdAt: number
  lastError?: string
}

export interface QueueEnqueueOptions {
  /** Delay (ms) before the item becomes eligible. Default: 0. */
  delayMs?: number
  /** Force a specific id (default: random). */
  id?: string
}

/** Minimal contract a queue driver needs to satisfy. A queue is pluggable
 *  so users can swap the in-memory default for an unstorage-backed queue
 *  (Redis, Upstash, FS) or a SaaS worker (QStash, SQS) without rewriting
 *  their producers. */
export interface EmailQueue {
  readonly name: string
  enqueue: (msg: EmailMessage, options?: QueueEnqueueOptions) => MaybePromise<QueueItem>
  /** Pull up to \`limit\` items whose \`nextAttemptAt\` has passed. Called
   *  by the built-in worker loop; advanced drivers (SQS long-polling,
   *  QStash push) can implement their own transport instead. */
  pull: (limit: number, now: number) => MaybePromise<QueueItem[]>
  /** Mark an item done (removes it from the queue). */
  ack: (id: string) => MaybePromise<void>
  /** Schedule an item for another attempt. The driver decides whether to
   *  park, retry, or move to dead-letter based on \`attempts\`. */
  fail: (id: string, error: Error, nextAttemptAt: number) => MaybePromise<void>
  /** Current queue size — useful in tests and metrics. */
  size: () => MaybePromise<number>
}

/** Options for the built-in worker loop. */
export interface WorkerOptions {
  concurrency?: number
  pollIntervalMs?: number
  maxAttempts?: number
  backoff?: (attempt: number) => number
  onError?: (item: QueueItem, error: Error) => void
  /** Injected for tests. */
  now?: () => number
}
