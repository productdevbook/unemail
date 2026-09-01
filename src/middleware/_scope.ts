import type { SendContext } from "../core/types.ts"

/**
 * The key that separates one destination's state from another's.
 *
 * Middleware registered with `email.use()` wraps every mounted driver, so
 * any state it keeps — a token bucket, a breaker's failure count — has to
 * be partitioned or one provider's trouble becomes every provider's.
 *
 * Stream is part of the key because a provider can rate-limit its streams
 * separately: Postmark's broadcast stream has its own allowance, and a
 * burst of newsletters should not throttle password resets.
 *
 * @module
 */
export function scopeKey(ctx: SendContext): string {
  return ctx.stream ? `${ctx.driver}:${ctx.stream}` : ctx.driver
}

/** Fetch the state for this destination, creating it on first use. */
export function scoped<T>(states: Map<string, T>, ctx: SendContext, create: () => T): T {
  const key = scopeKey(ctx)
  let state = states.get(key)
  if (!state) {
    state = create()
    states.set(key, state)
  }
  return state
}
