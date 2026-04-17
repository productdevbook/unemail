import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import { withOAuth2 } from "../../src/middleware/oauth2.ts"
import type { EmailDriver } from "../../src/types.ts"

function capturing(): { driver: EmailDriver; last: () => string | undefined } {
  let header: string | undefined
  return {
    driver: {
      name: "probe",
      send(msg) {
        header = msg.headers?.authorization
        return { data: { id: "ok", driver: "probe", at: new Date() }, error: null }
      },
    },
    last: () => header,
  }
}

describe("withOAuth2", () => {
  it("fetches a token once and reuses it for subsequent sends", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "T1", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const cap = capturing()
    const email = createEmail({ driver: cap.driver })
    email.use(
      withOAuth2({
        tokenEndpoint: "https://idp/token",
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    )
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "y", text: "y" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cap.last()).toBe("Bearer T1")
  })

  it("refreshes when the token is past expiry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "A", expires_in: 60 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "B", expires_in: 60 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    const cap = capturing()
    let clock = 1000
    const email = createEmail({ driver: cap.driver })
    email.use(
      withOAuth2({
        tokenEndpoint: "https://idp/token",
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        fetch: fetchMock as unknown as typeof fetch,
        now: () => clock,
      }),
    )
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(cap.last()).toBe("Bearer A")
    clock += 120_000 // past 60s expiry + 30s skew
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "y", text: "y" })
    expect(cap.last()).toBe("Bearer B")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
