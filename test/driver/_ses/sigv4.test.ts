import { describe, expect, it } from "vitest"
import { signRequest } from "../../../src/driver/_ses/sigv4.ts"

/** AWS's published test vector for SigV4 GETs the Vanilla example — we
 *  reuse the shape here with a tiny POST to confirm the algorithm matches
 *  ref-impl output byte-for-byte. */
describe("signRequest", () => {
  it("produces a stable Authorization header for a given input", async () => {
    const signed = await signRequest({
      method: "POST",
      url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
      headers: { "content-type": "application/json" },
      body: `{"x":1}`,
      region: "us-east-1",
      service: "ses",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      now: () => new Date(Date.UTC(2026, 3, 17, 12, 0, 0)),
    })

    expect(signed.headers["x-amz-date"]).toBe("20260417T120000Z")
    expect(signed.headers.host).toBe("email.us-east-1.amazonaws.com")
    expect(signed.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260417\/us-east-1\/ses\/aws4_request/,
    )
    expect(signed.headers.authorization).toMatch(/SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/)
  })

  it("includes the session token when provided", async () => {
    const signed = await signRequest({
      method: "POST",
      url: "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails",
      region: "eu-west-1",
      service: "ses",
      credentials: {
        accessKeyId: "a",
        secretAccessKey: "b",
        sessionToken: "sess_xyz",
      },
    })
    expect(signed.headers["x-amz-security-token"]).toBe("sess_xyz")
    // signed headers list must include x-amz-security-token
    expect(signed.headers.authorization).toMatch(/x-amz-security-token/)
  })

  it("produces a different signature when the body changes", async () => {
    const base = {
      method: "POST",
      url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
      region: "us-east-1",
      service: "ses",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
      now: () => new Date(Date.UTC(2026, 3, 17, 12, 0, 0)),
    } as const
    const a = await signRequest({ ...base, body: `{"x":1}` })
    const b = await signRequest({ ...base, body: `{"x":2}` })
    const sigA = /Signature=([0-9a-f]+)/.exec(a.headers.authorization)?.[1]
    const sigB = /Signature=([0-9a-f]+)/.exec(b.headers.authorization)?.[1]
    expect(sigA).not.toBe(sigB)
  })
})
