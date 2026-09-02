import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import azureCommunication from "../../src/drivers/azure-communication.ts"
import { parseConnectionString } from "../../src/drivers/_azure/sign.ts"

/**
 * The signature here is never compared against the signer's own output. The
 * string-to-sign is rebuilt from Microsoft's published scheme
 * (https://learn.microsoft.com/en-us/azure/communication-services/tutorials/hmac-header-tutorial)
 * and the HMAC is checked with `crypto.subtle.verify`, so agreement is
 * evidence that Azure would accept the request rather than evidence that
 * the code agrees with itself.
 */

const ACCESS_KEY = Buffer.from("unemail-test-access-key").toString("base64")
const ENDPOINT = "https://acme.europe.communication.azure.com"
const CONNECTION_STRING = `endpoint=${ENDPOINT}/;accesskey=${ACCESS_KEY}`
const SEND_URL = `${ENDPOINT}/emails:send?api-version=2025-09-01`
/** SHA-256 of the empty string, base64 — what a bodiless GET signs. */
const EMPTY_SHA256 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  raw: string
  body: any
  signal?: AbortSignal | null
}

/** Records every request and answers with a scripted status, body and
 *  response headers. */
function stub(
  script: (url: string, init: RequestInit) => [number, unknown, Record<string, string>?],
) {
  const calls: Call[] = []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const [status, payload, headers = {}] = script(url, init)
    const raw = typeof init.body === "string" ? init.body : ""
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      raw,
      body: raw ? JSON.parse(raw) : undefined,
      signal: init.signal,
    })
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const accepted = (id = "8540c0de-899f-5cce-acb5-3ec493af3800") =>
  stub(() => [
    202,
    { id, status: "Running" },
    {
      "operation-location": `${ENDPOINT}/emails/operations/${id}?api-version=2025-09-01`,
      "retry-after": "20",
    },
  ])

function driver(over: Record<string, unknown> = {}) {
  return azureCommunication({ connectionString: CONNECTION_STRING, ...over })
}

// ---------------------------------------------------------------------------
// The signing scheme, re-derived from Microsoft's documentation.
// ---------------------------------------------------------------------------

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Buffer.from(new Uint8Array(digest)).toString("base64")
}

/** `{VERB}\n{path and query}\n{x-ms-date};{host};{x-ms-content-sha256}` */
function stringToSign(call: Call, contentHash: string): string {
  const url = new URL(call.url)
  return [
    call.method,
    `${url.pathname}${url.search}`,
    `${call.headers["x-ms-date"]};${url.host};${contentHash}`,
  ].join("\n")
}

/** Verify — not recompute — the HMAC the driver sent. */
async function verify(call: Call, signed: string, key = ACCESS_KEY): Promise<boolean> {
  const signature = /&Signature=(.+)$/.exec(call.headers.authorization ?? "")?.[1]
  if (!signature) return false
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(key, "base64")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    new Uint8Array(Buffer.from(signature, "base64")),
    new TextEncoder().encode(signed),
  )
}

