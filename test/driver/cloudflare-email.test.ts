import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import cloudflareEmail from "../../src/driver/cloudflare-email.ts"

/** Minimal shape used by the driver — matches the interface of Cloudflare's
 *  real `EmailMessage` class. */
class FakeEmailMessage {
  constructor(
    public from: string,
    public to: string,
    public raw: string,
  ) {}
}

describe("cloudflare-email driver", () => {
  it("invokes binding.send with an EmailMessage built from raw MIME", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const email = createEmail({
      driver: cloudflareEmail({
        binding: { send },
        EmailMessage: FakeEmailMessage,
      }),
    })
    const { data, error } = await email.send({
      from: "sender@acme.com",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.driver).toBe("cloudflare-email")
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0]?.[0] as FakeEmailMessage
    expect(message.from).toBe("sender@acme.com")
    expect(message.to).toBe("user@example.com")
    expect(message.raw).toMatch(/Subject: hi/)
    expect(message.raw).toMatch(/hello/)
  })

  it("surfaces binding errors as PROVIDER EmailError", async () => {
    const send = vi.fn().mockRejectedValue(new Error("not verified"))
    const email = createEmail({
      driver: cloudflareEmail({
        binding: { send },
        EmailMessage: FakeEmailMessage,
      }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.message).toMatch(/not verified/)
  })

  it("requires an EmailMessage constructor when none is on globalThis", () => {
    expect(() =>
      cloudflareEmail({
        binding: { send: () => {} },
        // EmailMessage omitted; globalThis.EmailMessage isn't defined in Node tests
      }),
    ).toThrow(/EmailMessage/)
  })
})
