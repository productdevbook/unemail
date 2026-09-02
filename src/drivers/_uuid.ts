/**
 * A UUID-shaped idempotency key.
 *
 * Several providers accept an idempotency key but insist it is a UUID —
 * Brevo's `idempotencyKey` and Azure's `Operation-Id` both reject anything
 * else. This library's own convention is a readable key like
 * `welcome:42`, so without a mapping the feature is simply unusable with
 * those providers.
 *
 * A key that already looks like a UUID passes through untouched. Anything
 * else is hashed, so the result is stable for the same key and distinct for
 * any other — which is the whole property an idempotency key needs.
 *
 * @module
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

export async function toUuid(key: string): Promise<string> {
  if (isUuid(key)) return key

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  const bytes = new Uint8Array(digest)
  // Stamp the version and variant nibbles so the result is a well-formed
  // v4, which is what a provider validating the shape looks for.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
