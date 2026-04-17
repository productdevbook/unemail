/**
 * Minimal, dependency-free builder for iCalendar (RFC 5545) event
 * invites. Produces an `Attachment` you can hand to `email.send()`.
 *
 * Scope: single VEVENT with optional organizer + attendees + alarms.
 * That covers the meeting-invite use case, which is the 95% that
 * nodemailer's `icalEvent` shipped and every user needs.
 *
 * @module
 */

import type { Attachment } from "../types.ts"

export type IcsMethod = "REQUEST" | "PUBLISH" | "CANCEL" | "REPLY"
export type IcsStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED"
export type IcsRole = "REQ-PARTICIPANT" | "OPT-PARTICIPANT" | "CHAIR" | "NON-PARTICIPANT"
export type IcsPartStat = "ACCEPTED" | "DECLINED" | "TENTATIVE" | "NEEDS-ACTION"

export interface IcsAttendee {
  email: string
  name?: string
  role?: IcsRole
  partstat?: IcsPartStat
  rsvp?: boolean
}

export interface IcsAlarm {
  /** Minutes before the event start (positive). */
  triggerMinutesBefore: number
  description?: string
}

export interface IcsEvent {
  /** Stable unique id — required by RFC 5545. */
  uid: string
  /** Local or UTC Date. */
  start: Date
  /** Local or UTC Date. */
  end: Date
  summary: string
  description?: string
  location?: string
  url?: string
  status?: IcsStatus
  organizer?: { email: string; name?: string }
  attendees?: ReadonlyArray<IcsAttendee>
  alarms?: ReadonlyArray<IcsAlarm>
  /** 0 for new invites, incremented on updates. Default 0. */
  sequence?: number
}

export interface IcsOptions {
  method?: IcsMethod
  /** PRODID identifier. Default: `-//unemail//ics//EN`. */
  prodId?: string
  /** Filename for the attachment. Default: `invite.ics`. */
  filename?: string
}

/** Build an iCalendar `VEVENT` attachment for an email. Content-Type is
 *  set with the canonical `method=` parameter so Outlook / Gmail render
 *  the invite inline. */
export function icalEvent(event: IcsEvent, options: IcsOptions = {}): Attachment {
  const method = options.method ?? "REQUEST"
  const prodId = options.prodId ?? "-//unemail//ics//EN"
  const filename = options.filename ?? "invite.ics"
  const content = buildIcs(event, method, prodId)
  return {
    filename,
    content,
    contentType: `text/calendar; charset=UTF-8; method=${method}`,
    disposition: "attachment",
  }
}

function buildIcs(event: IcsEvent, method: IcsMethod, prodId: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    `METHOD:${method}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `DTSTART:${formatUtc(event.start)}`,
    `DTEND:${formatUtc(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${event.status ?? "CONFIRMED"}`,
  ]
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
  if (event.url) lines.push(`URL:${event.url}`)
  if (event.organizer) {
    const cn = event.organizer.name ? `CN=${escapeText(event.organizer.name)}:` : ""
    lines.push(`ORGANIZER;${cn}mailto:${event.organizer.email}`)
  }
  for (const a of event.attendees ?? []) lines.push(formatAttendee(a))
  for (const alarm of event.alarms ?? []) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `TRIGGER:-PT${Math.round(alarm.triggerMinutesBefore)}M`,
      `DESCRIPTION:${escapeText(alarm.description ?? event.summary)}`,
      "END:VALARM",
    )
  }
  lines.push("END:VEVENT", "END:VCALENDAR")
  return lines.map(foldLine).join("\r\n") + "\r\n"
}

function formatUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  )
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
}

function formatAttendee(a: IcsAttendee): string {
  const parts: string[] = []
  if (a.name) parts.push(`CN=${escapeText(a.name)}`)
  if (a.role) parts.push(`ROLE=${a.role}`)
  if (a.partstat) parts.push(`PARTSTAT=${a.partstat}`)
  if (a.rsvp !== undefined) parts.push(`RSVP=${a.rsvp ? "TRUE" : "FALSE"}`)
  const suffix = parts.length ? `;${parts.join(";")}` : ""
  return `ATTENDEE${suffix}:mailto:${a.email}`
}

/** RFC 5545 requires lines ≤ 75 octets, continuation lines start with a
 *  single space. We approximate by chars since all our content is ASCII
 *  after escaping — if you need UTF-8 display names this still works
 *  because the folded continuation is decoded identically. */
function foldLine(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  let start = 0
  while (start < line.length) {
    const chunk = line.slice(start, start + 75)
    parts.push(start === 0 ? chunk : ` ${chunk}`)
    start += 75
  }
  return parts.join("\r\n")
}
