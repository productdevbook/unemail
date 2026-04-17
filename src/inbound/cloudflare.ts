import type { InboundAdapter } from "./index.ts"
import { parseEmail } from "../parse/index.ts"

/** Cloudflare Email Workers inbound adapter.
 *
 *  The CF Email Worker handler gets a \`message\` object; the route adapter
 *  here also accepts a plain \`Request\` whose \`x-cf-email-raw\` header
 *  signals that the body is the raw MIME. Use it when proxying CF Email
 *  Workers through a normal \`fetch\` handler — otherwise call
 *  \`parseEmail(await message.raw())\` directly in your Worker. */
export interface CloudflareInboundOptions {
  /** Header name that carries a pre-agreed shared secret. Default: none —
   *  verification is disabled unless set. */
  secretHeader?: string
  secret?: string
}

export default function cloudflareInbound(options: CloudflareInboundOptions = {}): InboundAdapter {
  return {
    name: "cloudflare",
    accepts(request) {
      return request.headers.get("x-cf-email-raw") != null
    },
    verify(request) {
      if (!options.secretHeader || !options.secret) return true
      return request.headers.get(options.secretHeader) === options.secret
    },
    async parse(request) {
      const buffer = await request.arrayBuffer()
      return parseEmail(new Uint8Array(buffer))
    },
  }
}
