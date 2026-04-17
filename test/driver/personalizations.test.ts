import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import sendgrid from "../../src/driver/sendgrid.ts"
import mock from "../../src/driver/mock.ts"

describe("personalizations", () => {
  it("sendgrid sends all personalizations in a single API call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }))
    const email = createEmail({
      driver: sendgrid({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch }),
    })
    await email.send({
      from: "a@b.com",
      to: "ignored@x.com",
      subject: "Batch",
      text: "hi",
      personalizations: [
        { to: "ada@acme.com", variables: { name: "Ada" } },
        { to: "bob@acme.com", variables: { name: "Bob" }, subject: "Just for Bob" },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.personalizations).toHaveLength(2)
    expect(body.personalizations[0].to[0].email).toBe("ada@acme.com")
    expect(body.personalizations[0].dynamic_template_data).toEqual({ name: "Ada" })
    expect(body.personalizations[1].subject).toBe("Just for Bob")
  })

  it("collapses to first personalization on drivers without native support", async () => {
    const driver = mock()
    const email = createEmail({ driver })
    await email.send({
      from: "a@b.com",
      to: "ignored@x.com",
      subject: "Welcome",
      text: "x",
      personalizations: [{ to: "ada@acme.com" }, { to: "bob@acme.com" }],
    })
    const inbox = driver.getInstance?.() ?? []
    expect(inbox).toHaveLength(1)
    const sent = inbox[0]!
    const to = Array.isArray(sent.to) ? sent.to : [sent.to]
    const email0 = typeof to[0] === "string" ? to[0] : (to[0] as { email: string }).email
    expect(email0).toBe("ada@acme.com")
    expect(sent).not.toHaveProperty("personalizations")
  })
})
