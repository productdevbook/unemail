import { describe, expect, it } from "vitest"
import type { EmailResult, Result } from "../../src/core/types.ts"
import {
  createError,
  createRequiredError,
  createUnsupportedError,
  EmailError,
  toEmailError,
} from "../../src/core/error.ts"
import { err, isOk, ok, toBatchResult, unwrap } from "../../src/core/result.ts"
import { version } from "../../src/index.ts"
import pkg from "../../package.json" with { type: "json" }

const sent = (id: string): EmailResult => ({ id, driver: "mock", at: new Date() })

describe("ok / err / isOk", () => {
  it("wraps a value as a success", () => {
    const result = ok(1)
    expect(result).toEqual({ data: 1, error: null })
    expect(isOk(result)).toBe(true)
  })

  it("wraps an error as a failure", () => {
    const result = err(createError("mock", "AUTH", "no"))
    expect(result.data).toBeNull()
    expect(isOk(result)).toBe(false)
  })

  it("narrows the data type when isOk passes", () => {
    const result: Result<number> = ok(41)
    if (isOk(result)) expect(result.data + 1).toBe(42)
    else expect.unreachable()
  })
})

describe("unwrap", () => {
  it("returns the value on success", () => {
    expect(unwrap(ok("x"))).toBe("x")
  })

  it("throws the EmailError on failure, preserving its code", () => {
    try {
      unwrap(err(createError("mock", "RATE_LIMIT", "slow down")))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(EmailError)
      expect((error as EmailError).code).toBe("RATE_LIMIT")
    }
  })
})

describe("toBatchResult", () => {
  it("splits successes from failures and keeps the index", () => {
    const batch = toBatchResult([
      ok(sent("a")),
      err(createError("mock", "PROVIDER", "no")),
      ok(sent("c")),
    ])
    expect(batch.ok).toBe(false)
    expect(batch.sent.map((r) => r.id)).toEqual(["a", "c"])
    expect(batch.failed.map((f) => f.index)).toEqual([1])
    expect(batch.results).toHaveLength(3)
  })

  it("is ok when nothing failed", () => {
    expect(toBatchResult([ok(sent("a"))]).ok).toBe(true)
  })

  it("is ok for an empty batch", () => {
    expect(toBatchResult([])).toMatchObject({ ok: true, sent: [], failed: [] })
  })
})

describe("error factories", () => {
  it("prefix the message with the library and driver, for grepping", () => {
    expect(createError("resend", "AUTH", "bad key").message).toBe("[unemail] [resend] bad key")
  })

  it("mark the transient codes retryable and the rest not", () => {
    for (const code of ["NETWORK", "RATE_LIMIT", "TIMEOUT"] as const) {
      expect(createError("d", code, "x").retryable).toBe(true)
    }
    for (const code of ["AUTH", "INVALID_OPTIONS", "PROVIDER", "UNSUPPORTED"] as const) {
      expect(createError("d", code, "x").retryable).toBe(false)
    }
  })

  it("let an explicit retryable override the default", () => {
    expect(createError("d", "NETWORK", "x", { retryable: false }).retryable).toBe(false)
  })

  it("name the missing options", () => {
    expect(createRequiredError("ses", ["region", "accessKeyId"]).message).toContain(
      "region, accessKeyId",
    )
    expect(createRequiredError("ses", "region").code).toBe("INVALID_OPTIONS")
  })

  it("name the unsupported operation and its driver", () => {
    const error = createUnsupportedError("smtp", "cancel()")
    expect(error.code).toBe("UNSUPPORTED")
    expect(error.message).toContain('cancel() is not supported by "smtp"')
  })
})

describe("toEmailError", () => {
  it("passes an EmailError through untouched, so retryable survives", () => {
    const original = createError("d", "RATE_LIMIT", "slow", { status: 429 })
    const wrapped = toEmailError("other", original)
    expect(wrapped).toBe(original)
    expect(wrapped.retryable).toBe(true)
    expect(wrapped.status).toBe(429)
  })

  it("classifies an abort as CANCELLED rather than PROVIDER", () => {
    const abort = new Error("aborted")
    abort.name = "AbortError"
    expect(toEmailError("d", abort).code).toBe("CANCELLED")
  })

  it("classifies a deadline as a retryable TIMEOUT, not a cancellation", () => {
    // `AbortSignal.timeout` throws this. Calling it CANCELLED would make
    // retry skip a request that only ran out of time.
    const timeout = new Error("timed out")
    timeout.name = "TimeoutError"
    const error = toEmailError("d", timeout)
    expect(error.code).toBe("TIMEOUT")
    expect(error.retryable).toBe(true)
  })

  it("keeps a caller's abort non-retryable", () => {
    const abort = new Error("aborted")
    abort.name = "AbortError"
    expect(toEmailError("d", abort).retryable).toBe(false)
  })

  it("wraps an ordinary Error as PROVIDER and keeps the cause", () => {
    const cause = new Error("socket reset")
    const error = toEmailError("d", cause)
    expect(error.code).toBe("PROVIDER")
    expect(error.message).toContain("socket reset")
    expect(error.cause).toBe(cause)
  })

  it("wraps a thrown non-Error", () => {
    expect(toEmailError("d", "just a string").message).toContain("just a string")
  })
})

describe("version", () => {
  it("matches package.json — the release script checks this, so the suite should too", () => {
    expect(version).toBe(pkg.version)
  })
})
