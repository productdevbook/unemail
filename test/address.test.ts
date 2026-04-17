import { describe, expect, it } from "vitest"
import { mustParseAddress, parseAddress, parseAddresses } from "../src/address.ts"

describe("parseAddress", () => {
  it("parses a bare address", () => {
    const { data, error } = parseAddress("ada@acme.com")
    expect(error).toBeNull()
    expect(data?.email).toBe("ada@acme.com")
    expect(data?.local).toBe("ada")
    expect(data?.domain).toBe("acme.com")
  })

  it("parses display-name form", () => {
    const { data } = parseAddress('"Ada, Jr." <ada@acme.com>')
    expect(data?.name).toBe("Ada, Jr.")
    expect(data?.email).toBe("ada@acme.com")
    expect(data?.toString()).toBe('"Ada, Jr." <ada@acme.com>')
  })

  it("parses unquoted display-name form", () => {
    const { data } = parseAddress("Ada <ada@acme.com>")
    expect(data?.name).toBe("Ada")
    expect(data?.email).toBe("ada@acme.com")
  })

  it("rejects missing @", () => {
    expect(parseAddress("not-an-email").error?.code).toBe("INVALID_OPTIONS")
  })

  it("rejects consecutive dots in local-part", () => {
    expect(parseAddress("a..b@example.com").error?.code).toBe("INVALID_OPTIONS")
  })

  it("rejects empty domain label", () => {
    expect(parseAddress("a@.example.com").error?.code).toBe("INVALID_OPTIONS")
  })

  it("accepts SMTPUTF8 by default", () => {
    const { data } = parseAddress("müşteri@örnek.com")
    expect(data?.email).toBe("müşteri@örnek.com")
  })

  it("rejects non-ASCII when smtpUtf8:false", () => {
    expect(parseAddress("müşteri@örnek.com", { smtpUtf8: false }).error).not.toBeNull()
  })
})

describe("parseAddresses", () => {
  it("walks mixed arrays", () => {
    const { data } = parseAddresses(["a@x.com", { email: "b@x.com", name: "Bob" }])
    expect(data).toHaveLength(2)
    expect(data?.[1]?.name).toBe("Bob")
  })

  it("short-circuits on the first failure", () => {
    const { error } = parseAddresses(["a@x.com", "nope"])
    expect(error).not.toBeNull()
  })
})

describe("mustParseAddress", () => {
  it("throws on failure", () => {
    expect(() => mustParseAddress("bad")).toThrow()
  })
})
