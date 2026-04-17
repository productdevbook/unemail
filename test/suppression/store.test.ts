import { describe, expect, it } from "vitest"
import { memorySuppressionStore, unstorageSuppressionStore } from "../../src/suppression/index.ts"

describe("memorySuppressionStore", () => {
  it("stores and retrieves suppression records", async () => {
    const store = memorySuppressionStore()
    await store.add("ada@acme.com", "bounce", "ses-webhook")
    const rec = await store.has("ada@acme.com")
    expect(rec?.reason).toBe("bounce")
    expect(rec?.source).toBe("ses-webhook")
  })

  it("is case-insensitive", async () => {
    const store = memorySuppressionStore()
    await store.add("Ada@ACME.com", "bounce")
    expect(await store.has("ada@acme.com")).not.toBeNull()
  })

  it("remove() deletes the record", async () => {
    const store = memorySuppressionStore()
    await store.add("a@b.com", "bounce")
    await store.remove("a@b.com")
    expect(await store.has("a@b.com")).toBeNull()
  })

  it("list() enumerates all records", async () => {
    const store = memorySuppressionStore()
    await store.add("a@b.com", "bounce")
    await store.add("c@d.com", "complaint")
    const all = await store.list!()
    expect(all).toHaveLength(2)
  })
})

describe("unstorageSuppressionStore", () => {
  function fakeStorage() {
    const map = new Map<string, unknown>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: unknown) => {
        map.set(k, v)
      },
      removeItem: (k: string) => {
        map.delete(k)
      },
      getKeys: (prefix?: string) =>
        Array.from(map.keys()).filter((k) => !prefix || k.startsWith(prefix)),
    }
  }

  it("round-trips records through an unstorage-like backend", async () => {
    const store = unstorageSuppressionStore(fakeStorage())
    await store.add("a@b.com", "bounce", "ses")
    const rec = await store.has("a@b.com")
    expect(rec).not.toBeNull()
    expect(rec!.reason).toBe("bounce")
    expect(rec!.at).toBeInstanceOf(Date)
  })
})
