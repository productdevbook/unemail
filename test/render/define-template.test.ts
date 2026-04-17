import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { defineTemplate, withRender } from "../../src/render/index.ts"
import reactRenderer from "../../src/render/react.ts"
import mock from "../../src/drivers/mock.ts"

describe("defineTemplate", () => {
  it("produces a typed factory that splats into email.send()", async () => {
    interface WelcomeVars {
      name: string
      activationUrl: string
    }
    const welcome = defineTemplate<WelcomeVars>(({ name, activationUrl }) => ({
      subject: `Welcome, ${name}!`,
      react: { tag: "welcome", name, activationUrl },
    }))

    const driver = mock()
    const email = createEmail({ driver })
    email.use(
      withRender(
        reactRenderer({
          render: async (el: unknown) => {
            const node = el as { name: string; activationUrl: string }
            return `<a href="${node.activationUrl}">Hi ${node.name}</a>`
          },
        }),
      ),
    )

    const rendered = welcome({ name: "Ada", activationUrl: "https://x/y" })
    const { error } = await email.send({
      from: "a@b.com",
      to: "user@b.com",
      subject: rendered.subject!,
      react: rendered.react,
    })
    expect(error).toBeNull()
    const sent = driver.getInstance?.()?.[0] as { subject?: string; html?: string }
    expect(sent?.subject).toBe("Welcome, Ada!")
    expect(sent?.html).toContain("https://x/y")
  })
})
