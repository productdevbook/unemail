/**
 * Preference store — decides whether `(recipient, category)` is
 * allowed to receive a message. Mirrors the Novu/Knock/Courier
 * primitive, scoped to the narrow "preference center" use case.
 *
 * @module
 */

import type { MaybePromise } from "../types.ts"

export interface PreferenceRecord {
  recipient: string
  category: string
  allowed: boolean
  updatedAt: Date
}

export interface PreferenceStore {
  /** Defaults to allowed=true when no record exists. */
  allows: (recipient: string, category: string) => MaybePromise<boolean>
  set: (recipient: string, category: string, allowed: boolean) => MaybePromise<void>
  list?: (recipient: string) => MaybePromise<ReadonlyArray<PreferenceRecord>>
}

export interface MemoryPreferenceStoreOptions {
  now?: () => number
  /** Default value when no record exists. Defaults to true (allow). */
  defaultAllowed?: boolean
}

export function memoryPreferenceStore(opts: MemoryPreferenceStoreOptions = {}): PreferenceStore {
  const now = opts.now ?? Date.now
  const def = opts.defaultAllowed ?? true
  const map = new Map<string, PreferenceRecord>()
  const key = (r: string, c: string) => `${r.toLowerCase().trim()}|${c}`
  return {
    allows(recipient, category) {
      const rec = map.get(key(recipient, category))
      return rec ? rec.allowed : def
    },
    set(recipient, category, allowed) {
      map.set(key(recipient, category), {
        recipient,
        category,
        allowed,
        updatedAt: new Date(now()),
      })
    },
    list(recipient) {
      const prefix = `${recipient.toLowerCase().trim()}|`
      return Array.from(map.values()).filter((r) => key(r.recipient, r.category).startsWith(prefix))
    },
  }
}