describe("the HMAC-SHA256 signature", () => {
  it("verifies against the string-to-sign the scheme prescribes", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    const call = s.calls[0]!

    // The content hash is the base64 SHA-256 of the exact bytes sent.
    const contentHash = await sha256Base64(call.raw)
    expect(call.headers["x-ms-content-sha256"]).toBe(contentHash)

    expect(call.headers.authorization).toMatch(
      /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/,
    )
    await expect(verify(call, stringToSign(call, contentHash))).resolves.toBe(true)
  })

  it("signs the date as RFC 1123 in UTC", async () => {
    const s = accepted()
    await createEmail({
      driver: driver({ fetch: s.fetch, now: () => new Date(Date.UTC(2026, 8, 1, 12, 30, 5)) }),
      defaults,
    }).send(msg)

    expect(s.calls[0]!.headers["x-ms-date"]).toBe("Tue, 01 Sep 2026 12:30:05 GMT")
  })

  it("does not verify against a tampered body, host, path or date", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    const call = s.calls[0]!
    const contentHash = await sha256Base64(call.raw)

    const variants = [
      stringToSign(call, await sha256Base64(`${call.raw} `)),
      stringToSign(
        { ...call, url: `${ENDPOINT.replace("acme", "evil")}/emails:send` },
        contentHash,
      ),
      stringToSign({ ...call, method: "PUT" }, contentHash),
      stringToSign(
        { ...call, headers: { ...call.headers, "x-ms-date": "Tue, 01 Sep 2026 00:00:00 GMT" } },
        contentHash,
      ),
    ]
    for (const variant of variants) {
      await expect(verify(call, variant)).resolves.toBe(false)
    }
  })

  it("does not verify under a different access key", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    const call = s.calls[0]!
    const other = Buffer.from("some-other-access-key!!").toString("base64")
    await expect(
      verify(call, stringToSign(call, await sha256Base64(call.raw)), other),
    ).resolves.toBe(false)
  })

  it("signs a bodiless GET with the hash of the empty string", async () => {
    const s = stub(() => [200, { id: "op-1", status: "Succeeded" }])
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).retrieve("op-1")
    const call = s.calls[0]!

    expect(call.method).toBe("GET")
    expect(call.headers["x-ms-content-sha256"]).toBe(EMPTY_SHA256)
    await expect(verify(call, stringToSign(call, EMPTY_SHA256))).resolves.toBe(true)
  })

  it("covers the query string, so the api-version cannot be swapped", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    const call = s.calls[0]!
    const contentHash = await sha256Base64(call.raw)
    const withoutQuery = stringToSign({ ...call, url: `${ENDPOINT}/emails:send` }, contentHash)
    await expect(verify(call, withoutQuery)).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("connection strings", () => {
  it("parses what the portal prints, in either case, and trims the endpoint", () => {
    expect(parseConnectionString(CONNECTION_STRING)).toEqual({
      endpoint: ENDPOINT,
      accessKey: ACCESS_KEY,
    })
    expect(parseConnectionString(` AccessKey=${ACCESS_KEY} ; EndPoint=${ENDPOINT}// ;`)).toEqual({
      endpoint: ENDPOINT,
      accessKey: ACCESS_KEY,
    })
  })

  it("rejects a malformed one instead of signing with a broken key", () => {
    const bad = [
      "",
      "endpoint=https://x.communication.azure.com",
      `accesskey=${ACCESS_KEY}`,
      `endpoint=https://x.communication.azure.com;accesskey=not base64!`,
      `endpoint=https://x.communication.azure.com;accesskey=abc`,
      `endpoint=ftp://x.communication.azure.com;accesskey=${ACCESS_KEY}`,
      `endpoint=not-a-url;accesskey=${ACCESS_KEY}`,
      `endpoint=https://x.communication.azure.com;justnoise;accesskey=${ACCESS_KEY}`,
    ]
    for (const value of bad) expect(parseConnectionString(value)).toBeNull()
  })

  it("fails at construction rather than on the first send", () => {
    expect(() => azureCommunication({ connectionString: "nonsense" })).toThrow(
      /malformed connection string/,
    )
    expect(() => azureCommunication({})).toThrow(/missing required option/)
    expect(() => azureCommunication({ endpoint: ENDPOINT, accessKey: "not base64!" })).toThrow(
      /base64 key/,
    )
  })

  it("accepts an explicit endpoint and access key", async () => {
    const s = accepted()
    const email = createEmail({
      driver: azureCommunication({
        endpoint: `${ENDPOINT}/`,
        accessKey: ACCESS_KEY,
        fetch: s.fetch,
      }),
      defaults,
    })
    const { error } = await email.send(msg)
    expect(error).toBeNull()
    expect(s.calls[0]!.url).toBe(SEND_URL)
  })

  it("falls back to COMMUNICATION_SERVICES_CONNECTION_STRING", async () => {
    const previous = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING
    process.env.COMMUNICATION_SERVICES_CONNECTION_STRING = CONNECTION_STRING
    try {
      const s = accepted()
      const { error } = await createEmail({
        driver: azureCommunication({ fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(error).toBeNull()
      expect(s.calls[0]!.url).toBe(SEND_URL)
    } finally {
      if (previous == null) delete process.env.COMMUNICATION_SERVICES_CONNECTION_STRING
      else process.env.COMMUNICATION_SERVICES_CONNECTION_STRING = previous
    }
  })
})

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

describe("the request body", () => {
  it("maps the message onto Azure's schema", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
      ...msg,
      cc: "Cee <cc@x.com>",
      bcc: "bcc@x.com",
      replyTo: "Support <reply@acme.com>",
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
      tags: [{ name: "campaign", value: "welcome" }],
      attachments: [
        { filename: "note.txt", content: "test", contentType: "text/plain" },
        { filename: "logo.png", content: new Uint8Array([1, 2, 3]), cid: "logo" },
      ],
    })

    const call = s.calls[0]!
    expect(call.url).toBe(SEND_URL)
    expect(call.method).toBe("POST")
    expect(call.body).toEqual({
      senderAddress: "hi@acme.com",
      recipients: {
        to: [{ address: "ada@example.com", displayName: "Ada" }],
        cc: [{ address: "cc@x.com", displayName: "Cee" }],
        bcc: [{ address: "bcc@x.com" }],
      },
      content: { subject: "hi", plainText: "hello", html: "<p>hi</p>" },
      replyTo: [{ address: "reply@acme.com", displayName: "Support" }],
      headers: {
        "X-Campaign": "welcome",
        "X-Metadata-userId": "42",
        "X-Tag-campaign": "welcome",
      },
      attachments: [
        { name: "note.txt", contentType: "text/plain", contentInBase64: "dGVzdA==" },
        {
          name: "logo.png",
          contentType: "application/octet-stream",
          contentInBase64: "AQID",
          contentId: "logo",
        },
      ],
    })
  })

  it("omits every optional field the message did not set", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
      to: "a@x.com",
      subject: "s",
      text: "t",
    })
    expect(s.calls[0]!.body).toEqual({
      senderAddress: "hi@acme.com",
      recipients: { to: [{ address: "a@x.com" }] },
      content: { subject: "s", plainText: "t" },
    })
  })

  it("maps tracking onto the one switch Azure has", async () => {
    const off = accepted()
    await createEmail({ driver: driver({ fetch: off.fetch }), defaults }).send({
      ...msg,
      tracking: { opens: false, clicks: false },
    })
    expect(off.calls[0]!.body.userEngagementTrackingDisabled).toBe(true)

    const on = accepted()
    await createEmail({ driver: driver({ fetch: on.fetch }), defaults }).send({
      ...msg,
      tracking: { opens: true },
    })
    expect(on.calls[0]!.body.userEngagementTrackingDisabled).toBe(false)

    const perDriver = accepted()
    await createEmail({
      driver: driver({ fetch: perDriver.fetch, userEngagementTrackingDisabled: true }),
      defaults,
    }).send(msg)
    expect(perDriver.calls[0]!.body.userEngagementTrackingDisabled).toBe(true)
  })

  it("refuses a request over Azure's 10 MB cap before it is signed or sent", async () => {
    const s = accepted()
    const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [{ filename: "big.bin", content: new Uint8Array(8 * 1024 * 1024) }],
    })

    expect(error?.code).toBe("INVALID_OPTIONS")
    expect(error?.message).toMatch(/at most 10485760/)
    expect(s.calls).toHaveLength(0)
  })

  it("sends a request just under the cap", async () => {
    const s = accepted()
    const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [{ filename: "big.bin", content: new Uint8Array(7 * 1024 * 1024) }],
    })
    expect(error).toBeNull()
    expect(s.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The long-running operation
// ---------------------------------------------------------------------------

describe("the 202 accepted flow", () => {
  it("returns the operation id and keeps the operation URL on the result", async () => {
    const s = accepted("11111111-2222-3333-4444-555555555555")
    const { data } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)

    expect(data?.id).toBe("11111111-2222-3333-4444-555555555555")
    expect(data?.provider).toMatchObject({
      id: "11111111-2222-3333-4444-555555555555",
      status: "Running",
      operationLocation: `${ENDPOINT}/emails/operations/11111111-2222-3333-4444-555555555555?api-version=2025-09-01`,
      retryAfter: "20",
    })
  })

  it("falls back to the id in Operation-Location when the body carries none", async () => {
    const s = stub(() => [
      202,
      null,
      { "operation-location": `${ENDPOINT}/emails/operations/from-header?api-version=2025-09-01` },
    ])
    const { data } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    expect(data?.id).toBe("from-header")
  })

  it("fails loudly when neither the body nor the headers name the operation", async () => {
    const s = stub(() => [202, null])
    const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/no operation id/)
  })
})

