/** An SMTP reply — one 3-digit code with one or more continuation lines. */
export interface SmtpReply {
  code: number
  lines: string[]
  raw: string
}

/** Incremental parser for SMTP replies. Feed it chunks via `push()`; it
 *  invokes `onReply` once per complete reply and leaves any trailing
 *  partial line buffered for the next chunk.
 *
 *  Multi-line replies look like:
 *    250-size 10240000\r\n
 *    250-auth login plain\r\n
 *    250 ok\r\n
 *  (Hyphen after the code means "continuation"; space means "last line".)
 */
export class ReplyParser {
  private buffer = ""
  private lines: string[] = []
  private code = 0
  private readonly onReply: (reply: SmtpReply) => void

  constructor(onReply: (reply: SmtpReply) => void) {
    this.onReply = onReply
  }

  push(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const idx = this.buffer.indexOf("\n")
      if (idx < 0) break
      const line = this.buffer.slice(0, idx).replace(/\r$/, "")
      this.buffer = this.buffer.slice(idx + 1)
      this.consumeLine(line)
    }
  }

  private consumeLine(line: string): void {
    const match = /^(\d{3})([\s-])(.*)$/.exec(line)
    if (!match) {
      // Non-conforming line — surface as its own reply so the caller sees it.
      this.onReply({ code: 0, lines: [line], raw: line })
      return
    }
    const code = Number(match[1])
    const separator = match[2]
    const text = match[3] ?? ""
    if (!this.code) this.code = code
    this.lines.push(text)
    if (separator === " ") {
      const reply: SmtpReply = {
        code: this.code,
        lines: this.lines,
        raw: this.lines.join(" "),
      }
      this.code = 0
      this.lines = []
      this.onReply(reply)
    }
  }

  /** Bytes received but not yet forming a complete line — useful for tests. */
  get pending(): string {
    return this.buffer
  }
}
