/** Authentication helpers — each returns a function the connection calls
 *  with `send(command)` and `recv()` and returns on success or throws on
 *  an auth failure reply. Keeping them pure lets unit tests drive them
 *  with fake send/recv. */

import type { SmtpReply } from "./reply.ts"

export type { SmtpReply } from "./reply.ts"

export type AuthMethod = "LOGIN" | "PLAIN" | "CRAM-MD5" | "XOAUTH2"

export interface AuthContext {
  send: (line: string) => Promise<void>
  recv: () => Promise<SmtpReply>
}

/** Pick the best advertised method given caller preference + capabilities.
 *  Order reflects practical recommendations (Brevo/SendGrid/Mailgun docs): */
export function pickAuthMethod(
  advertised: ReadonlySet<string>,
  prefer: AuthMethod | "AUTO" = "AUTO",
): AuthMethod | null {
  if (prefer !== "AUTO" && advertised.has(prefer)) return prefer
  const order: AuthMethod[] = ["PLAIN", "LOGIN", "CRAM-MD5", "XOAUTH2"]
  for (const m of order) if (advertised.has(m)) return m
  return null
}

export async function authPlain(
  ctx: AuthContext,
  user: string,
  password: string,
): Promise<SmtpReply> {
  const token = b64(`\0${user}\0${password}`)
  await ctx.send(`AUTH PLAIN ${token}`)
  return ctx.recv()
}

export async function authLogin(
  ctx: AuthContext,
  user: string,
  password: string,
): Promise<SmtpReply> {
  await ctx.send("AUTH LOGIN")
  await ctx.recv() // 334 VXNlcm5hbWU6
  await ctx.send(b64(user))
  await ctx.recv() // 334 UGFzc3dvcmQ6
  await ctx.send(b64(password))
  return ctx.recv()
}

export async function authCramMd5(
  ctx: AuthContext,
  user: string,
  password: string,
  hmac: (key: string, data: string) => string,
): Promise<SmtpReply> {
  await ctx.send("AUTH CRAM-MD5")
  const challengeReply = await ctx.recv()
  const challenge = atobPolyfill(challengeReply.raw.trim())
  const digest = hmac(password, challenge)
  await ctx.send(b64(`${user} ${digest}`))
  return ctx.recv()
}

export async function authXoauth2(
  ctx: AuthContext,
  user: string,
  accessToken: string,
): Promise<SmtpReply> {
  const token = b64(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`)
  await ctx.send(`AUTH XOAUTH2 ${token}`)
  return ctx.recv()
}

function b64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const g = globalThis as {
    Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function atobPolyfill(value: string): string {
  const g = globalThis as {
    Buffer?: { from: (v: string, enc: string) => { toString: (e: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(value, "base64").toString("utf8")
  return atob(value)
}
