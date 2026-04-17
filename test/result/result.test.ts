import { describe, expect, it } from "vitest"
import { isErr, isOk, mapErr, mapOk, tryAsync, unwrap, unwrapOr } from "../../src/result/index.ts"
import { createError } from "../../src/errors.ts"
import type { Result } from "../../src/types.ts"

function ok<T>(data: T): Result<T> {
  return { data, error: null }
}

function err<T>(message = "boom"): Result<T> {
  return { data: null, error: createError("x", "PROVIDER", message) }
}

describe("Result helpers", () => {
  it("isOk / isErr narrow correctly", () => {
    const r: Result<number> = ok(42)
    expect(isOk(r)).toBe(true)
    expect(isErr(r)).toBe(false)
  })

  it("unwrap throws on Err", () => {
    expect(() => unwrap(err<number>())).toThrow(/boom/)
  })

  it("unwrapOr returns fallback on Err", () => {
    expect(unwrapOr(err<number>(), 7)).toBe(7)
    expect(unwrapOr(ok(3), 7)).toBe(3)
  })

  it("mapOk transforms data", () => {
    const r = mapOk(ok(4), (n) => n * 2)
    expect(r.data).toBe(8)
  })

  it("mapOk passes Err through", () => {
    const r = mapOk(err<number>(), (n) => n * 2)
    expect(r.error?.message).toContain("boom")
  })

  it("mapErr transforms the error", () => {
    const original = err<number>("original")
    const mapped = mapErr(original, (e) =>
      createError(e.driver, "TIMEOUT", `wrapped: ${e.message}`),
    )
    expect(mapped.error?.code).toBe("TIMEOUT")
    expect(mapped.error?.message).toContain("wrapped")
  })

  it("tryAsync captures thrown errors via the wrapper", async () => {
    const r = await tryAsync(
      async () => {
        throw new Error("oops")
      },
      (e) => createError("x", "NETWORK", (e as Error).message),
    )
    expect(r.error?.code).toBe("NETWORK")
    expect(r.error?.message).toContain("oops")
  })

  it("tryAsync returns data on resolution", async () => {
    const r = await tryAsync(
      async () => 99,
      () => createError("x", "PROVIDER", "unused"),
    )
    expect(r.data).toBe(99)
  })
})
