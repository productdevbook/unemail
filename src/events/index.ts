/**
 * Unified `EmailEvent` stream that merges send-side events (queued,
 * attempt, success, error) with webhook-side events (delivered, opened,
 * clicked, bounced, complained, unsubscribed).
 *
 * Feeds observability dashboards and audit logs without the consumer
 * having to stitch webhook + send sources by hand.
 *
 * @module
 */

import type { EmailDriver, Middleware } from "../types.ts"

export type EmailEventType =
  | "send.queued"
  | "send.attempt"
  | "send.success"
  | "send.error"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "unsubscribed"
  | "spam_reported"

export interface EmailEvent {
  type: EmailEventType
  messageId?: string
  recipient?: string
  provider: string
  at: Date
  meta?: Record<string, unknown>
}

export interface EventStore {
  append: (event: EmailEvent) => void | Promise<void>
  list?: (messageId: string) => EmailEvent[] | Promise<EmailEvent[]>
}

export interface MemoryEventStoreOptions {
  capacity?: number
}

export function memoryEventStore(opts: MemoryEventStoreOptions = {}): EventStore {
  const capacity = opts.capacity ?? 10_000
  const events: EmailEvent[] = []
  return {
    append(event) {
      events.push(event)
      if (events.length > capacity) events.shift()
    },
    list(messageId) {
      return events.filter((e) => e.messageId === messageId)
    },
  }
}

/** Emit `send.*` events around a driver's send call. Pair with webhook
 *  ingestion (which already emits delivered/opened/bounced etc.) by
 *  piping both into the same store. */
export function withEvents(
  driver: EmailDriver,
  bus: { emit: (event: EmailEvent) => void },
): EmailDriver {
  return {
    ...driver,
    async send(msg, ctx) {
      const recipient = typeof msg.to === "string" ? msg.to : undefined
      bus.emit({
        type: "send.queued",
        recipient,
        provider: driver.name,
        at: new Date(),
        meta: { attempt: ctx.attempt },
      })
      bus.emit({
        type: "send.attempt",
        recipient,
        provider: driver.name,
        at: new Date(),
        meta: { attempt: ctx.attempt },
      })
      const result = await driver.send(msg, ctx)
      bus.emit({
        type: result.error ? "send.error" : "send.success",
        messageId: result.data?.id,
        recipient,
        provider: driver.name,
        at: new Date(),
        meta: { error: result.error?.code },
      })
      return result
    },
  }
}

/** Tiny event bus: emit → listeners. Plug a store as a listener. */
export class EventBus {
  private listeners: Array<(event: EmailEvent) => void> = []
  emit(event: EmailEvent): void {
    for (const l of this.listeners) l(event)
  }
  on(listener: (event: EmailEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }
}

/** Observability middleware — wires `EmailMessage` beforeSend/afterSend
 *  into a user-supplied event bus. Alternative to `withEvents` when
 *  you want a Middleware shape. */
export function eventsMiddleware(bus: EventBus): Middleware {
  return {
    name: "events",
    beforeSend(msg, ctx) {
      bus.emit({
        type: "send.queued",
        provider: ctx.driver,
        recipient: typeof msg.to === "string" ? msg.to : undefined,
        at: new Date(),
      })
    },
    afterSend(msg, ctx, result) {
      bus.emit({
        type: result.error ? "send.error" : "send.success",
        messageId: result.data?.id,
        provider: ctx.driver,
        recipient: typeof msg.to === "string" ? msg.to : undefined,
        at: new Date(),
        meta: { error: result.error?.code },
      })
    },
  }
}
