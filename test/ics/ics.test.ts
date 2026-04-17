import { describe, expect, it } from "vitest"
import { icalEvent } from "../../src/ics/index.ts"

function asText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content)
}

describe("icalEvent", () => {
  const baseEvent = {
    uid: "evt-1@unemail.test",
    start: new Date("2026-05-01T10:00:00Z"),
    end: new Date("2026-05-01T11:00:00Z"),
    summary: "Sync with team",
  }

  it("builds a VEVENT with CRLF line endings and method=REQUEST", () => {
    const attachment = icalEvent(baseEvent)
    const text = asText(attachment.content)
    expect(text).toContain("BEGIN:VCALENDAR")
    expect(text).toContain("METHOD:REQUEST")
    expect(text).toContain("BEGIN:VEVENT")
    expect(text).toContain(`UID:${baseEvent.uid}`)
    expect(text).toContain("DTSTART:20260501T100000Z")
    expect(text).toContain("DTEND:20260501T110000Z")
    expect(text).toContain("SUMMARY:Sync with team")
    expect(text).toContain("END:VEVENT")
    expect(text).toContain("END:VCALENDAR")
    expect(text.includes("\r\n")).toBe(true)
  })

  it("wires the Content-Type with the chosen method", () => {
    const attachment = icalEvent(baseEvent, { method: "CANCEL" })
    expect(attachment.contentType).toBe("text/calendar; charset=UTF-8; method=CANCEL")
    expect(asText(attachment.content)).toContain("METHOD:CANCEL")
  })

  it("escapes special characters in text fields", () => {
    const a = icalEvent({
      ...baseEvent,
      description: "Hi; hello, world\nsecond line",
    })
    const text = asText(a.content)
    expect(text).toContain("DESCRIPTION:Hi\\; hello\\, world\\nsecond line")
  })

  it("serializes organizer and attendees", () => {
    const a = icalEvent({
      ...baseEvent,
      organizer: { email: "host@example.com", name: "Host" },
      attendees: [
        { email: "a@example.com", name: "Ada", role: "REQ-PARTICIPANT", rsvp: true },
        { email: "b@example.com", role: "OPT-PARTICIPANT", partstat: "TENTATIVE" },
      ],
    })
    const text = asText(a.content)
    expect(text).toContain("ORGANIZER;CN=Host:mailto:host@example.com")
    expect(text).toContain("ATTENDEE;CN=Ada;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:a@example.com")
    expect(text).toContain("ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE:mailto:b@example.com")
  })

  it("emits a VALARM with negative trigger for reminders", () => {
    const a = icalEvent({
      ...baseEvent,
      alarms: [{ triggerMinutesBefore: 15 }],
    })
    const text = asText(a.content)
    expect(text).toContain("BEGIN:VALARM")
    expect(text).toContain("TRIGGER:-PT15M")
    expect(text).toContain("END:VALARM")
  })

  it("folds long lines at 75 octets", () => {
    const long = "x".repeat(200)
    const a = icalEvent({ ...baseEvent, summary: long })
    const text = asText(a.content)
    const summaryLine = text.split("\r\n").find((l) => l.startsWith("SUMMARY:"))!
    expect(summaryLine.length).toBeLessThanOrEqual(75)
  })
})
