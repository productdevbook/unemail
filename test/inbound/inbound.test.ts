import { describe, expect, it } from "vitest"
import { defineInboundHandler, type InboundAdapter } from "../../src/inbound/index.ts"
import postmarkInbound from "../../src/inbound/postmark.ts"

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Postmark/inbound",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe("defineInboundHandler", () => {
  it("routes to the first adapter that accepts the request", async () => {
    const recorded: string[] = []
    const sharedAdapter: InboundAdapter = {
      name: "shared",
      accepts: () => true,
      parse: async () => ({
        to: [],
        cc: [],
        bcc: [],
        references: [],
        headers: {},
        attachments: [],
        subject: "static",
      }),
    }
    const handler = defineInboundHandler({
      providers: [sharedAdapter],
      onEmail: (mail) => {
        recorded.push(mail.subject ?? "")
      },
    })
    const res = await handler(
      new Request("https://x/inbound", { method: "POST", body: "irrelevant" }),
    )
    expect(res.status).toBe(200)
    expect(recorded).toEqual(["static"])
  })

  it("returns 401 when the adapter rejects the signature", async () => {
    const handler = defineInboundHandler({
      providers: [
        {
          name: "bad",
          accepts: () => true,
          verify: () => false,
          parse: async () => ({
            to: [],
            cc: [],
            bcc: [],
            references: [],
            headers: {},
            attachments: [],
          }),
        },
      ],
      onEmail: () => {},
    })
    const res = await handler(new Request("https://x/inbound", { method: "POST", body: "" }))
    expect(res.status).toBe(401)
  })

  it("returns 404 when no adapter matches", async () => {
    const handler = defineInboundHandler({ providers: [], onEmail: () => {} })
    const res = await handler(new Request("https://x/inbound"))
    expect(res.status).toBe(404)
  })
})

describe("postmark inbound adapter", () => {
  it("maps Postmark JSON to ParsedEmail", async () => {
    const calls: Array<{ subject?: string }> = []
    const handler = defineInboundHandler({
      providers: [postmarkInbound()],
      onEmail: (mail) => {
        calls.push({ subject: mail.subject })
      },
    })
    const res = await handler(
      jsonRequest({
        MessageID: "pm_123",
        Subject: "Hello",
        FromFull: { Email: "a@b.com", Name: "Ada" },
        ToFull: [{ Email: "c@d.com" }],
        TextBody: "hi",
        Headers: [{ Name: "X-Thing", Value: "yes" }],
      }),
    )
    expect(res.status).toBe(200)
    expect(calls[0]?.subject).toBe("Hello")
  })

  it("validates basicAuth when provided", async () => {
    const handler = defineInboundHandler({
      providers: [postmarkInbound({ basicAuth: "u:p" })],
      onEmail: () => {},
    })
    const token = btoa("u:p")
    const ok = await handler(jsonRequest({ MessageID: "x" }, { authorization: `Basic ${token}` }))
    expect(ok.status).toBe(200)
    const bad = await handler(
      jsonRequest({ MessageID: "x" }, { authorization: `Basic ${btoa("u:wrong")}` }),
    )
    expect(bad.status).toBe(401)
  })
})
