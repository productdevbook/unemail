/** Shared Web-Crypto helpers for the webhook + inbound verifiers. Kept
 *  tiny and zero-dep so every entry that wants HMAC/HEX can reach for it
 *  without dragging Node's crypto module. */

const encoder = new TextEncoder()

/** HMAC-<alg> with a secret + message → hex string. */
export async function webCryptoHmacHex(
  algorithm: "SHA-1" | "SHA-256" | "SHA-512",
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message) as BufferSource)
  return bytesToHex(new Uint8Array(sig))
}

/** Constant-time string equality — used everywhere signatures are
 *  compared. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

export function b64ToBytes(value: string): Uint8Array {
  const g = globalThis as { Buffer?: { from: (v: string, enc: string) => Uint8Array } }
  if (g.Buffer) return g.Buffer.from(value, "base64")
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
