import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { cidRewrite, darkModeHook, htmlPipeline, withPreheader } from "../../src/render/pipeline.ts"
import mock from "../../src/driver/mock.ts"

describe("html pipeline", () => {
  it("withPreheader injects a hidden preview snippet", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    email.use(htmlPipeline(withPreheader()))
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      preheader: "Your OTP is ready",
      html: "<body><p>Hello</p></body>",
    })
    const sent = driver.getInstance?.()?.[0]?.html ?? ""
    expect(sent).toMatch(/display:none/)
    expect(sent).toContain("Your OTP is ready")
  })

  it("darkModeHook injects supported-color-schemes meta", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    email.use(htmlPipeline(darkModeHook({ darkCss: "body{background:#000}" })))
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      html: "<head></head><body>x</body>",
    })
    const sent = driver.getInstance?.()?.[0]?.html ?? ""
    expect(sent).toContain('name="color-scheme"')
    expect(sent).toContain("prefers-color-scheme: dark")
  })

  it("cidRewrite converts matching <img src> to cid: refs", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    email.use(htmlPipeline(cidRewrite()))
    await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      html: '<img src="logo.png"><img src="https://external/unmatched.png">',
      attachments: [
        { filename: "logo.png", cid: "logo", content: "data", contentType: "image/png" },
      ],
    })
    const sent = driver.getInstance?.()?.[0]?.html ?? ""
    expect(sent).toContain('src="cid:logo"')
    expect(sent).toContain("unmatched.png")
  })
})
