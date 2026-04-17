import { describe, expect, it } from "vitest"
import {
  parseAuthenticationResults,
  verifyAll,
  verifyDkim,
  verifyDmarc,
  verifySpf,
} from "../../src/verify/index.ts"
import type { ParsedEmail } from "../../src/parse/index.ts"

function mailWith(authHeader?: string): ParsedEmail {
  return {
    to: [],
    cc: [],
    bcc: [],
    references: [],
    attachments: [],
    headers: authHeader ? { "authentication-results": authHeader } : {},
  }
}

describe("parseAuthenticationResults", () => {
  it("extracts dkim/spf/dmarc outcomes and the authenticating domain", () => {
    const out = parseAuthenticationResults(
      "mx.google.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass",
    )
    expect(out.dkim).toBe("pass")
    expect(out.spf).toBe("pass")
    expect(out.dmarc).toBe("pass")
    expect(out.authenticatedDomain).toBe("example.com")
  })

  it("returns `none` when the header is missing", () => {
    const out = parseAuthenticationResults(undefined)
    expect(out).toMatchObject({ dkim: "none", spf: "none", dmarc: "none" })
  })

  it("captures fail outcomes", () => {
    const out = parseAuthenticationResults(
      "mx.google.com; dkim=fail; spf=softfail; dmarc=temperror",
    )
    expect(out.dkim).toBe("fail")
    expect(out.spf).toBe("softfail")
    expect(out.dmarc).toBe("temperror")
  })
})

describe("verify*", () => {
  const happy = mailWith("mx; dkim=pass header.d=example.com; spf=pass; dmarc=pass")

  it("each helper returns the right slice", () => {
    expect(verifyDkim(happy)).toBe("pass")
    expect(verifySpf(happy)).toBe("pass")
    expect(verifyDmarc(happy)).toBe("pass")
  })

  it("verifyAll prefers the async callback over header parsing", async () => {
    const header = mailWith("mx; dkim=fail; spf=fail; dmarc=fail")
    const out = await verifyAll(header, {
      verify: () => ({
        dkim: "pass",
        spf: "pass",
        dmarc: "pass",
        authenticatedDomain: "override.com",
      }),
    })
    expect(out).toEqual({
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      authenticatedDomain: "override.com",
    })
  })
})
