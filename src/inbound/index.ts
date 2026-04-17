import type { ParsedEmail } from "../parse/index.ts"

/** Contract every inbound adapter implements. Each provider knows how to:
 *   - tell whether a request belongs to it (\`accepts\`),
 *   - optionally verify its signature (\`verify\`),
 *   - turn the request body into a \`ParsedEmail\` (\`parse\`). */
export interface InboundAdapter {
  readonly name: string
  accepts: (request: Request) => boolean
  verify?: (request: Request) => Promise<boolean> | boolean
  parse: (request: Request) => Promise<ParsedEmail>
}

/** Route handler returned by \`defineInboundHandler\`. Drop it into a Nitro
 *  route, a Cloudflare Worker, a Hono app, or raw \`fetch\` handler. */
export type InboundHandler = (request: Request) => Promise<Response>

export interface DefineInboundHandlerOptions {
  providers: ReadonlyArray<InboundAdapter>
  onEmail: (mail: ParsedEmail, context: InboundContext) => void | Promise<void>
  onUnknown?: (request: Request) => Promise<Response> | Response
  onVerificationFailure?: (request: Request, provider: string) => Promise<Response> | Response
}

export interface InboundContext {
  provider: string
  request: Request
}

/** Builds a fetch-style handler that accepts inbound webhooks from any
 *  registered provider and yields a unified \`ParsedEmail\` via \`onEmail\`.
 *
 *  ```ts
 *  import { defineInboundHandler } from "unemail/inbound"
 *  import sesInbound from "unemail/inbound/ses"
 *  import cfInbound from "unemail/inbound/cloudflare"
 *
 *  export default defineInboundHandler({
 *    providers: [sesInbound(), cfInbound()],
 *    onEmail(mail) { console.log(mail.subject) }
 *  })
 *  ```
 */
export function defineInboundHandler(options: DefineInboundHandlerOptions): InboundHandler {
  return async (request: Request) => {
    for (const provider of options.providers) {
      if (!provider.accepts(request.clone())) continue
      if (provider.verify && !(await provider.verify(request.clone()))) {
        return options.onVerificationFailure
          ? options.onVerificationFailure(request, provider.name)
          : new Response("invalid signature", { status: 401 })
      }
      const mail = await provider.parse(request.clone())
      await options.onEmail(mail, { provider: provider.name, request })
      return new Response("ok", { status: 200 })
    }
    return options.onUnknown
      ? options.onUnknown(request)
      : new Response("no matching inbound provider", { status: 404 })
  }
}
