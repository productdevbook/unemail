/** Unified webhook event schema that every provider verifier normalizes
 *  into. Consumers get one shape regardless of which SDK the upstream
 *  vendor ships. */

export type WebhookEventType =
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "unsubscribed"
  | "rejected"
  | "failed"
  | "other"

export interface WebhookEvent {
  type: WebhookEventType
  id: string
  at: Date
  recipient: string
  provider: string
  /** Provider-native payload, preserved for drivers that surface extra
   *  fields (bounce diagnostics, click URLs, etc.). */
  raw: unknown
  /** For \`clicked\` events — the URL the recipient clicked. */
  url?: string
  /** For \`bounced\` events — bounce classification (\`"hard"\` / \`"soft"\`
   *  / \`"unknown"\`). */
  bounce?: "hard" | "soft" | "unknown"
}

/** A provider-specific verifier that can normalize one webhook request
 *  into one or more \`WebhookEvent\`s. */
export interface WebhookProvider {
  readonly name: string
  verify: (request: Request) => Promise<WebhookEvent[] | null> | WebhookEvent[] | null
}

/** Handler returned by \`defineWebhookHandler\`. */
export type WebhookHandler = (request: Request) => Promise<Response>

export interface DefineWebhookHandlerOptions {
  providers: ReadonlyArray<WebhookProvider>
  onEvent: (
    event: WebhookEvent,
    context: { provider: string; request: Request },
  ) => void | Promise<void>
  onUnknown?: (request: Request) => Promise<Response> | Response
  onVerificationFailure?: (request: Request, provider: string) => Promise<Response> | Response
}

/** Build a fetch-compatible handler that accepts webhook payloads from
 *  any registered provider, verifies signatures, and yields unified
 *  \`WebhookEvent\`s via \`onEvent\`. */
export function defineWebhookHandler(options: DefineWebhookHandlerOptions): WebhookHandler {
  return async (request: Request) => {
    for (const provider of options.providers) {
      const events = await provider.verify(request.clone())
      if (events == null) continue
      if (events.length === 0) {
        return options.onVerificationFailure
          ? options.onVerificationFailure(request, provider.name)
          : new Response("invalid signature", { status: 401 })
      }
      for (const event of events) {
        await options.onEvent(event, { provider: provider.name, request })
      }
      return new Response("ok", { status: 200 })
    }
    return options.onUnknown
      ? options.onUnknown(request)
      : new Response("no matching webhook provider", { status: 404 })
  }
}
