import type { WebhookEvent, WebhookProvider } from "./index.ts"
import { b64ToBytes, timingSafeEqual, webCryptoHmacHex, bytesToHex } from "./_crypto.ts"

/** Resend webhook verifier. Resend uses the Svix signature format:
 *   - \`svix-id\`:        unique id
 *   - \`svix-timestamp\`: unix seconds
 *   - \`svix-signature\`: space-separated \`v1,<base64>\` tokens
 *
 *  The message HMAC'd is \`\${svix-id}.\${svix-timestamp}.\${body}\`.
 *
 *  The secret must be provided with or without Svix's \`whsec_\` prefix. */
export interface ResendWebhookOptions {
  secret: string
  /** Window in seconds to accept messages from. Default: 300. */
  toleranceSeconds?: number
  now?: () => number
}

export default function resendWebhook(options: ResendWebhookOptions): WebhookProvider {
  const secret = options.secret.replace(/^whsec_/, "")
  const tolerance = options.toleranceSeconds ?? 300
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    name: "resend",
    async verify(request) {
      const id = request.headers.get("svix-id")
      const timestamp = request.headers.get("svix-timestamp")
      const signatureHeader = request.headers.get("svix-signature")
      if (!id || !timestamp || !signatureHeader) return null
      const ts = Number(timestamp)
      if (!Number.isFinite(ts) || Math.abs(now() - ts) > tolerance) return []
      const body = await request.text()
      const message = `${id}.${timestamp}.${body}`
      const expected = await svixHmacBase64(secret, message)
      const provided = signatureHeader.split(" ").flatMap((s) => {
        const [version, value] = s.split(",")
        return version === "v1" && value ? [value] : []
      })
      if (!provided.some((sig) => timingSafeEqual(sig, expected))) return []
      const parsed = JSON.parse(body) as ResendWebhookBody
      return [normalize(parsed)]
    },
  }
}

async function svixHmacBase64(secret: string, message: string): Promise<string> {
  // Svix secrets are base64-encoded; we HMAC-SHA256 with the raw bytes.
  const rawKey = b64ToBytes(secret)
  const keyUint8 = rawKey.slice() as Uint8Array
  const key = await crypto.subtle.importKey(
    "raw",
    keyUint8 as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message) as BufferSource,
  )
  // Base64 encode the raw hash bytes.
  return bytesToBase64(new Uint8Array(sig))
}

function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as {
    Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

interface ResendWebhookBody {
  type?: string
  created_at?: string
  data?: {
    email_id?: string
    to?: string[] | string
    from?: string
    click?: { link?: string }
    bounce?: { bounceType?: string }
  }
}

function normalize(body: ResendWebhookBody): WebhookEvent {
  const type = mapType(body.type)
  const data = body.data ?? {}
  const recipient = Array.isArray(data.to) ? (data.to[0] ?? "") : (data.to ?? "")
  const event: WebhookEvent = {
    type,
    id: data.email_id ?? "",
    at: body.created_at ? new Date(body.created_at) : new Date(),
    recipient,
    provider: "resend",
    raw: body,
  }
  if (type === "clicked" && data.click?.link) event.url = data.click.link
  if (type === "bounced" && data.bounce?.bounceType)
    event.bounce = data.bounce.bounceType === "Permanent" ? "hard" : "soft"
  return event
}

function mapType(raw: string | undefined): WebhookEvent["type"] {
  if (!raw) return "other"
  if (raw.endsWith(".sent")) return "sent"
  if (raw.endsWith(".delivered")) return "delivered"
  if (raw.endsWith(".bounced")) return "bounced"
  if (raw.endsWith(".complained")) return "complained"
  if (raw.endsWith(".opened")) return "opened"
  if (raw.endsWith(".clicked")) return "clicked"
  if (raw.endsWith(".failed") || raw.endsWith(".delivery_delayed")) return "failed"
  return "other"
}

// Re-export for test reuse.
export { webCryptoHmacHex, bytesToHex }
