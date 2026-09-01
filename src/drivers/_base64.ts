/** Base64 without a runtime dependency. Uses `Buffer` where it exists
 *  (Node, Bun) and falls back to `btoa` everywhere else (Workers, Deno,
 *  browsers) — the fallback goes through a chunked loop because
 *  `String.fromCharCode(...bytes)` blows the argument limit on anything
 *  larger than a small attachment.
 *
 * @module
 */

interface BufferGlobal {
  Buffer?: {
    from: (
      input: Uint8Array | string,
      encoding?: string,
    ) => { toString: (encoding: string) => string }
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const buffer = (globalThis as BufferGlobal).Buffer
  if (buffer) return buffer.from(bytes).toString("base64")

  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function stringToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
}

/** Whether a string is already base64, so an attachment handed to us
 *  pre-encoded is not encoded twice. */
export function isBase64(value: string): boolean {
  const compact = value.replace(/[\r\n]/g, "")
  return compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
}

/** Encode attachment content for a provider that wants base64. */
export function attachmentToBase64(content: string | Uint8Array): string {
  if (typeof content !== "string") return bytesToBase64(content)
  return isBase64(content) ? content : stringToBase64(content)
}
