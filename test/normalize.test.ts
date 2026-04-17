import { describe, expect, it } from "vitest"
import { formatAddress, isValidEmail, normalizeAddresses, parseAddress } from "../src/index.ts"

describe("normalizeAddresses", () => {
  it("accepts a bare email string", () => {
    expect(normalizeAddresses("ada@acme.com")).toEqual([{ email: "ada@acme.com" }])
  })

  it("accepts a display-name string", () => {
    expect(normalizeAddresses("Ada <ada@acme.com>")).toEqual([
      { email: "ada@acme.com", name: "Ada" },
    ])
  })

  it("accepts an EmailAddress object", () => {
    expect(normalizeAddresses({ email: "a@b.com", name: "A" })).toEqual([
      { email: "a@b.com", name: "A" },
    ])
  })

  it("accepts a mixed array", () => {
    expect(
      normalizeAddresses(["a@b.com", "Bob <b@c.com>", { email: "c@d.com", name: "C" }]),
    ).toEqual([
      { email: "a@b.com" },
      { email: "b@c.com", name: "Bob" },
      { email: "c@d.com", name: "C" },
    ])
  })

  it("returns [] for undefined", () => {
    expect(normalizeAddresses(undefined)).toEqual([])
  })
})

describe("parseAddress / formatAddress round-trip", () => {
  it("round-trips plain addresses", () => {
    const parsed = parseAddress("hi@example.com")
    expect(formatAddress(parsed)).toBe("hi@example.com")
  })

  it("round-trips display names", () => {
    const parsed = parseAddress("Ada <ada@acme.com>")
    expect(formatAddress(parsed)).toBe("Ada <ada@acme.com>")
  })

  it("quotes names containing special chars", () => {
    expect(formatAddress({ email: "x@y.com", name: "Smith, Jr." })).toBe('"Smith, Jr." <x@y.com>')
  })
})

describe("isValidEmail", () => {
  it("accepts valid addresses", () => {
    expect(isValidEmail("a@b.co")).toBe(true)
    expect(isValidEmail("foo.bar+tag@example.com")).toBe(true)
  })
  it("rejects invalid addresses", () => {
    expect(isValidEmail("nope")).toBe(false)
    expect(isValidEmail("a@b")).toBe(false)
    expect(isValidEmail("a @b.co")).toBe(false)
  })
})
