/**
 * Thread-key derivation from RFC 5322 `Message-ID`, `In-Reply-To`,
 * and `References` headers. Given a parsed email we return a stable
 * identifier that groups messages in the same conversation.
 *
 * @module
 */

import type { ParsedEmail } from "../parse/index.ts"

export interface ThreadKeyInput {
  messageId?: string
  inReplyTo?: string
  references?: ReadonlyArray<string>
}

/** Pick the canonical root Message-ID for a parsed email. */
export function threadKey(input: ThreadKeyInput | ParsedEmail): string {
  const msg = input as ThreadKeyInput
  const refs = msg.references ?? []
  const candidates: string[] = []
  if (refs[0]) candidates.push(refs[0])
  if (msg.inReplyTo) candidates.push(msg.inReplyTo)
  if (msg.messageId) candidates.push(msg.messageId)
  const first = candidates.find(Boolean)
  if (!first) return "__no_thread__"
  return normalizeMessageId(first)
}

/** Build a deterministic adjacency list `{ root -> [member-ids] }` from
 *  a batch of parsed messages. Useful for UI grouping. */
export function buildThreads(messages: ReadonlyArray<ThreadKeyInput>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of messages) {
    const key = threadKey(m)
    const id = m.messageId ? normalizeMessageId(m.messageId) : key
    const list = out.get(key) ?? []
    list.push(id)
    out.set(key, list)
  }
  return out
}

function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "")
}