describe("retrieve", () => {
  it("polls the operation and maps every Azure status onto a state", async () => {
    const cases = [
      ["NotStarted", "queued"],
      ["Running", "queued"],
      ["Succeeded", "sent"],
      ["Failed", "failed"],
      ["Canceled", "cancelled"],
      ["SomethingNew", "unknown"],
      [undefined, "unknown"],
    ] as const

    for (const [status, state] of cases) {
      const s = stub(() => [200, { id: "op-9", ...(status ? { status } : {}) }])
      const { data } = await createEmail({
        driver: driver({ fetch: s.fetch }),
        defaults,
      }).retrieve("op-9")

      expect(s.calls[0]!.url).toBe(`${ENDPOINT}/emails/operations/op-9?api-version=2025-09-01`)
      expect(data).toMatchObject({ id: "op-9", driver: "azure-communication", state })
    }
  })

  it("keeps Azure's error detail on a failed operation", async () => {
    const s = stub(() => [
      200,
      {
        id: "op-9",
        status: "Failed",
        error: { code: "EmailDropped", message: "Email was dropped after several attempts." },
      },
    ])
    const { data } = await createEmail({
      driver: driver({ fetch: s.fetch }),
      defaults,
    }).retrieve("op-9")

    expect(data?.state).toBe("failed")
    expect(data?.provider).toMatchObject({ error: { code: "EmailDropped" } })
  })

  it("percent-encodes the id it is given", async () => {
    const s = stub(() => [200, { id: "x", status: "Succeeded" }])
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).retrieve("a/../b")
    expect(s.calls[0]!.url).toBe(`${ENDPOINT}/emails/operations/a%2F..%2Fb?api-version=2025-09-01`)
  })
})

