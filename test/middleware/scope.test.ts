import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import mock from "../../src/drivers/mock.ts"
import { withCircuitBreaker } from "../../src/middleware/circuit-breaker.ts"
import { withRateLimit } from "../../src/middleware/rate-limit.ts"

const msg = { to: "a@x.com", subject: "s", text: "t" } as const
const defaults = { from: "f@x.com" }

/**
 * Middleware registered with `use()` wraps every mounted driver. State it
 * keeps has to be partitioned by destination, or one provider's trouble
 * becomes every provider's — which is the opposite of what mounting a
 * second provider is for.
 */
describe("state is scoped to the destination", () => {
  describe("circuit breaker", () => {
    it("leaves a healthy mount alone when the primary trips", async () => {
      const healthy = mock()
      const email = createEmail({
        driver: mock({ fail: true }),
        defaults,
        use: [withCircuitBreaker({ threshold: 2, now: () => 0 })],
      })
      email.mount("other", healthy)

      await email.send(msg)
      await email.send(msg)

      const result = await email.send({ ...msg, stream: "other" })
      expect(result.error).toBeNull()
      expect(healthy.getInstance().messages).toHaveLength(1)
    })

    it("still opens for the destination that is actually failing", async () => {
      const email = createEmail({
        driver: mock({ fail: true }),
        defaults,
        use: [withCircuitBreaker({ threshold: 2, now: () => 0 })],
      })
      email.mount("other", mock())

      await email.send(msg)
      await email.send(msg)
      const blocked = await email.send(msg)
      expect(blocked.error?.message).toMatch(/circuit is open/)
    })

    it("separates two streams of the same provider", async () => {
      const states: string[] = []
      const email = createEmail({
        driver: mock({ fail: true }),
        defaults,
        use: [
          withCircuitBreaker({ threshold: 1, now: () => 0, onStateChange: (s) => states.push(s) }),
        ],
      })
      email.mount("broadcast", mock())

      await email.send(msg)
      const broadcast = await email.send({ ...msg, stream: "broadcast" })
      expect(broadcast.error).toBeNull()
      expect(states).toEqual(["open"])
    })
  })

  describe("rate limit", () => {
    it("gives each provider its own bucket", async () => {
      const a = mock()
      const b = mock()
      const email = createEmail({
        driver: a,
        defaults,
        use: [withRateLimit({ limit: 1, onLimit: "reject", now: () => 0 })],
      })
      email.mount("b", b)

      expect((await email.send(msg)).error).toBeNull()
      expect((await email.send({ ...msg, stream: "b" })).error).toBeNull()
      expect(a.getInstance().messages).toHaveLength(1)
      expect(b.getInstance().messages).toHaveLength(1)
    })

    it("still throttles a second send to the same destination", async () => {
      const email = createEmail({
        driver: mock(),
        defaults,
        use: [withRateLimit({ limit: 1, onLimit: "reject", now: () => 0 })],
      })
      expect((await email.send(msg)).error).toBeNull()
      expect((await email.send(msg)).error?.code).toBe("RATE_LIMIT")
    })

    it("gives each stream of one provider its own bucket", async () => {
      const email = createEmail({
        driver: mock(),
        defaults,
        use: [withRateLimit({ limit: 1, onLimit: "reject", now: () => 0 })],
      })
      email.mount("broadcast", mock())
      expect((await email.send(msg)).error).toBeNull()
      expect((await email.send({ ...msg, stream: "broadcast" })).error).toBeNull()
    })
  })
})
