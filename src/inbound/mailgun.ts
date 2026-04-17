import type { InboundAdapter } from "./index.ts"
import type { ParsedEmail } from "../parse/index.ts"
import { parseEmail } from "../parse/index.ts"
import { webCryptoHmacHex } from "../webhooks/_crypto.ts"

/** Mailgun inbound-route adapter. Mailgun sends \`multipart/form-data\`
 *  with \`body-mime\` carrying the raw message (store mode). \`token +
 *  timestamp + signature\` fields authenticate the request. */
export interface MailgunInboundOptions {
  /** Mailgun API signing key — used to verify the HMAC. */
  signingKey?: string
}

export default function mailgunInbound(options: MailgunInboundOptions = {}): InboundAdapter {
  return {
    name: "mailgun-inbound",
    accepts(request) {
      const ct = request.headers.get("content-type") ?? ""
      return request.method === "POST" && ct.startsWith("multipart/form-data")
    },
    async verify(request) {
      if (!options.signingKey) return true
      const form = await request.formData()
      const timestamp = form.get("timestamp")
      const token = form.get("token")
      const signature = form.get("signature")
      if (
        typeof timestamp !== "string" ||
        typeof token !== "string" ||
        typeof signature !== "string"
      )
        return false
      const expected = await webCryptoHmacHex("SHA-256", options.signingKey, `${timestamp}${token}`)
      return timingSafeEquals(expected, signature)
    },
    async parse(request): Promise<ParsedEmail> {
      const form = await request.formData()
      const raw = form.get("body-mime")
      if (typeof raw !== "string")
        throw new Error(
          "[unemail/inbound/mailgun] no `body-mime` field — did you enable store action on the route?",
        )
      return parseEmail(raw)
    },
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}
