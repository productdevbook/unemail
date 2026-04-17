import { describe, expect, it } from "vitest"
import { ReplyParser } from "../../../src/drivers/_smtp/reply.ts"

describe("ReplyParser", () => {
  it("emits a single 3-digit reply", () => {
    const replies: unknown[] = []
    const p = new ReplyParser((r) => replies.push(r))
    p.push("220 example ESMTP\r\n")
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ code: 220 })
  })

  it("collects continuation lines until the space-separator", () => {
    const replies: { code: number; lines: string[] }[] = []
    const p = new ReplyParser((r) => replies.push(r))
    p.push("250-hello\r\n250-SIZE 10000\r\n250 AUTH PLAIN LOGIN\r\n")
    expect(replies).toHaveLength(1)
    expect(replies[0]!.code).toBe(250)
    expect(replies[0]!.lines).toEqual(["hello", "SIZE 10000", "AUTH PLAIN LOGIN"])
  })

  it("handles chunks split mid-line", () => {
    const replies: { code: number }[] = []
    const p = new ReplyParser((r) => replies.push(r))
    p.push("2")
    p.push("50 ok\r")
    p.push("\n")
    expect(replies).toHaveLength(1)
    expect(replies[0]!.code).toBe(250)
  })
})
