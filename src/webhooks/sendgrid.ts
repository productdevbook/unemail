import type { WebhookEvent, WebhookProvider } from "./index.ts"
import { b64ToBytes } from "./_crypto.ts"

/** SendGrid Event Webhook verifier. SG signs each request with ECDSA
 *  (P-256 / SHA-256):
 *   - \`X-Twilio-Email-Event-Webhook-Timestamp\`
 *   - \`X-Twilio-Email-Event-Webhook-Signature\`
 *
 *  The signature is over \`\${timestamp}\${body}\` using the account's
 *  public verification key (base64 DER). Verified via Web Crypto. */
export interface SendGridWebhookOptions {
  /** Base64-encoded SPKI public key (SendGrid's "Verification Key"). */
  publicKey: string
  toleranceSeconds?: number
  now?: () => number
}

interface SendGridEventBody {
  sg_event_id?: string
  event?: string
  email?: string
  timestamp?: number
  url?: string
  type?: string
}

export default function sendgridWebhook(options: SendGridWebhookOptions): WebhookProvider {
  const tolerance = options.toleranceSeconds ?? 300
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    name: "sendgrid",
    async verify(request) {
      if (request.method !== "POST") return null
      const timestamp = request.headers.get("x-twilio-email-event-webhook-timestamp")
      const signature = request.headers.get("x-twilio-email-event-webhook-signature")
      if (!timestamp || !signature) return null
      const ts = Number(timestamp)
      if (!Number.isFinite(ts) || Math.abs(now() - ts) > tolerance) return []
      const body = await request.text()
      const ok = await verifyEcdsa(options.publicKey, signature, `${timestamp}${body}`)
      if (!ok) return []
      const parsed = JSON.parse(body) as SendGridEventBody[]
      return parsed.map(normalize)
    },
  }
}

async function verifyEcdsa(
  publicKeyBase64: string,
  signatureBase64: string,
  message: string,
): Promise<boolean> {
  try {
    const spki = b64ToBytes(publicKeyBase64)
    const signature = derToRaw(b64ToBytes(signatureBase64))
    const key = await crypto.subtle.importKey(
      "spki",
      spki.slice() as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature.slice() as BufferSource,
      new TextEncoder().encode(message) as BufferSource,
    )
  } catch {
    return false
  }
}

/** Convert a DER-encoded ECDSA signature (SEQUENCE of two INTEGER r, s)
 *  into the raw 64-byte form Web Crypto's \`verify\` expects. */
function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("invalid DER signature")
  let offset = 2
  if (der[1]! & 0x80) offset = 2 + (der[1]! & 0x7f)
  if (der[offset] !== 0x02) throw new Error("invalid DER signature")
  const rLen = der[offset + 1]!
  const rStart = offset + 2
  const r = stripLeadingZero(der.slice(rStart, rStart + rLen), 32)
  offset = rStart + rLen
  if (der[offset] !== 0x02) throw new Error("invalid DER signature")
  const sLen = der[offset + 1]!
  const sStart = offset + 2
  const s = stripLeadingZero(der.slice(sStart, sStart + sLen), 32)
  const out = new Uint8Array(64)
  out.set(r, 32 - r.length)
  out.set(s, 64 - s.length)
  return out
}

function stripLeadingZero(bytes: Uint8Array, size: number): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const out = bytes.slice(start)
  if (out.length > size) return out.slice(out.length - size)
  return out
}

function normalize(body: SendGridEventBody): WebhookEvent {
  const type = mapType(body.event)
  const event: WebhookEvent = {
    type,
    id: body.sg_event_id ?? "",
    at: body.timestamp ? new Date(body.timestamp * 1000) : new Date(),
    recipient: body.email ?? "",
    provider: "sendgrid",
    raw: body,
  }
  if (type === "clicked" && body.url) event.url = body.url
  if (type === "bounced")
    event.bounce = body.type === "blocked" ? "hard" : body.type === "bounce" ? "hard" : "soft"
  return event
}

function mapType(raw: string | undefined): WebhookEvent["type"] {
  switch (raw) {
    case "processed":
      return "sent"
    case "delivered":
      return "delivered"
    case "open":
      return "opened"
    case "click":
      return "clicked"
    case "unsubscribe":
      return "unsubscribed"
    case "spamreport":
      return "complained"
    case "bounce":
    case "blocked":
      return "bounced"
    case "dropped":
      return "rejected"
    case "deferred":
      return "failed"
    default:
      return "other"
  }
}
