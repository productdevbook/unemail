import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { createError } from "../../src/errors.ts"
import fallback from "../../src/driver/fallback.ts"
import roundRobin from "../../src/driver/round-robin.ts"
import mock from "../../src/driver/mock.ts"
import type { EmailDriver } from "../../src/types.ts"

function failing(name: string): EmailDriver {
  return {
    name,
    send: () => ({ data: null, error: createError(name, "NETWORK", "down") }),
  }
}

function notRetryable(name: string): EmailDriver {
  return {
    name,
    send: () => ({ data: null, error: createError(name, "AUTH", "bad key", { retryable: false }) }),
  }
}

describe("fallback driver", () => {
  it("advances to the next driver on retryable failure", async () => {
    const ok = mock()
    const email = createEmail({
      driver: fallback({ drivers: [failing("a"), failing("b"), ok] }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error).toBeNull()
    expect(data?.driver).toBe("mock")
    expect(ok.getInstance?.()).toHaveLength(1)
  })

  it("short-circuits on non-retryable errors", async () => {
    const later = mock()
    const email = createEmail({
      driver: fallback({ drivers: [notRetryable("a"), later] }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("AUTH")
    expect(later.getInstance?.()).toHaveLength(0)
  })

  it("returns the last error when all drivers fail", async () => {
    const email = createEmail({
      driver: fallback({ drivers: [failing("a"), failing("b")] }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(data).toBeNull()
    expect(error?.driver).toBe("b")
  })
})

describe("roundRobin driver", () => {
  it("cycles across the provided drivers", async () => {
    const a = mock()
    const b = mock()
    const c = mock()
    const email = createEmail({ driver: roundRobin({ drivers: [a, b, c] }) })
    for (let i = 0; i < 6; i++) {
      await email.send({ from: "a@b.com", to: "c@d.com", subject: `${i}`, text: "x" })
    }
    expect(a.getInstance?.()).toHaveLength(2)
    expect(b.getInstance?.()).toHaveLength(2)
    expect(c.getInstance?.()).toHaveLength(2)
  })

  it("respects weights", async () => {
    const a = mock()
    const b = mock()
    const email = createEmail({ driver: roundRobin({ drivers: [a, b], weights: [3, 1] }) })
    for (let i = 0; i < 8; i++) {
      await email.send({ from: "a@b.com", to: "c@d.com", subject: `${i}`, text: "x" })
    }
    expect(a.getInstance?.()).toHaveLength(6)
    expect(b.getInstance?.()).toHaveLength(2)
  })
})
