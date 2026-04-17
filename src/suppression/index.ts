/**
 * Suppression store — persistent record of recipients who must not
 * receive mail. Unifies bounces, complaints, and opt-outs across every
 * driver we ship.
 *
 * @module
 */

import type { MaybePromise } from "../types.ts"

export type SuppressionReason =
  | "bounce"
  | "complaint"
  | "unsubscribed"
  | "manual"
  | "invalid"
  | string

export interface SuppressionRecord {
  recipient: string
  reason: SuppressionReason
  source?: string
  at: Date
}

export interface SuppressionStore {
  has: (recipient: string) => MaybePromise<SuppressionRecord | null>
  add: (recipient: string, reason: SuppressionReason, source?: string) => MaybePromise<void>
  remove: (recipient: string) => MaybePromise<void>
  list?: () => MaybePromise<ReadonlyArray<SuppressionRecord>>
}

/** Options for `memorySuppressionStore`. */
export interface MemorySuppressionStoreOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/** In-memory store. Recipients are normalized to lowercase. */
export function memorySuppressionStore(opts: MemorySuppressionStoreOptions = {}): SuppressionStore {
  const now = opts.now ?? Date.now
  const map = new Map<string, SuppressionRecord>()
  const key = (r: string) => r.toLowerCase().trim()
  return {
    has(recipient) {
      return map.get(key(recipient)) ?? null
    },
    add(recipient, reason, source) {
      map.set(key(recipient), { recipient, reason, source, at: new Date(now()) })
    },
    remove(recipient) {
      map.delete(key(recipient))
    },
    list() {
      return Array.from(map.values())
    },
  }
}

/** Minimal unstorage-like contract (decoupled so we don't bind the
 *  dependency). Mirrors the shape already used by `src/queue`. */
interface UnstorageLike {
  getItem: (key: string) => MaybePromise<unknown>
  setItem: (key: string, value: unknown) => MaybePromise<void>
  removeItem: (key: string) => MaybePromise<void>
  getKeys?: (base?: string) => MaybePromise<ReadonlyArray<string>>
}

/** Persist suppressions to any `unstorage` driver (KV, Redis,
 *  filesystem, …). Keys are prefixed with `suppression:`. */
export function unstorageSuppressionStore(storage: UnstorageLike): SuppressionStore {
  const prefix = "suppression:"
  const key = (r: string) => prefix + r.toLowerCase().trim()
  return {
    async has(recipient) {
      const value = await storage.getItem(key(recipient))
      if (!value) return null
      return deserialize(value)
    },
    async add(recipient, reason, source) {
      const rec: SuppressionRecord = { recipient, reason, source, at: new Date() }
      await storage.setItem(key(recipient), serialize(rec))
    },
    async remove(recipient) {
      await storage.removeItem(key(recipient))
    },
    async list() {
      if (!storage.getKeys) return []
      const keys = await storage.getKeys(prefix)
      const out: SuppressionRecord[] = []
      for (const k of keys) {
        const value = await storage.getItem(k)
        if (value) out.push(deserialize(value))
      }
      return out
    },
  }
}

function serialize(rec: SuppressionRecord): unknown {
  return { ...rec, at: rec.at.toISOString() }
}

function deserialize(value: unknown): SuppressionRecord {
  const v = value as { recipient: string; reason: string; source?: string; at: string }
  return { recipient: v.recipient, reason: v.reason, source: v.source, at: new Date(v.at) }
}
