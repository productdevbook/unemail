import { describe, expect, it } from "vitest"
import { htmlToText } from "../../src/render/html.ts"

describe("htmlToText", () => {
  it("strips script + style blocks entirely", () => {
    const out = htmlToText("<style>body{color:red}</style><p>hi</p><script>bad()</script>")
    expect(out).toBe("hi")
  })

  it("breaks block tags with newlines", () => {
    expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\n\nb")
  })

  it("keeps <br> as a single newline", () => {
    expect(htmlToText("a<br>b<br/>c")).toBe("a\nb\nc")
  })

  it("renders <a> with href fallback when text differs", () => {
    expect(htmlToText(`<p>Click <a href="https://x.co/y">here</a> please</p>`)).toBe(
      "Click here (https://x.co/y) please",
    )
  })

  it("collapses entities", () => {
    expect(htmlToText("<p>1 &amp; 2 &lt; 3</p>")).toBe("1 & 2 < 3")
  })
})
