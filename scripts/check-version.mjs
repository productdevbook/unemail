#!/usr/bin/env node
// The version lives in three places that must agree: npm's manifest, JSR's,
// and the `version` constant the library reports at runtime. Drift here is
// silent and only shows up in a user's bug report, so CI checks it.

import { readFile } from "node:fs/promises"

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))

const pkg = await read("../package.json")
const jsr = await read("../jsr.json")
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")

const declared = /export const version = "([^"]+)"/.exec(source)?.[1]

const found = {
  "package.json": pkg.version,
  "jsr.json": jsr.version,
  "src/index.ts": declared,
}

const distinct = new Set(Object.values(found))
if (distinct.size === 1 && !distinct.has(undefined)) {
  console.log(
    `✅ version ${pkg.version} is consistent across package.json, jsr.json and src/index.ts`,
  )
  process.exit(0)
}

console.error("❌ version mismatch:")
for (const [file, version] of Object.entries(found)) {
  console.error(`  ${file.padEnd(16)} ${version ?? "(not found)"}`)
}
process.exit(1)
