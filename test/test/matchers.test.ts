import { describe, expect, it } from "vitest"
import {
  createTestEmail,
  emailMatchers,
  matchesEmail,
  toEmailSnapshot,
} from "../../src/test/index.ts"

expect.extend(emailMatchers)

describe("emailMatchers", () => {
  it("matches by subject regex", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "Welcome Ada", text: "" })
    expect(emailMatchers.toHaveSent(email, { subject: /welcome/i }).pass).toBe(true)
  })

  it("matches by recipient email", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "Ada <ada@acme.com>", subject: "hi", text: "" })
    expect(emailMatchers.toHaveSent(email, { to: "ada@acme.com" }).pass).toBe(true)
  })

  it("fails cleanly when no message matches", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "" })
    const result = emailMatchers.toHaveSent(email, { subject: "missing" })
    expect(result.pass).toBe(false)
    expect(result.message()).toMatch(/expected an email to match/)
  })
})

describe("emailMatchers — extended", () => {
  it("toHaveSentTo matches a recipient", async () => {
    const email = createTestEmail()
    await email.send({
      from: "a@b.com",
      to: ["Ada <ada@acme.com>", "bob@acme.com"],
      cc: "c@d.com",
      subject: "hi",
      text: "",
    })
    expect(emailMatchers.toHaveSentTo(email, "bob@acme.com").pass).toBe(true)
    expect(emailMatchers.toHaveSentTo(email, "c@d.com").pass).toBe(true)
    expect(emailMatchers.toHaveSentTo(email, "nobody@x.com").pass).toBe(false)
  })

  it("toHaveSentWithSubject supports strings and regex", async () => {
    const email = createTestEmail()
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "Welcome", text: "" })
    expect(emailMatchers.toHaveSentWithSubject(email, "Welcome").pass).toBe(true)
    expect(emailMatchers.toHaveSentWithSubject(email, /wel/i).pass).toBe(true)
    expect(emailMatchers.toHaveSentWithSubject(email, "other").pass).toBe(false)
  })

  it("toHaveSentWithAttachment matches by filename and predicate", async () => {
    const email = createTestEmail()
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "",
      attachments: [
        { filename: "invite.ics", content: "BEGIN:VCALENDAR", contentType: "text/calendar" },
      ],
    })
    expect(emailMatchers.toHaveSentWithAttachment(email, "invite.ics").pass).toBe(true)
    expect(
      emailMatchers.toHaveSentWithAttachment(email, (a) => a.contentType === "text/calendar").pass,
    ).toBe(true)
    expect(emailMatchers.toHaveSentWithAttachment(email, "absent.pdf").pass).toBe(false)
  })

  it("toHaveSentMatching runs a custom predicate", async () => {
    const email = createTestEmail()
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "",
      tags: [{ name: "campaign", value: "welcome-v2" }],
    })
    expect(
      emailMatchers.toHaveSentMatching(email, (m) =>
        (m.tags ?? []).some((t) => t.name === "campaign" && t.value === "welcome-v2"),
      ).pass,
    ).toBe(true)
  })
})

describe("toEmailSnapshot", () => {
  it("returns a stable shape and drops Message-ID / Date headers", () => {
    const snap = toEmailSnapshot({
      from: "Ada <ada@acme.com>",
      to: "bob@x.com",
      subject: "hi",
      text: "body",
      headers: {
        "Message-ID": "<random@host>",
        Date: "Wed, 01 Jan 2020 00:00:00 GMT",
        "X-App": "unemail",
      },
    })
    expect(snap).toMatchObject({
      from: ["ada@acme.com"],
      to: ["bob@x.com"],
      subject: "hi",
      text: "body",
      headers: { "X-App": "unemail" },
    })
    expect((snap.headers as Record<string, unknown>)["Message-ID"]).toBeUndefined()
  })
})

describe("matchesEmail", () => {
  it("matches string fields", () => {
    const match = matchesEmail({ from: "a@b.com", to: "c@d.com", subject: "hi" }, { subject: "hi" })
    expect(match.pass).toBe(true)
  })
  it("rejects mismatches with a diff", () => {
    const match = matchesEmail(
      { from: "a@b.com", to: "c@d.com", subject: "hi" },
      { subject: "not-hi" },
    )
    expect(match.pass).toBe(false)
    expect(match.diff).toMatch(/expected subject/)
  })
})
