import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { createError } from "../../src/errors.ts"
import { withRetry } from "../../src/middleware/retry.ts"
import type { EmailDriver, EmailResult, Result } from "../../src/types.ts"

/** Builds a driver that fails N times, then succeeds. Records each attempt. */
function flakyDriver(
  failures: number,
  errorFactory = () => createError("flaky", "NETWORK", "boom"),
): EmailDriver & { attempts: number } {
  let attempts = 0
  return {
    name: "flaky",
    attempts: 0,
    send() {
      attempts++
      ;(this as { attempts: number }).attempts = attempts
      if (attempts <= failures) return { data: null, error: errorFactory() }
      const result: EmailResult = { id: `ok_${attempts}`, driver: "flaky", at: new Date() }
      return { data: result, error: null }
    },
  } as EmailDriver & { attempts: number }
}

describe("withRetry", () => {
  it("retries until the driver succeeds", async () => {
    const driver = flakyDriver(2)
    const email = createEmail({
      driver: withRetry(driver, { retries: 3, initialDelay: 1, sleep: () => Promise.resolve() }),
    })
    const res = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(res.error).toBeNull()
    expect(driver.attempts).toBe(3)
  })

  it("gives up after exhausting retries", async () => {
    const driver = flakyDriver(10)
    const email = createEmail({
      driver: withRetry(driver, { retries: 2, initialDelay: 1, sleep: () => Promise.resolve() }),
    })
    const res = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(res.data).toBeNull()
    expect(driver.attempts).toBe(3) // 1 initial + 2 retries
  })

  it("does not retry non-retryable errors", async () => {
    const driver = flakyDriver(5, () => createError("flaky", "AUTH", "bad key"))
    const email = createEmail({
      driver: withRetry(driver, { retries: 3, initialDelay: 1, sleep: () => Promise.resolve() }),
    })
    const res = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(res.error?.code).toBe("AUTH")
    expect(driver.attempts).toBe(1)
  })

  it("uses exponential backoff by default", async () => {
    const delays: number[] = []
    const driver = flakyDriver(3)
    const email = createEmail({
      driver: withRetry(driver, {
        retries: 3,
        initialDelay: 10,
        sleep: async (ms: number) => {
          delays.push(ms)
        },
      }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    // attempt 0 → 10, attempt 1 → 20, attempt 2 → 40
    expect(delays).toEqual([10, 20, 40])
  })

  it("honors Retry-After on 429", async () => {
    const delays: number[] = []
    let attempts = 0
    const driver: EmailDriver = {
      name: "rl",
      send(): Result<EmailResult> {
        attempts++
        if (attempts === 1) {
          const cause = { headers: { get: (n: string) => (n === "retry-after" ? "3" : null) } }
          return {
            data: null,
            error: createError("rl", "RATE_LIMIT", "slow down", {
              status: 429,
              cause,
              retryable: true,
            }),
          }
        }
        return { data: { id: "ok", driver: "rl", at: new Date() }, error: null }
      },
    }
    const email = createEmail({
      driver: withRetry(driver, {
        retries: 2,
        initialDelay: 1,
        sleep: async (ms: number) => {
          delays.push(ms)
        },
      }),
    })
    const res = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(res.error).toBeNull()
    expect(delays).toEqual([3000])
  })
})
