import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import memoryQueue from "../../src/queue/memory.ts"
import { startWorker } from "../../src/queue/worker.ts"
import mock from "../../src/drivers/mock.ts"
import unstorageQueue from "../../src/queue/unstorage.ts"
import type { UnstorageLike } from "../../src/queue/unstorage.ts"

describe("memoryQueue + worker", () => {
  it("enqueue → worker tick → ack", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    const queue = memoryQueue()
    const worker = startWorker(email, queue, { concurrency: 2 })

    await queue.enqueue({ from: "a@b.com", to: "c@d.com", subject: "1", text: "x" })
    await queue.enqueue({ from: "a@b.com", to: "c@d.com", subject: "2", text: "x" })
    await worker.tick()
    expect(driver.getInstance?.()).toHaveLength(2)
    expect(await queue.size()).toBe(0)
  })

  it("retries transient errors with backoff", async () => {
    let attempts = 0
    const email = createEmail({
      driver: {
        name: "flaky",
        send() {
          attempts++
          if (attempts < 3) return { data: null, error: new Error("transient") as never }
          return {
            data: { id: `ok_${attempts}`, driver: "flaky", at: new Date() },
            error: null,
          }
        },
      },
    })
    let clock = 1000
    const queue = memoryQueue({ now: () => clock })
    const worker = startWorker(email, queue, {
      concurrency: 1,
      maxAttempts: 5,
      backoff: () => 0,
      now: () => clock,
    })
    await queue.enqueue({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    await worker.tick()
    // first attempt failed, item rescheduled
    expect(await queue.size()).toBe(1)
    clock += 1
    await worker.tick()
    // second attempt failed, still in queue
    expect(await queue.size()).toBe(1)
    clock += 1
    await worker.tick()
    // third attempt succeeded, acked
    expect(await queue.size()).toBe(0)
    expect(attempts).toBe(3)
  })

  it("drops items after maxAttempts", async () => {
    const email = createEmail({
      driver: {
        name: "dead",
        send: () => ({ data: null, error: new Error("always fails") as never }),
      },
    })
    let clock = 0
    const queue = memoryQueue({ now: () => clock })
    const worker = startWorker(email, queue, {
      concurrency: 1,
      maxAttempts: 2,
      backoff: () => 0,
      now: () => clock,
    })
    await queue.enqueue({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    await worker.tick()
    clock++
    await worker.tick()
    expect(await queue.size()).toBe(0)
  })

  it("respects delayMs", async () => {
    const email = createEmail({ driver: mock() })
    let clock = 1000
    const queue = memoryQueue({ now: () => clock })
    const worker = startWorker(email, queue, { concurrency: 1, now: () => clock })
    await queue.enqueue(
      { from: "a@b.com", to: "c@d.com", subject: "x", text: "x" },
      { delayMs: 5000 },
    )
    await worker.tick()
    expect(await queue.size()).toBe(1) // not yet due
    clock += 6000
    await worker.tick()
    expect(await queue.size()).toBe(0)
  })
})

describe("unstorageQueue", () => {
  it("persists items into an unstorage-like store", async () => {
    const store = new Map<string, unknown>()
    const storage: UnstorageLike = {
      async getItem(key) {
        return (store.get(key) ?? null) as never
      },
      async setItem(key, value) {
        store.set(key, value)
      },
      async removeItem(key) {
        store.delete(key)
      },
      async getKeys(base) {
        return [...store.keys()].filter((k) => (base ? k.startsWith(base) : true))
      },
    }
    const queue = unstorageQueue({ storage })
    const item = await queue.enqueue({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    expect(await queue.size()).toBe(1)
    expect(store.has(`unemail:queue:${item.id}`)).toBe(true)
    await queue.ack(item.id)
    expect(await queue.size()).toBe(0)
  })
})
