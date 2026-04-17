import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { createError } from "../../src/errors.ts"
import { withCircuitBreaker, type CircuitState } from "../../src/middleware/circuit-breaker.ts"
import type { EmailDriver } from "../../src/types.ts"

function alwaysFailing(): EmailDriver {
  return {
    name: "bad",
    send: () => ({ data: null, error: createError("bad", "NETWORK", "down") }),
  }
}

describe("withCircuitBreaker", () => {
  it("opens after threshold consecutive failures", async () => {
    const states: CircuitState[] = []
    const email = createEmail({
      driver: withCircuitBreaker(alwaysFailing(), {
        threshold: 3,
        cooldownMs: 60_000,
        onStateChange: (s) => states.push(s),
      }),
    })
    for (let i = 0; i < 5; i++) {
      await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    }
    expect(states).toContain("open")
  })

  it("short-circuits while open", async () => {
    let calls = 0
    const driver: EmailDriver = {
      name: "probe",
      send() {
        calls++
        return { data: null, error: createError("probe", "NETWORK", "down") }
      },
    }
    const email = createEmail({
      driver: withCircuitBreaker(driver, { threshold: 2, cooldownMs: 60_000 }),
    })
    for (let i = 0; i < 6; i++) {
      await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    }
    // After 2 failures the breaker opens — subsequent sends short-circuit.
    expect(calls).toBe(2)
  })

  it("half-open allows one probe, closes on success", async () => {
    let clock = 0
    const now = () => clock
    let attempt = 0
    const driver: EmailDriver = {
      name: "probe",
      send() {
        attempt++
        if (attempt <= 2) return { data: null, error: createError("probe", "NETWORK", "down") }
        return { data: { id: "ok", driver: "probe", at: new Date() }, error: null }
      },
    }
    const email = createEmail({
      driver: withCircuitBreaker(driver, { threshold: 2, cooldownMs: 1000, now }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    // breaker now open
    clock = 1500
    const res = await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(res.error).toBeNull()
    expect(attempt).toBe(3)
  })
})
