import { describe, expect, it } from "vitest"
import { stripReply } from "../../src/inbound/reply.ts"
import { threadKey, buildThreads } from "../../src/inbound/thread.ts"

describe("stripReply", () => {
  it("strips English Gmail-style 'On ... wrote:' quotes", () => {
    const raw = [
      "Sounds good. See you then.",
      "",
      "On Mon, May 1, 2026 at 3:00 PM Ada <ada@x.com> wrote:",
      "> Can we meet at 3?",
      "> -- Ada",
    ].join("\n")
    const { text, quoted } = stripReply(raw)
    expect(text).toBe("Sounds good. See you then.")
    expect(quoted).toContain("Can we meet at 3?")
  })

  it("strips signatures introduced by '-- \\n'", () => {
    const raw = [
      "Thanks — will review and reply later today.",
      "",
      "-- ",
      "Bob Jones",
      "Engineer at Acme",
    ].join("\n")
    const { text } = stripReply(raw)
    expect(text).toBe("Thanks — will review and reply later today.")
  })

  it("strips Outlook '-----Original Message-----' blocks", () => {
    const raw = [
      "Acknowledged.",
      "",
      "-----Original Message-----",
      "From: Ada",
      "Sent: Monday",
      "Subject: Hi",
      "",
      "Hello",
    ].join("\n")
    const { text } = stripReply(raw)
    expect(text).toBe("Acknowledged.")
  })

  it("strips Turkish tarihinde...yazdı quotes", () => {
    const raw = [
      "Tamamdir, tesekkurler.",
      "",
      "1 Ocak 2026 Pazartesi tarihinde Ada <ada@x.com> şunları yazdı:",
      "> Bunu gönderebilir misin?",
    ].join("\n")
    const { text } = stripReply(raw)
    expect(text).toBe("Tamamdir, tesekkurler.")
  })

  it("strips '>' quoted blocks after a blank line", () => {
    const raw = ["New reply content only.", "", "> previous message", "> continues here"].join("\n")
    const { text, quoted } = stripReply(raw)
    expect(text).toBe("New reply content only.")
    expect(quoted).toMatch(/^> previous message/)
  })
})

describe("threadKey + buildThreads", () => {
  it("picks the first References entry as the canonical root", () => {
    const k = threadKey({
      messageId: "<r1@host>",
      inReplyTo: "<root@host>",
      references: ["<root@host>", "<r1@host>"],
    })
    expect(k).toBe("root@host")
  })

  it("falls back to In-Reply-To when References is missing", () => {
    const k = threadKey({ messageId: "<r1@host>", inReplyTo: "<parent@host>" })
    expect(k).toBe("parent@host")
  })

  it("falls back to Message-ID for thread-starters", () => {
    const k = threadKey({ messageId: "<seed@host>" })
    expect(k).toBe("seed@host")
  })

  it("buildThreads groups messages by canonical root", () => {
    const groups = buildThreads([
      { messageId: "<seed@h>", references: [] },
      { messageId: "<reply1@h>", inReplyTo: "<seed@h>", references: ["<seed@h>"] },
      { messageId: "<reply2@h>", inReplyTo: "<reply1@h>", references: ["<seed@h>", "<reply1@h>"] },
      { messageId: "<other@h>", references: [] },
    ])
    expect(groups.get("seed@h")).toEqual(["seed@h", "reply1@h", "reply2@h"])
    expect(groups.get("other@h")).toEqual(["other@h"])
  })
})
