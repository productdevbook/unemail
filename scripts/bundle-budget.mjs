#!/usr/bin/env node
// Bundle-size budget check. Raw (pre-gzip) byte size.
// Bump deliberately when a real feature requires it.

import { readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"

const DIST = resolve(process.cwd(), "dist")

const BUDGETS = [
  { glob: /^index\.mjs$/, max: 8192, label: "core" },
  { glob: /^drivers\/.+\.mjs$/, max: 16384, label: "driver" },
]

async function* walk(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield* walk(fullPath, rel)
    } else if (entry.name.endsWith(".mjs")) {
      yield { path: fullPath, rel }
    }
  }
}

const failures = []
const summary = []

for await (const file of walk(DIST)) {
  const { size } = await stat(file.path)
  const budget = BUDGETS.find((b) => b.glob.test(file.rel))
  if (!budget) continue
  const ok = size <= budget.max
  summary.push({ rel: file.rel, size, max: budget.max, label: budget.label, ok })
  if (!ok) failures.push(`${file.rel}  ${size}B  >  ${budget.max}B  (${budget.label})`)
}

summary.sort((a, b) => b.size - a.size)
console.log("\nBundle sizes (raw, pre-gzip):")
console.log("─".repeat(60))
for (const s of summary) {
  const status = s.ok ? "✓" : "✗"
  const pct = Math.round((s.size / s.max) * 100)
  console.log(`  ${status}  ${s.rel.padEnd(40)} ${String(s.size).padStart(6)}B  ${pct}%`)
}
console.log("─".repeat(60))

if (failures.length > 0) {
  console.error("\n❌ Bundle budget exceeded:")
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log("\n✅ All bundles within budget.")
