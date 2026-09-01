import { describe, expect, it } from "vitest"
import {
  dedupeAddresses,
  formatAddress,
  formatAddressList,
  isValidEmail,
  parseAddress,
  toAddressList,
} from "../../src/core/address.ts"

describe("parseAddress", () => {
  it.each([
    ["ada@acme.com", { email: "ada@acme.com" }],
    ["  ada@acme.com  ", { email: "ada@acme.com" }],
    ["Ada Lovelace <ada@acme.com>", { email: "ada@acme.com", name: "Ada Lovelace" }],
    ['"Lovelace, Ada" <ada@acme.com>', { email: "ada@acme.com", name: "Lovelace, Ada" }],
    ["<ada@acme.com>", { email: "ada@acme.com" }],
  ])("parses %s", (input, expected) => {
    expect(parseAddress(input)).toEqual(expected)
  })
})

describe("formatAddress", () => {
  it("returns a bare address when there is no name", () => {
    expect(formatAddress({ email: "a@b.com" })).toBe("a@b.com")
  })

  it("quotes a name containing a delimiter", () => {
    expect(formatAddress({ email: "a@b.com", name: "Lovelace, Ada" })).toBe(
      '"Lovelace, Ada" <a@b.com>',
    )
  })

  it("escapes an embedded quote", () => {
    expect(formatAddress({ email: "a@b.com", name: 'Ada "The First"' })).toBe(
      '"Ada \\"The First\\"" <a@b.com>',
    )
  })

  it("round-trips through parseAddress", () => {
    const address = { email: "a@b.com", name: "Ada Lovelace" }
    expect(parseAddress(formatAddress(address))).toEqual(address)
  })

  it("joins a list", () => {
    expect(formatAddressList([{ email: "a@b.com" }, { email: "c@d.com", name: "Cee" }])).toBe(
      "a@b.com, Cee <c@d.com>",
    )
  })
})

describe("toAddressList", () => {
  it("returns an empty list for nullish input", () => {
    expect(toAddressList(undefined)).toEqual([])
  })

  it("accepts a single string, an object, or a mixed array", () => {
    expect(toAddressList("a@b.com")).toEqual([{ email: "a@b.com" }])
    expect(toAddressList({ email: "a@b.com", name: "A" })).toEqual([
      { email: "a@b.com", name: "A" },
    ])
    expect(toAddressList(["a@b.com", { email: "c@d.com" }])).toHaveLength(2)
  })

  it("skips empty strings rather than producing an empty address", () => {
    expect(toAddressList(["a@b.com", "", "   "])).toEqual([{ email: "a@b.com" }])
  })
})

describe("dedupeAddresses", () => {
  it("keeps the first occurrence's name", () => {
    expect(
      dedupeAddresses([
        { email: "A@b.com", name: "First" },
        { email: "a@B.com", name: "Second" },
      ]),
    ).toEqual([{ email: "A@b.com", name: "First" }])
  })
})

describe("isValidEmail", () => {
  it.each(["a@b.com", "ada.lovelace+tag@sub.acme.co.uk"])("accepts %s", (value) => {
    expect(isValidEmail(value)).toBe(true)
  })

  it.each(["", "a@b", "a b@c.com", "no-at-sign.com", "a@b.com,c@d.com", "a@b.com;c@d.com"])(
    "rejects %s",
    (value) => {
      expect(isValidEmail(value)).toBe(false)
    },
  )
})
