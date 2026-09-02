/** Base64 without a runtime dependency. Uses `Buffer` where it exists
 *  (Node, Bun) and falls back to `btoa` everywhere else (Workers, Deno,
 *  browsers) — the fallback goes through a chunked loop because
 *  `String.fromCharCode(...bytes)` blows the argument limit on anything
 *  larger than a small attachment.
 *
 * @module
 */

import type { Attachment } from "../core/types.ts"

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

/**
 * Encode attachment content for a provider that wants base64.
 *
 * A string is treated as text unless the caller says otherwise. Guessing
 * is not an option here: `"test"` is both valid text and valid base64, and
 * a wrong guess is silent — the recipient's client decodes the text into
 * three bytes of noise with no error anywhere. Set `encoding: "base64"` to
 * pass content through already encoded.
 */
export function attachmentToBase64(attachment: Attachment): string {
  if (typeof attachment.content !== "string") return bytesToBase64(attachment.content)
  return attachment.encoding === "base64" ? attachment.content : stringToBase64(attachment.content)
}
