import type { InboundAdapter } from "./index.ts"
import { parseEmail } from "../parse/index.ts"

/** SendGrid Inbound Parse adapter. SG posts \`multipart/form-data\`; the
 *  \`email\` field is the raw MIME message. */
export interface SendGridInboundOptions {
  /** Optional shared secret verified via a custom header. */
  secret?: string
  secretHeader?: string
}

export default function sendgridInbound(options: SendGridInboundOptions = {}): InboundAdapter {
  return {
    name: "sendgrid-inbound",
    accepts(request) {
      const ct = request.headers.get("content-type") ?? ""
      return request.method === "POST" && ct.startsWith("multipart/form-data")
    },
    verify(request) {
      if (!options.secret || !options.secretHeader) return true
      return request.headers.get(options.secretHeader) === options.secret
    },
    async parse(request) {
      const form = await request.formData()
      const raw = form.get("email")
      if (typeof raw !== "string")
        throw new Error("[unemail/inbound/sendgrid] no `email` field in multipart body")
      return parseEmail(raw)
    },
  }
}
