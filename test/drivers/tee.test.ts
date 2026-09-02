import { describe, expect, it, vi } from "vitest"
import type { EmailDriver, EmailResult, Result } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { createError } from "../../src/core/error.ts"
import { err, ok } from "../../src/core/result.ts"
import mock from "../../src/drivers/mock.ts"
import { tee, type TeeFailure } from "../../src/drivers/tee.ts"

const msg = { to: "ada@example.com", subject: "hi", text: "hello" } as const
const defaults = { from: "hi@acme.com" }

/** A mock with a distinct name, so the legs can be told apart. */
function named(name: string, options: Parameters<typeof mock>[0] = {}) {
  return { ...mock(options), name }
}

const failures = (meta: Readonly<Record<string, unknown>> | undefined) =>
  (meta?.tee ?? []) as TeeFailure[]

describe("tee", () => {
  it("returns the primary's result, not a secondary's", async () => {
    const accepting = (name: string): EmailDriver => ({
      name,
      send: () => ok({ id: name, driver: name, at: new Date() }),
    })
    const { data, error } = await createEmail({
      driver: tee([accepting("primary"), accepting("shadow")]),
      defaults,
    }).send(msg)

    expect(error).toBeNull()
    expect(data).toMatchObject({ id: "primary", driver: "primary" })
  })

  it("delivers to every leg", async () => {
    const legs = [named("a"), named("b"), named("c")]
    await createEmail({ driver: tee(legs), defaults }).send(msg)
    for (const leg of legs) expect(leg.getInstance().messages).toHaveLength(1)
  })

  it("hands every leg the same message object", async () => {
    const a = named("a")
    const b = named("b")
    await createEmail({ driver: tee([a, b]), defaults }).send(msg)
    expect(a.getInstance().messages[0]).toBe(b.getInstance().messages[0])
  })

  it("does not fail the send when a secondary fails", async () => {
    const primary = named("primary")
    const shadow = named("shadow", { fail: true })
    const { data, error } = await createEmail({ driver: tee([primary, shadow]), defaults }).send(
      msg,
    )

    expect(error).toBeNull()
    expect(data?.id).toBeTruthy()
    expect(primary.getInstance().messages).toHaveLength(1)
  })

  it("surfaces the secondary's failure on the result and to the callback", async () => {
    const onSecondaryError = vi.fn()
    const driver = tee([named("primary"), named("shadow", { fail: { message: "shadow down" } })], {
      onSecondaryError,
    })
    const { data } = await createEmail({ driver, defaults }).send(msg)

    const recorded = failures(data?.meta)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ driver: "shadow", index: 0 })
    expect(recorded[0]?.error.message).toContain("shadow down")
    expect(onSecondaryError).toHaveBeenCalledWith(
      expect.objectContaining({ driver: "shadow", index: 0 }),
    )
  })

  it("surfaces it on the error too, when the primary failed as well", async () => {
    const driver = tee([named("primary", { fail: true }), named("shadow", { fail: true })])
    const { error } = await createEmail({ driver, defaults }).send(msg)

    expect(error?.driver).toBe("mock")
    expect(failures(error?.meta).map((f) => f.driver)).toEqual(["shadow"])
  })

  it("fails the send when the primary fails, even though a secondary took it", async () => {
    const shadow = named("shadow")
    const { error } = await createEmail({
      driver: tee([named("primary", { fail: { code: "AUTH" } }), shadow]),
      defaults,
    }).send(msg)

    expect(error?.code).toBe("AUTH")
    expect(shadow.getInstance().messages).toHaveLength(1)
  })

  it("records a secondary that throws instead of returning a result", async () => {
    const exploding: EmailDriver = {
      name: "exploding",
      send() {
        throw new Error("boom")
      },
    }
    const { data } = await createEmail({
      driver: tee([named("primary"), exploding]),
      defaults,
    }).send(msg)

    expect(data?.id).toBeTruthy()
    expect(failures(data?.meta)[0]?.error.message).toContain("boom")
  })

  it("keeps a batch positional and names the failing index", async () => {
    const primary = named("primary", { failWhen: (m) => m.subject === "b" })
    const shadow = named("shadow", { failWhen: (m) => m.subject === "c" })
    const batch = await createEmail({ driver: tee([primary, shadow]), defaults }).sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b" },
      { ...msg, subject: "c" },
    ])

    expect(batch.results).toHaveLength(3)
    expect(batch.failed.map((f) => f.index)).toEqual([1])
    expect(primary.getInstance().messages.map((m) => m.subject)).toEqual(["a", "c"])
    expect(shadow.getInstance().messages.map((m) => m.subject)).toEqual(["a", "b"])
    // The shadow's failure is reported against the message it belongs to,
    // not the primary's failing slot.
    expect(failures(batch.results[0]?.data?.meta)).toMatchObject([{ driver: "shadow", index: 2 }])
  })

  it("runs the legs concurrently rather than one after the other", async () => {
    let entered = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gated = (name: string): EmailDriver => ({
      name,
      async send(): Promise<Result<EmailResult>> {
        entered++
        await gate
        return ok({ id: name, driver: name, at: new Date() })
      },
    })

    const pending = createEmail({ driver: tee([gated("a"), gated("b")]), defaults }).send(msg)
    await vi.waitFor(() => expect(entered).toBe(2))
    release()
    expect((await pending).data?.id).toBe("a")
  })

  it("initializes each leg once, however many sends", async () => {
    const a = { ...mock(), name: "a", initialize: vi.fn() }
    const b = { ...mock(), name: "b", initialize: vi.fn() }
    const email = createEmail({ driver: tee([a, b]), defaults })
    for (let i = 0; i < 5; i++) await email.send(msg)

    expect(a.initialize).toHaveBeenCalledOnce()
    expect(b.initialize).toHaveBeenCalledOnce()
  })

  it("disposes every leg", async () => {
    const a = { ...mock(), name: "a", dispose: vi.fn() }
    const b = { ...mock(), name: "b", dispose: vi.fn() }
    await createEmail({ driver: tee([a, b]), defaults }).dispose()

    expect(a.dispose).toHaveBeenCalledOnce()
    expect(b.dispose).toHaveBeenCalledOnce()
  })

  it("is available while the primary is, whatever the mirrors say", async () => {
    const down: EmailDriver = {
      name: "down",
      isAvailable: () => false,
      send: () => err(createError("down", "NETWORK", "down")),
    }
    expect(await tee([named("primary"), down]).isAvailable?.()).toBe(true)
    expect(await tee([down, named("primary")]).isAvailable?.()).toBe(false)
  })

  it("advertises the primary's features", () => {
    const primary = named("primary")
    expect(tee([primary, named("shadow")]).features).toBe(primary.features)
  })

  it("exposes its legs and refuses an empty list", () => {
    const legs = [named("a")]
    expect(tee(legs).getInstance?.()).toBe(legs)
    expect(() => tee([])).toThrow(/no drivers/)
  })

  it("reports under its own name when given one", () => {
    expect(tee([named("primary")], { name: "shadowed" }).name).toBe("shadowed")
  })
})
