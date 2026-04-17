import { describe, expect, it } from "vitest"
import { generateMtaStsPolicy, parseTlsRpt } from "../../src/mta-sts/index.ts"

describe("generateMtaStsPolicy", () => {
  it("serializes a spec-compliant policy", () => {
    const body = generateMtaStsPolicy({
      mode: "enforce",
      mx: ["mx1.example.com", "*.mx.example.com"],
      maxAgeSeconds: 86400,
    })
    expect(body).toContain("version: STSv1")
    expect(body).toContain("mode: enforce")
    expect(body).toContain("mx: mx1.example.com")
    expect(body).toContain("mx: *.mx.example.com")
    expect(body).toContain("max_age: 86400")
    expect(body.endsWith("\r\n")).toBe(true)
  })
})

describe("parseTlsRpt", () => {
  it("normalizes a Google-style report", () => {
    const report = parseTlsRpt({
      "organization-name": "Google Inc.",
      "contact-info": "smtp-tls-reporting@google.com",
      "report-id": "abc-123",
      "date-range": {
        "start-datetime": "2026-05-01T00:00:00Z",
        "end-datetime": "2026-05-02T00:00:00Z",
      },
      policies: [
        {
          policy: { "policy-type": "sts", "policy-domain": "example.com" },
          summary: { "total-successful-session-count": 100, "total-failure-session-count": 2 },
          "failure-details": [
            {
              "result-type": "certificate-not-trusted",
              "sending-mta-ip": "1.2.3.4",
              "failed-session-count": 2,
            },
          ],
        },
      ],
    })
    expect(report.organizationName).toBe("Google Inc.")
    expect(report.policies[0]!.policyType).toBe("sts")
    expect(report.policies[0]!.totalSuccessful).toBe(100)
    expect(report.policies[0]!.failureDetails?.[0]?.resultType).toBe("certificate-not-trusted")
  })
})
