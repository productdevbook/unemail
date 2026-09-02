/** Split a list into runs of at most `size`. Providers cap how many
 *  messages one batch request may carry, and exceeding the cap fails the
 *  whole request — which the driver would then have to report against
 *  every message in it, including the ones that were fine.
 *
 * @module
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  // An empty input is no chunks, not one empty chunk — otherwise a caller
  // that loops over the result sends a request carrying nothing.
  if (items.length === 0) return []
  if (items.length <= size) return [[...items]]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * One idempotency key for a whole batch request.
 *
 * The providers take a single key per request, while a message carries its
 * own. Hashing the messages' keys gives a value that is stable for the same
 * batch and different for any other, so a retried batch is recognised as a
 * repeat instead of duplicating every message in it.
 */
export async function batchIdempotencyKey(
  keys: readonly (string | undefined)[],
): Promise<string | undefined> {
  if (!keys.some(Boolean)) return undefined
  const joined = keys.map((key) => key ?? "\u0000").join("\n")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `batch_${hex.slice(0, 32)}`
}
