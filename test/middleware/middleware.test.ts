import { describe, expect, it, vi } from "vitest"
import type { EmailDriver } from "../../src/index.ts"
import type { LogEntry } from "../../src/middleware/index.ts"
import { createEmail } from "../../src/core/email.ts"
import { createError } from "../../src/core/error.ts"
import { err, ok } from "../../src/core/result.ts"
import mock from "../../src/drivers/mock.ts"
import { withCircuitBreaker } from "../../src/middleware/circuit-breaker.ts"
import { withIdempotency, memoryIdempotencyStore } from "../../src/middleware/idempotency.ts"
import { withLogger } from "../../src/middleware/logger.ts"
import { withRateLimit } from "../../src/middleware/rate-limit.ts"

const msg = { to: "ada@example.com", subject: "hi", text: "hello" } as const
const defaults = { from: "hi@acme.com" }

describe("withLogger", () => {
  it("records one entry per pipeline trip", async () => {
    const entries: LogEntry[] = []
    const email = createEmail({
      driver: mock(),
      defaults,
      use: [withLogger({ log: (entry) => entries.push(entry) })],
    })
    await email.sendBatch([msg, msg])

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: "info",
      driver: "mock",
      count: 2,
      sent: 2,
      failed: 0,
    })
  })

  it("reports failures at error level with their codes", async () => {
    const entries: LogEntry[] = []
    const email = createEmail({
      driver: mock({ fail: { code: "AUTH", message: "bad key" } }),
      defaults,
      use: [withLogger({ log: (entry) => entries.push(entry) })],
    })
    await email.send(msg)
    expect(entries[0]?.level).toBe("error")
    expect(entries[0]?.errors?.[0]?.code).toBe("AUTH")
  })

  it("redacts recipients unless asked not to", async () => {
    const redacted: LogEntry[] = []
    const verbose: LogEntry[] = []
    await createEmail({
      driver: mock(),
      defaults,
      use: [withLogger({ log: (entry) => redacted.push(entry) })],
    }).send(msg)
    await createEmail({
      driver: mock(),
      defaults,
      use: [withLogger({ redact: "none", log: (entry) => verbose.push(entry) })],
    }).send(msg)

    expect(redacted[0]?.messages).toBeUndefined()
    expect(verbose[0]?.messages).toEqual([{ to: "ada@example.com", subject: "hi" }])
  })
})

describe("withIdempotency", () => {
  it("returns the first result instead of sending twice", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults, use: [withIdempotency()] })

    const first = await email.send({ ...msg, idempotencyKey: "welcome:1" })
    const second = await email.send({ ...msg, idempotencyKey: "welcome:1" })

    expect(second.data?.id).toBe(first.data?.id)
    expect(driver.getInstance().messages).toHaveLength(1)
  })

  it("leaves messages without a key alone", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults, use: [withIdempotency()] })
    await email.send(msg)
    await email.send(msg)
    expect(driver.getInstance().messages).toHaveLength(2)
  })

  it("does not remember a failure", async () => {
    const driver = mock({ fail: true })
    const store = memoryIdempotencyStore()
    const email = createEmail({ driver, defaults, use: [withIdempotency({ store })] })
    await email.send({ ...msg, idempotencyKey: "k" })
    expect(await store.get("mock::k")).toBeNull()
  })

  it("deduplicates within a single batch call across sends", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults, use: [withIdempotency()] })
    await email.send({ ...msg, subject: "first", idempotencyKey: "k" })
    const batch = await email.sendBatch([
      { ...msg, subject: "cached", idempotencyKey: "k" },
      { ...msg, subject: "fresh" },
    ])
    expect(batch.sent).toHaveLength(2)
    expect(driver.getInstance().messages.map((m) => m.subject)).toEqual(["first", "fresh"])
  })

  it("keys per destination, so the same key on another stream still sends", async () => {
    const store = memoryIdempotencyStore()
    const transactional = mock()
    const broadcast = mock()
    const email = createEmail({
      driver: transactional,
      defaults,
      use: [withIdempotency({ store })],
    })
    email.mount("broadcast", broadcast)

    await email.send({ ...msg, idempotencyKey: "k" })
    await email.send({ ...msg, idempotencyKey: "k", stream: "broadcast" })
    await email.send({ ...msg, idempotencyKey: "k", stream: "broadcast" })

    expect(transactional.getInstance().messages).toHaveLength(1)
    expect(broadcast.getInstance().messages).toHaveLength(1)
  })
})

