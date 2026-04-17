import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import zeptomail from "../../src/drivers/zeptomail.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("zeptomail driver", () => {
  it("POSTs with the Zoho token shape and extracts message_id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ message_id: "zp_1", additional_info: [] }] }))
    const email = createEmail({
      driver: zeptomail({
        token: "Zoho-enczapikey abc",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { data, error } = await email.send({
      from: "Acme <hi@acme.com>",
      to: "user@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.id).toBe("zp_1")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.zeptomail.com/v1.1/email")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe("Zoho-enczapikey abc")
    const body = JSON.parse(init.body as string)
    expect(body.from).toEqual({ address: "hi@acme.com", name: "Acme" })
    expect(body.to).toEqual([{ email_address: { address: "user@example.com" } }])
    expect(body.textbody).toBe("hello")
  })

  it("respects trackClicks / trackOpens flags", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ message_id: "zp_1" }] }))
    const email = createEmail({
      driver: zeptomail({
        token: "Zoho-enczapikey abc",
        trackClicks: true,
        trackOpens: true,
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.track_clicks).toBe(true)
    expect(body.track_opens).toBe(true)
  })

  it("rejects tokens without the Zoho prefix", () => {
    expect(() => zeptomail({ token: "not-a-zoho-token" })).toThrow(/Zoho-enczapikey/)
  })

  it("maps 401 to AUTH", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "invalid token" } }, 401))
    const email = createEmail({
      driver: zeptomail({
        token: "Zoho-enczapikey abc",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
  })
})
