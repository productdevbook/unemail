# Queue

Background sending is opt-in. Pick a queue driver, start a worker, and
call `queue.enqueue(msg)` from your app instead of `email.send(msg)`.

## In-memory (single-process)

```ts
import { createEmail } from "unemail"
import memoryQueue from "unemail/queue/memory"
import { startWorker } from "unemail/queue/worker"
import resend from "unemail/driver/resend"

const email = createEmail({ driver: resend({ apiKey: process.env.RESEND_KEY! }) })
const queue = memoryQueue()
const worker = startWorker(email, queue, {
  concurrency: 5,
  maxAttempts: 5,
  backoff: (attempt) => 500 * 2 ** attempt,
})
worker.start()

await queue.enqueue({ from, to, subject, text })
```

## Durable with unstorage

```ts
import { createStorage } from "unstorage"
import redisDriver from "unstorage/drivers/redis"
import unstorageQueue from "unemail/queue/unstorage"

const storage = createStorage({ driver: redisDriver({ url: process.env.REDIS_URL! }) })
const queue = unstorageQueue({ storage, prefix: "unemail:queue:" })
```

Any unstorage driver works — Upstash, Cloudflare KV, filesystem, MongoDB,
Vercel KV. Items survive restarts; restarted workers pick them up.

## Anatomy of an item

```ts
interface QueueItem {
  id: string
  msg: EmailMessage
  attempts: number
  nextAttemptAt: number // unix ms
  createdAt: number
  lastError?: string
}
```

The worker `pull`s items whose `nextAttemptAt` has passed, calls
`email.send`, and either `ack`s on success or `fail`s on error (updating
`nextAttemptAt` based on the `backoff` function). After `maxAttempts`
attempts the item is dropped.

## Custom drivers

Implement `EmailQueue` for any backend (SQS, QStash, Inngest, BullMQ).
The four methods you need are `enqueue`, `pull`, `ack`, `fail` (+ `size`
for metrics). The worker loop is intentionally portable — swap the loop
out entirely if your driver pushes (SQS long-polling, QStash webhooks).