describe("withCircuitBreaker", () => {
  function failing(): { driver: EmailDriver; calls: () => number } {
    let calls = 0
    return {
      driver: {
        name: "flaky",
        send() {
          calls++
          return err(createError("flaky", "NETWORK", "down"))
        },
      },
      calls: () => calls,
    }
  }

  it("stops calling the driver once the threshold is reached", async () => {
    const { driver, calls } = failing()
    const email = createEmail({
      driver,
      defaults,
      use: [withCircuitBreaker({ threshold: 2, now: () => 0 })],
    })
    for (let i = 0; i < 5; i++) await email.send(msg)
    expect(calls()).toBe(2)
  })

  it("reports an open circuit as a retryable NETWORK error", async () => {
    const { driver } = failing()
    const email = createEmail({
      driver,
      defaults,
      use: [withCircuitBreaker({ threshold: 1, now: () => 0 })],
    })
    await email.send(msg)
    const { error } = await email.send(msg)
    expect(error?.code).toBe("NETWORK")
    expect(error?.message).toMatch(/circuit is open/)
    expect(error?.retryable).toBe(true)
  })

  it("probes once after the reset timeout and closes on success", async () => {
    let time = 0
    let healthy = false
    const states: string[] = []
    const driver: EmailDriver = {
      name: "recovers",
      send: () =>
        healthy
          ? ok({ id: "1", driver: "recovers", at: new Date() })
          : err(createError("recovers", "NETWORK", "down")),
    }
    const email = createEmail({
      driver,
      defaults,
      use: [
        withCircuitBreaker({
          threshold: 1,
          resetTimeoutMs: 100,
          now: () => time,
          onStateChange: (state) => states.push(state),
        }),
      ],
    })

    await email.send(msg)
    expect(states).toEqual(["open"])

    time = 200
    healthy = true
    const { error } = await email.send(msg)
    expect(error).toBeNull()
    expect(states).toEqual(["open", "half-open", "closed"])
  })

  it("reopens immediately when the probe fails", async () => {
    let time = 0
    const { driver } = failing()
    const states: string[] = []
    const email = createEmail({
      driver,
      defaults,
      use: [
        withCircuitBreaker({
          threshold: 3,
          resetTimeoutMs: 100,
          now: () => time,
          onStateChange: (state) => states.push(state),
        }),
      ],
    })
    for (let i = 0; i < 3; i++) await email.send(msg)
    time = 200
    await email.send(msg)
    expect(states).toEqual(["open", "half-open", "open"])
  })

  it("ignores a caller error — a bad message says nothing about the provider", async () => {
    const { driver, calls } = failing()
    const email = createEmail({
      driver,
      defaults,
      use: [withCircuitBreaker({ threshold: 2, now: () => 0 })],
    })
    await email.send({ ...msg, to: "not-an-address" })
    await email.send({ ...msg, to: "also-not" })
    await email.send(msg)
    expect(calls()).toBe(1)
  })
})

describe("withRateLimit", () => {
  it("charges one token per message in a batch", async () => {
    const waits: number[] = []
    let time = 0
    const email = createEmail({
      driver: mock(),
      defaults,
      use: [
        withRateLimit({
          limit: 2,
          intervalMs: 1000,
          now: () => time,
          sleep: async (ms) => {
            waits.push(ms)
            time += ms
          },
        }),
      ],
    })

    await email.sendBatch([msg, msg])
    expect(waits).toEqual([])
    await email.send(msg)
    expect(waits).toEqual([500])
  })

  it("fails fast with RATE_LIMIT when told to reject", async () => {
    const email = createEmail({
      driver: mock(),
      defaults,
      use: [withRateLimit({ limit: 1, onLimit: "reject", now: () => 0 })],
    })
    expect((await email.send(msg)).error).toBeNull()
    const { error } = await email.send(msg)
    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
  })

  it("lets the driver through while there is burst capacity", async () => {
    const driver = mock()
    const email = createEmail({
      driver,
      defaults,
      use: [withRateLimit({ limit: 1, burst: 5, now: () => 0, sleep: vi.fn() })],
    })
    await email.sendBatch([msg, msg, msg])
    expect(driver.getInstance().messages).toHaveLength(3)
  })
})
