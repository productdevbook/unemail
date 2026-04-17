/**
 * SES → SNS → webhook inbound adapter. Verifies the SNS signature,
 * handles `SubscriptionConfirmation` auto-confirm, and normalizes SES
 * Bounce/Complaint/Delivery/Received notifications.
 *
 * @module
 */

import type { ParsedEmail } from "../parse/index.ts"
import { parseEmail } from "../parse/index.ts"

export type SesInboundEvent =
  | { type: "subscription-confirm"; subscribeUrl: string }
  | { type: "bounce"; bounce: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "complaint"; complaint: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "delivery"; delivery: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "received"; email: ParsedEmail; raw: Record<string, unknown> }
  | { type: "unknown"; raw: Record<string, unknown> }

/** Parse a raw SNS envelope body (the bytes POST'd to your webhook).
 *  The SNS signature is NOT verified here — combine with
 *  `unemail/webhook/ses` if you want verification. */
export async function defineSesInboundHandler(opts?: {
  autoConfirm?: (url: string) => void | Promise<void>
}): Promise<(body: string) => Promise<SesInboundEvent>> {
  return async (body: string) => {
    let outer: Record<string, unknown>
    try {
      outer = JSON.parse(body) as Record<string, unknown>
    } catch {
      return { type: "unknown", raw: { error: "invalid JSON" } }
    }
    if (outer.Type === "SubscriptionConfirmation") {
      const url = outer.SubscribeURL as string
      if (opts?.autoConfirm) await opts.autoConfirm(url)
      return { type: "subscription-confirm", subscribeUrl: url }
    }
    const messageStr = outer.Message as string | undefined
    if (!messageStr) return { type: "unknown", raw: outer }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(messageStr) as Record<string, unknown>
    } catch {
      return { type: "unknown", raw: outer }
    }
    const notificationType = message.notificationType ?? message.eventType
    if (notificationType === "Bounce")
      return { type: "bounce", bounce: message.bounce as Record<string, unknown>, raw: message }
    if (notificationType === "Complaint")
      return {
        type: "complaint",
        complaint: message.complaint as Record<string, unknown>,
        raw: message,
      }
    if (notificationType === "Delivery")
      return {
        type: "delivery",
        delivery: message.delivery as Record<string, unknown>,
        raw: message,
      }
    if (notificationType === "Received" || message.content) {
      const raw = message.content as string | undefined
      if (raw) {
        const email = await parseEmail(raw)
        return { type: "received", email, raw: message }
      }
    }
    return { type: "unknown", raw: message }
  }
}
