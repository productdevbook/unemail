import type { Email } from "../email.ts"
import type { EmailQueue, QueueItem, WorkerOptions } from "./index.ts"

/** A running worker. Call \`stop()\` to halt the loop; any in-flight sends
 *  finish first. \`waitForIdle()\` resolves when the queue is empty and no
 *  send is in flight. */
export interface QueueWorker {
  start: () => void
  stop: () => Promise<void>
  waitForIdle: () => Promise<void>
  /** Run a single tick manually — useful in tests. */
  tick: () => Promise<void>
}

/** Build a worker that drains \`queue\` by sending each item through
 *  \`email\`. Keep the loop simple: pull → send → ack/fail. Advanced
 *  drivers can skip this worker and drive \`email.send\` directly from
 *  their own transport. */
export function startWorker(
  email: Email,
  queue: EmailQueue,
  options: WorkerOptions = {},
): QueueWorker {
  const concurrency = options.concurrency ?? 1
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const maxAttempts = options.maxAttempts ?? 5
  const backoff = options.backoff ?? ((attempt) => Math.min(30_000, 500 * 2 ** attempt))
  const now = options.now ?? Date.now

  let running = false
  let inFlight = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const idleWaiters: Array<() => void> = []

  async function processItem(item: QueueItem): Promise<void> {
    inFlight++
    try {
      const result = await email.send(item.msg)
      if (result.error) throw result.error
      await queue.ack(item.id)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      options.onError?.(item, error)
      if (item.attempts + 1 >= maxAttempts) {
        // Exhausted — ack to remove from the queue. Dead-letter handling
        // is driver-specific; memory queue just drops.
        await queue.ack(item.id)
      } else {
        await queue.fail(item.id, error, now() + backoff(item.attempts))
      }
    } finally {
      inFlight--
      if (inFlight === 0) drainIdleWaiters()
    }
  }

  async function tickInternal(): Promise<void> {
    const slots = Math.max(0, concurrency - inFlight)
    if (slots === 0) return
    const items = await queue.pull(slots, now())
    await Promise.all(items.map((i) => processItem(i)))
  }

  function schedule(): void {
    if (!running) return
    pollTimer = setTimeout(async () => {
      await tickInternal()
      schedule()
    }, pollIntervalMs)
  }

  function drainIdleWaiters(): void {
    while (idleWaiters.length > 0) idleWaiters.shift()!()
  }

  return {
    start() {
      if (running) return
      running = true
      schedule()
    },
    async stop() {
      running = false
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
      if (inFlight > 0) await new Promise<void>((r) => idleWaiters.push(r))
    },
    async waitForIdle() {
      if (inFlight === 0 && (await queue.size()) === 0) return
      await new Promise<void>((r) => idleWaiters.push(r))
    },
    tick: tickInternal,
  }
}