describe("idempotency", () => {
  it("passes a UUID key through as Operation-Id", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
      ...msg,
      idempotencyKey: "F9168C5E-CEB2-4FAA-B6BF-329BF39FA1E4",
    })
    expect(s.calls[0]!.headers["operation-id"]).toBe("F9168C5E-CEB2-4FAA-B6BF-329BF39FA1E4")
  })

  it("hashes a free-form key into a stable UUID, because Azure takes nothing else", async () => {
    const send = async () => {
      const s = accepted()
      await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
        ...msg,
        idempotencyKey: "welcome:1",
      })
      return s.calls[0]!.headers["operation-id"]!
    }

    const first = await send()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await send()).toBe(first)

    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
      ...msg,
      idempotencyKey: "welcome:2",
    })
    expect(s.calls[0]!.headers["operation-id"]).not.toBe(first)
  })

  it("sends no Operation-Id when the message asked for none", async () => {
    const s = accepted()
    await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    expect(s.calls[0]!.headers["operation-id"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("error classification", () => {
  const failure = (status: number, code?: string, message = "nope") =>
    stub(() => [status, code == null ? null : { error: { code, message } }])

  it("reads the reason out of Azure's nested error envelope", async () => {
    const s = failure(400, "InvalidSenderAddress", "The sender address is not verified.")
    const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("The sender address is not verified.")
    expect(error?.retryable).toBe(false)
  })

  it("treats an authentication code as AUTH whatever the status says", async () => {
    const s = failure(400, "Unauthorized", "signature did not match")
    const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
  })

  it("treats a throttling code as a retryable RATE_LIMIT", async () => {
    const s = failure(400, "TooManyRequests", "slow down")
    const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(msg)
    expect(error?.code).toBe("RATE_LIMIT")
    expect(error?.retryable).toBe(true)
  })

  it("falls back to the status when the body says nothing", async () => {
    for (const [status, code] of [
      [401, "AUTH"],
      [429, "RATE_LIMIT"],
      [503, "NETWORK"],
    ] as const) {
      const s = failure(status)
      const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send(
        msg,
      )
      expect(error?.code).toBe(code)
      expect(error?.status).toBe(status)
    }
  })

  it("refuses a remote attachment rather than sending an empty part", async () => {
    const s = accepted()
    const { error } = await createEmail({ driver: driver({ fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [{ filename: "remote.pdf", url: "https://files.example.com/remote.pdf" }],
    })
    expect(error?.code).toBe("UNSUPPORTED")
    expect(s.calls).toHaveLength(0)
  })

  it("refuses a templated send, which Azure has no equivalent for", async () => {
    const { error } = await createEmail({ driver: driver(), defaults }).send({
      to: "a@x.com",
      template: { alias: "welcome" },
    })
    expect(error?.code).toBe("UNSUPPORTED")
    expect(error?.message).toContain("`template`")
  })

  it("forwards the caller's signal, so an abort cancels the in-flight request", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response(JSON.stringify({ id: "op-1", status: "Running" }), { status: 202 })
    }) as unknown as typeof fetch

    await createEmail({
      driver: driver({ fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)

    expect(aborted).toBe(true)
  })

  it("never reaches the network for an already-aborted send", async () => {
    const s = accepted()
    const { error } = await createEmail({
      driver: driver({ fetch: s.fetch }),
      defaults,
      signal: AbortSignal.abort(),
    }).send(msg)

    expect(error?.code).toBe("CANCELLED")
    expect(s.calls).toHaveLength(0)
  })
})
