import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { withRender } from "../../src/render/index.ts"
import reactRenderer from "../../src/render/react.ts"
import mjmlRenderer from "../../src/render/mjml.ts"
import mock from "../../src/driver/mock.ts"

describe("withRender middleware", () => {
  it("turns `react:` into `html` + derives text", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    email.use(
      withRender(
        reactRenderer({
          render: async (el) => `<h1>Hello ${(el as { name: string }).name}</h1>`,
        }),
      ),
    )

    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      react: { name: "Ada" },
    })
    expect(error).toBeNull()
    const sent = driver.getInstance?.()?.[0] as { html?: string; text?: string }
    expect(sent?.html).toBe("<h1>Hello Ada</h1>")
    expect(sent?.text).toBe("Hello Ada")
  })

  it("does not derive text when user supplied it", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    email.use(withRender(reactRenderer({ render: async () => "<p>HTML only</p>" })))
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      react: {},
      text: "custom fallback",
    })
    const sent = driver.getInstance?.()?.[0]
    expect(sent?.text).toBe("custom fallback")
  })

  it("picks the first matching renderer when multiple are registered", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    email.use(
      withRender(
        reactRenderer({ render: async () => "<p>from-react</p>" }),
        mjmlRenderer({ compile: () => "<p>from-mjml</p>" }),
      ),
    )
    // Only mjml is set — first renderer declines, second handles it.
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      mjml: "<mjml></mjml>",
    })
    const sent = driver.getInstance?.()?.[0]
    expect(sent?.html).toBe("<p>from-mjml</p>")
  })

  it("reactRenderer throws a helpful error when the peer isn't installed", async () => {
    const r = reactRenderer() // no `render` override → tries to import @react-email/render
    await expect(
      r.render({ react: {}, from: "a@b.com", to: "c@d.com", subject: "x" }),
    ).rejects.toThrow(/@react-email\/render/)
  })
})
