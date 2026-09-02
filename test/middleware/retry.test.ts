import { describe, expect, it, vi } from "vitest"
import type { EmailDriver } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { createError } from "../../src/core/error.ts"
import { err, ok } from "../../src/core/result.ts"
import { withRetry } from "../../src/middleware/retry.ts"

const msg = { to: "ada@example.com", subject: "hi", text: "hello" } as const
const defaults = { from: "hi@acme.com" }
const noSleep = { sleep: async () => {}, random: () => 0.5 }

/** A driver whose per-call outcome the test dictates. */
function scripted(script: (msgs: readonly { subject?: string }[], call: number) => boolean[]) {
  let call = 0
  const calls: string[][] = []
  const driver: EmailDriver = {
    name: "scripted",
    async sendBatch(msgs) {
      const outcomes = script(msgs, call++)
      calls.push(msgs.map((m) => m.subject ?? ""))
      return msgs.map((m, index) =>
        outcomes[index]
          ? ok({ id: `id_${m.subject}`, driver: "scripted", at: new Date() })
          : err(createError("scripted", "NETWORK", `failed ${m.subject}`)),
      )
    },
    async send(m, ctx) {
      return (await driver.sendBatch!([m], ctx))[0]!
    },
  }
  return { driver, calls }
}

describe("withRetry", () => {
  it("retries only the failures, not the whole batch", async () => {
    const { driver, calls } = scripted((msgs, call) =>
      call === 0 ? msgs.map((m) => m.subject !== "b") : msgs.map(() => true),
    )
    const email = createEmail({ driver, defaults, use: [withRetry(noSleep)] })
    const batch = await email.sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b" },
      { ...msg, subject: "c" },
    ])

    expect(batch.ok).toBe(true)
    expect(calls).toEqual([["a", "b", "c"], ["b"]])
  })

  it("keeps results in the caller's order after a retry", async () => {
    const { driver } = scripted((msgs, call) =>
      call === 0 ? msgs.map((m) => m.subject !== "b") : msgs.map(() => true),
    )
    const batch = await createEmail({ driver, defaults, use: [withRetry(noSleep)] }).sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b" },
      { ...msg, subject: "c" },
    ])
    expect(batch.results.map((r) => r.data?.id)).toEqual(["id_a", "id_b", "id_c"])
  })

  it("gives up after the configured number of retries", async () => {
    const { driver, calls } = scripted((msgs) => msgs.map(() => false))
    const { error } = await createEmail({
      driver,
      defaults,
      use: [withRetry({ retries: 2, ...noSleep })],
    }).send(msg)
    expect(error?.code).toBe("NETWORK")
    expect(calls).toHaveLength(3)
  })

  it("does not retry a failure the driver marked non-retryable", async () => {
    const driver: EmailDriver = {
      name: "hard",
      send: () => err(createError("hard", "AUTH", "bad key")),
    }
    const send = vi.spyOn(driver, "send")
    const { error } = await createEmail({ driver, defaults, use: [withRetry(noSleep)] }).send(msg)
    expect(error?.code).toBe("AUTH")
    expect(send).toHaveBeenCalledOnce()
  })

  it("honors a custom shouldRetry", async () => {
    const { driver, calls } = scripted((msgs, call) => msgs.map(() => call > 0))
    await createEmail({
      driver,
      defaults,
      use: [withRetry({ ...noSleep, shouldRetry: (error) => error.code === "NETWORK" })],
    }).send(msg)
    expect(calls).toHaveLength(2)
  })

  it("raises the attempt number on each retry", async () => {
    const attempts: number[] = []
    const driver: EmailDriver = {
      name: "counting",
      send(_msg, ctx) {
        attempts.push(ctx.attempt)
        return err(createError("counting", "NETWORK", "again"))
      },
    }
    await createEmail({ driver, defaults, use: [withRetry({ retries: 2, ...noSleep })] }).send(msg)
    expect(attempts).toEqual([1, 2, 3])
  })

  describe("backoff", () => {
    const delaysFor = async (options: Parameters<typeof withRetry>[0]) => {
      const delays: number[] = []
      const driver: EmailDriver = {
        name: "always-fails",
        send: () => err(createError("always-fails", "NETWORK", "no")),
      }
      await createEmail({
        driver,
        defaults,
        use: [
          withRetry({
            retries: 3,
            initialDelay: 100,
            random: () => 0.5,
            sleep: async (ms) => {
              delays.push(ms)
            },
            ...options,
          }),
        ],
      }).send(msg)
      return delays
    }

    it("grows exponentially", async () => {
      expect(await delaysFor({ backoff: "exponential" })).toEqual([100, 200, 400])
    })

    it("stays flat when constant", async () => {
      expect(await delaysFor({ backoff: "constant" })).toEqual([100, 100, 100])
    })

    it("respects maxDelay", async () => {
      expect(await delaysFor({ backoff: "exponential", maxDelay: 150 })).toEqual([100, 150, 150])
    })

    it("jitters around the exponential value by default", async () => {
      expect(await delaysFor({})).toEqual([100, 200, 400])
    })

    it("prefers the provider's Retry-After over the computed backoff", async () => {
      const delays: number[] = []
      const driver: EmailDriver = {
        name: "throttled",
        send: () =>
          err(
            createError("throttled", "RATE_LIMIT", "slow down", {
              status: 429,
              cause: { headers: new Headers({ "retry-after": "7" }) },
            }),
          ),
      }
      await createEmail({
        driver,
        defaults,
        use: [
          withRetry({
            retries: 1,
            initialDelay: 100,
            sleep: async (ms) => {
              delays.push(ms)
            },
          }),
        ],
      }).send(msg)
      expect(delays).toEqual([7000])
    })
  })

  it("stops when the instance signal aborts", async () => {
    const controller = new AbortController()
    const driver: EmailDriver = {
      name: "aborting",
      send() {
        controller.abort()
        return err(createError("aborting", "NETWORK", "no"))
      },
    }
    const send = vi.spyOn(driver, "send")
    await createEmail({
      driver,
      defaults,
      signal: controller.signal,
      use: [withRetry(noSleep)],
    }).send(msg)
    expect(send).toHaveBeenCalledOnce()
  })
})
