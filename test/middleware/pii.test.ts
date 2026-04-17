import { describe, expect, it } from "vitest"
import { scrubPii } from "../../src/middleware/pii.ts"

describe("scrubPii", () => {
  const msg = {
    from: "ada@x.com",
    to: ["bob@x.com", "Carol <carol@x.com>"],
    subject: "Hello Ada",
    text: "Hey Ada, your OTP is 123456",
    html: "<p>hi</p>",
  }

  it("masks local-parts of recipients and the subject/body", () => {
    const out = scrubPii(msg, { strategy: "mask" })
    expect(out.to).toEqual(["b***@x.com", "c***@x.com"])
    expect(out.subject).toBe("H***")
    expect(out.text).toBe("H***")
  })

  it("drops instead of masking when strategy=drop", () => {
    const out = scrubPii(msg, { strategy: "drop" })
    expect(out.subject).toBe("***")
    expect(out.text).toBe("***")
  })

  it("leaves recipients in place when not listed in redact", () => {
    const out = scrubPii(msg, { redact: ["subject"], strategy: "mask" })
    expect(out.to).toBe(msg.to)
    expect(out.subject).toBe("H***")
    expect(out.text).toBe(msg.text)
  })
})
