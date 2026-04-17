import { describe, expect, it } from "vitest"
import { parseDmarcAggregate } from "../../src/dmarc/index.ts"

const SAMPLE = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>12345</report_id>
    <date_range>
      <begin>1700000000</begin>
      <end>1700086400</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>reject</p>
    <sp>reject</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.5</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.1</source_ip>
      <count>1</count>
      <policy_evaluated>
        <disposition>reject</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
  </record>
</feedback>`

describe("parseDmarcAggregate", () => {
  it("parses an aggregate report", async () => {
    const report = await parseDmarcAggregate(SAMPLE)
    expect(report.orgName).toBe("google.com")
    expect(report.reportId).toBe("12345")
    expect(report.policy?.p).toBe("reject")
    expect(report.policy?.pct).toBe(100)
    expect(report.dateRange?.begin.toISOString()).toMatch(/^2023-/)
    expect(report.records).toHaveLength(2)
    expect(report.records[0]?.count).toBe(3)
    expect(report.records[0]?.dkim).toBe("pass")
    expect(report.records[1]?.disposition).toBe("reject")
  })
})
