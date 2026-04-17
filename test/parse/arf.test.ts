import { describe, expect, it } from "vitest"
import { parseArf } from "../../src/parse/arf.ts"

const SAMPLE = [
  "Content-Type: multipart/report; report-type=feedback-report; boundary=b1",
  "",
  "--b1",
  "Content-Type: text/plain",
  "",
  "This is a complaint.",
  "",
  "--b1",
  "Content-Type: message/feedback-report",
  "",
  "Feedback-Type: abuse",
  "User-Agent: MailProvider/1.0",
  "Version: 1",
  "Original-Mail-From: <ada@example.com>",
  "Original-Rcpt-To: <bob@isp.com>",
  "Reported-Domain: example.com",
  "Arrival-Date: Fri, 1 May 2026 12:00:00 +0000",
  "Source-IP: 203.0.113.5",
  "",
  "--b1",
  "Content-Type: message/rfc822-headers",
  "",
  "Message-ID: <abc@example.com>",
  "From: Ada <ada@example.com>",
  "Subject: Hello",
  "",
  "--b1--",
].join("\r\n")

describe("parseArf", () => {
  it("extracts feedback report + reported headers", () => {
    const r = parseArf(SAMPLE)
    expect(r.feedbackType).toBe("abuse")
    expect(r.originalMailFrom).toBe("<ada@example.com>")
    expect(r.reportedDomain).toBe("example.com")
    expect(r.sourceIp).toBe("203.0.113.5")
    expect(r.reportedMessageId).toBe("<abc@example.com>")
    expect(r.reportedHeaders?.subject).toBe("Hello")
  })
})
