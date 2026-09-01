import { describe, expect, it } from "vitest"
import type { Renderer } from "../../src/render/index.ts"
import { createEmail } from "../../src/core/email.ts"
import mock from "../../src/drivers/mock.ts"
import { defineTemplate, htmlToText, withRender } from "../../src/render/index.ts"
import reactRenderer from "../../src/render/react.ts"

const defaults = { from: "hi@acme.com" }

const upper: Renderer = {
  name: "upper",
  type: "upper",
  render: (content) => ({ html: `<p>${String(content.source).toUpperCase()}</p>` }),
}

describe("withRender", () => {
  it("resolves content into html before the driver sees it", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults, use: [withRender(upper)] })
    await email.send({
      to: "ada@example.com",
      subject: "hi",
      content: { type: "upper", source: "hello" },
    })

    const sent = driver.getInstance().last()!
    expect(sent.html).toBe("<p>HELLO</p>")
    expect(sent.content).toBeUndefined()
  })

  it("derives a text alternative from the html", async () => {
    const driver = mock()
    await createEmail({ driver, defaults, use: [withRender(upper)] }).send({
      to: "ada@example.com",
      subject: "hi",
      content: { type: "upper", source: "hello" },
    })
    expect(driver.getInstance().last()?.text).toBe("HELLO")
  })

  it("leaves an explicit text alone", async () => {
    const driver = mock()
    await createEmail({ driver, defaults, use: [withRender(upper)] }).send({
      to: "ada@example.com",
      subject: "hi",
      text: "written by hand",
      content: { type: "upper", source: "hello" },
    })
    expect(driver.getInstance().last()?.text).toBe("written by hand")
  })

  it("skips the derivation when autoText is off", async () => {
    const driver = mock()
    await createEmail({ driver, defaults, use: [withRender(upper, { autoText: false })] }).send({
      to: "ada@example.com",
      subject: "hi",
      content: { type: "upper", source: "hello" },
    })
    expect(driver.getInstance().last()?.text).toBeUndefined()
  })

  it("prefers a text the renderer produced itself", async () => {
    const driver = mock()
    const withOwnText: Renderer = {
      name: "own",
      type: "own",
      render: () => ({ html: "<p>rich</p>", text: "renderer's own text" }),
    }
    await createEmail({ driver, defaults, use: [withRender(withOwnText)] }).send({
      to: "ada@example.com",
      subject: "hi",
      content: { type: "own" },
    })
    expect(driver.getInstance().last()?.text).toBe("renderer's own text")
  })

  it("leaves a message without content untouched", async () => {
    const driver = mock()
    await createEmail({ driver, defaults, use: [withRender(upper)] }).send({
      to: "ada@example.com",
      subject: "hi",
      html: "<p>already rendered</p>",
    })
    expect(driver.getInstance().last()?.html).toBe("<p>already rendered</p>")
  })

  it("fails the send when no renderer claims the content type", async () => {
    const { error } = await createEmail({
      driver: mock(),
      defaults,
      use: [withRender(upper)],
    }).send({ to: "ada@example.com", subject: "hi", content: { type: "mjml", source: "x" } })
    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/no renderer registered/)
  })

  it("never writes back into the caller's message object", async () => {
    const template = {
      to: "ada@example.com",
      subject: "hi",
      content: { type: "upper", source: "hello" },
    } as const
    const snapshot = structuredClone(template)
    const email = createEmail({ driver: mock(), defaults, use: [withRender(upper)] })
    await email.send(template)
    await email.send(template)
    expect(template).toEqual(snapshot)
  })

  it("renders every message in a batch", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults, use: [withRender(upper)] })
    await email.sendBatch([
      { to: "a@x.com", subject: "1", content: { type: "upper", source: "one" } },
      { to: "b@x.com", subject: "2", content: { type: "upper", source: "two" } },
    ])
    expect(driver.getInstance().messages.map((m) => m.html)).toEqual(["<p>ONE</p>", "<p>TWO</p>"])
  })
})

describe("defineTemplate", () => {
  it("produces a partial message from typed variables", async () => {
    const welcome = defineTemplate<{ name: string }>(({ name }) => ({
      subject: `Welcome, ${name}`,
      content: { type: "upper", source: `hello ${name}` },
    }))

    const driver = mock()
    await createEmail({ driver, defaults, use: [withRender(upper)] }).send({
      to: "ada@example.com",
      ...welcome({ name: "Ada" }),
      subject: welcome({ name: "Ada" }).subject!,
    })

    const sent = driver.getInstance().last()!
    expect(sent.subject).toBe("Welcome, Ada")
    expect(sent.html).toBe("<p>HELLO ADA</p>")
  })
})

describe("reactRenderer", () => {
  it("uses an injected render function", async () => {
    const driver = mock()
    const renderer = reactRenderer({
      render: (element, options) =>
        options?.plainText ? `text:${String(element)}` : `<p>${String(element)}</p>`,
    })
    await createEmail({ driver, defaults, use: [withRender(renderer)] }).send({
      to: "ada@example.com",
      subject: "hi",
      content: { type: "react", element: "Welcome" },
    })

    const sent = driver.getInstance().last()!
    expect(sent.html).toBe("<p>Welcome</p>")
    expect(sent.text).toBe("text:Welcome")
  })

  it("requires an element", async () => {
    const { error } = await createEmail({
      driver: mock(),
      defaults,
      use: [withRender(reactRenderer({ render: () => "<p/>" }))],
    }).send({ to: "ada@example.com", subject: "hi", content: { type: "react", element: null } })
    expect(error?.message).toMatch(/`content.element` is required/)
  })

  it("explains itself when the optional peer is missing", async () => {
    const { error } = await createEmail({
      driver: mock(),
      defaults,
      use: [withRender(reactRenderer())],
    }).send({ to: "ada@example.com", subject: "hi", content: { type: "react", element: "x" } })
    expect(error?.message).toMatch(/@react-email\/render` is not installed/)
  })
})

describe("htmlToText", () => {
  it("turns block tags into line breaks", () => {
    expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\n\ntwo")
  })

  it("turns <br> into a single newline", () => {
    expect(htmlToText("a<br>b")).toBe("a\nb")
  })

  it("keeps a link's destination", () => {
    expect(htmlToText('<a href="https://acme.com">Acme</a>')).toBe("Acme (https://acme.com)")
  })

  it("does not repeat a link whose text is its own href", () => {
    expect(htmlToText('<a href="https://acme.com">https://acme.com</a>')).toBe("https://acme.com")
  })

  it("drops scripts and styles entirely", () => {
    expect(htmlToText("<style>p{color:red}</style><script>evil()</script><p>safe</p>")).toBe("safe")
  })

  it("decodes entities without double-decoding", () => {
    expect(htmlToText("<p>a &amp; b</p>")).toBe("a & b")
    expect(htmlToText("<p>&amp;lt;</p>")).toBe("&lt;")
    expect(htmlToText("<p>&#8364; &#x20AC;</p>")).toBe("€ €")
  })

  it("collapses runs of blank lines", () => {
    expect(htmlToText("<div><div><div>x</div></div></div>")).toBe("x")
  })
})
