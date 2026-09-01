import { describe, expect, it, vi } from "vitest"
import type { EmailDriver } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { createError } from "../../src/core/error.ts"
import { err, ok } from "../../src/core/result.ts"
import { wrap } from "../../src/core/define.ts"
import mock, { createInbox } from "../../src/drivers/mock.ts"
import { fallback } from "../../src/drivers/fallback.ts"
import { roundRobin } from "../../src/drivers/round-robin.ts"
import { withRetry } from "../../src/middleware/retry.ts"

const msg = { to: "ada@example.com", subject: "hi", text: "hello" } as const
const defaults = { from: "hi@acme.com" }

/** A driver with a distinct name, so composites can be told apart. */
function named(name: string, options: Parameters<typeof mock>[0] = {}) {
  return { ...mock(options), name }
}

describe("mock", () => {
  it("records normalized messages and answers queries", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults })
    await email.send({ ...msg, subject: "one" })
    await email.send({ ...msg, to: "bob@example.com", subject: "two" })

    const inbox = driver.getInstance()
    expect(inbox.messages).toHaveLength(2)
    expect(inbox.last()?.subject).toBe("two")
    expect(inbox.find("ADA@EXAMPLE.COM")).toHaveLength(1)

    inbox.clear()
    expect(inbox.messages).toHaveLength(0)
  })

  it("shares an inbox between instances when one is supplied", async () => {
    const inbox = createInbox()
    const email = createEmail({ driver: mock({ inbox }), defaults })
    email.mount("other", mock({ inbox }))
    await email.send(msg)
    await email.send({ ...msg, stream: "other" })
    expect(inbox.messages).toHaveLength(2)
  })

  it("fails with the requested code", async () => {
    const { error } = await createEmail({
      driver: mock({ fail: { code: "RATE_LIMIT", message: "slow down" } }),
      defaults,
    }).send(msg)
    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
  })

  it("fails only the messages the predicate selects", async () => {
    const batch = await createEmail({
      driver: mock({ failWhen: (m) => m.subject === "bad" }),
      defaults,
    }).sendBatch([
      { ...msg, subject: "good" },
      { ...msg, subject: "bad" },
    ])
    expect(batch.sent).toHaveLength(1)
    expect(batch.failed[0]?.index).toBe(1)
  })
})

describe("fallback", () => {
  it("moves to the next driver when the first fails", async () => {
    const primary = named("primary", { fail: true })
    const secondary = named("secondary")
    const { data, error } = await createEmail({
      driver: fallback([primary, secondary]),
      defaults,
    }).send(msg)

    expect(error).toBeNull()
    expect(data?.driver).toBe("mock")
    expect(secondary.getInstance().messages).toHaveLength(1)
  })

  it("re-sends only the failures, so nobody gets the mail twice", async () => {
    const primary = named("primary", { failWhen: (m) => m.subject === "b" })
    const secondary = named("secondary")
    const batch = await createEmail({ driver: fallback([primary, secondary]), defaults }).sendBatch(
      [
        { ...msg, subject: "a" },
        { ...msg, subject: "b" },
        { ...msg, subject: "c" },
      ],
    )

    expect(batch.ok).toBe(true)
    expect(primary.getInstance().messages.map((m) => m.subject)).toEqual(["a", "c"])
    expect(secondary.getInstance().messages.map((m) => m.subject)).toEqual(["b"])
  })

  it("does not fail over a caller error — the next provider would reject it too", async () => {
    const secondary = named("secondary")
    const invalid: EmailDriver = {
      name: "picky",
      send: () => err(createError("picky", "INVALID_OPTIONS", "bad recipient")),
    }
    const { error } = await createEmail({ driver: fallback([invalid, secondary]), defaults }).send(
      msg,
    )
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(secondary.getInstance().messages).toHaveLength(0)
  })

  it("reports the last leg's error when every leg fails", async () => {
    const { error } = await createEmail({
      driver: fallback([named("a", { fail: true }), named("b", { fail: { message: "last" } })]),
      defaults,
    }).send(msg)
    expect(error?.message).toContain("last")
  })

  it("announces each failover", async () => {
    const onFailover = vi.fn()
    await createEmail({
      driver: fallback([named("a", { fail: true }), named("b")], { onFailover }),
      defaults,
    }).send(msg)
    expect(onFailover).toHaveBeenCalledWith("a", "b", expect.any(Error))
  })

  it("retries inside a leg before moving on, when wrapped", async () => {
    let attempts = 0
    const flaky: EmailDriver = {
      name: "flaky",
      send() {
        attempts++
        return attempts < 3
          ? err(createError("flaky", "NETWORK", "down"))
          : ok({ id: "recovered", driver: "flaky", at: new Date() })
      },
    }
    const standby = named("standby")
    const driver = fallback([
      wrap(flaky, withRetry({ retries: 3, sleep: async () => {} })),
      standby,
    ])
    const { data } = await createEmail({ driver, defaults }).send(msg)

    expect(data?.id).toBe("recovered")
    expect(standby.getInstance().messages).toHaveLength(0)
  })

  it("is available while any leg is", async () => {
    const driver = fallback([named("a", { fail: true }), named("b")])
    expect(await createEmail({ driver, defaults }).isAvailable()).toBe(true)
  })

  it("refuses an empty list", () => {
    expect(() => fallback([])).toThrow(/no drivers/)
  })
})

describe("roundRobin", () => {
  it("alternates between drivers", async () => {
    const a = named("a")
    const b = named("b")
    const email = createEmail({ driver: roundRobin([a, b]), defaults })
    for (let i = 0; i < 4; i++) await email.send(msg)
    expect(a.getInstance().messages).toHaveLength(2)
    expect(b.getInstance().messages).toHaveLength(2)
  })

  it("honors weights", async () => {
    const a = named("a")
    const b = named("b")
    const email = createEmail({ driver: roundRobin([a, b], { weights: [3, 1] }), defaults })
    for (let i = 0; i < 8; i++) await email.send(msg)
    expect(a.getInstance().messages).toHaveLength(6)
    expect(b.getInstance().messages).toHaveLength(2)
  })

  it("partitions a batch and keeps results positional", async () => {
    const a = named("a")
    const b = named("b")
    const batch = await createEmail({ driver: roundRobin([a, b]), defaults }).sendBatch([
      { ...msg, subject: "0" },
      { ...msg, subject: "1" },
      { ...msg, subject: "2" },
      { ...msg, subject: "3" },
    ])
    expect(batch.sent).toHaveLength(4)
    expect(a.getInstance().messages.map((m) => m.subject)).toEqual(["0", "2"])
    expect(b.getInstance().messages.map((m) => m.subject)).toEqual(["1", "3"])
  })

  it("does not fail over on its own", async () => {
    const batch = await createEmail({
      driver: roundRobin([named("a", { fail: true }), named("b")]),
      defaults,
    }).sendBatch([msg, msg])
    expect(batch.failed).toHaveLength(1)
  })

  it("refuses an empty list and an all-zero weighting", () => {
    expect(() => roundRobin([])).toThrow(/no drivers/)
    expect(() => roundRobin([named("a")], { weights: [0] })).toThrow(/every weight was zero/)
  })
})
