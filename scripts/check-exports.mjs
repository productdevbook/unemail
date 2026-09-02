#!/usr/bin/env node
// Every driver, middleware and render entry must appear in both export maps,
// and neither map may name a file that is not there. The maps drifted apart
// once already, and the symptom is an import that resolves on npm and 404s
// on JSR — or the reverse — which nothing else in CI would notice.

import { readdir, readFile } from "node:fs/promises"

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))
const pkg = await read("../package.json")
const jsr = await read("../jsr.json")

/** Public entries live in these directories; `_`-prefixed files are internal. */
const AREAS = [
  { dir: "drivers", prefix: "./drivers/" },
  { dir: "render", prefix: "./render/", skip: ["index"] },
]

const problems = []

for (const { dir, prefix, skip = [] } of AREAS) {
  const files = (await readdir(new URL(`../src/${dir}`, import.meta.url), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.startsWith("_"))
    .map((entry) => entry.name.replace(/\.ts$/, ""))
    .filter((name) => !skip.includes(name))

  for (const name of files) {
    const key = `${prefix}${name}`
    if (!pkg.exports[key]) problems.push(`src/${dir}/${name}.ts is not in package.json exports`)
    if (!jsr.exports[key]) problems.push(`src/${dir}/${name}.ts is not in jsr.json exports`)
  }

  for (const [map, name] of [
    [pkg.exports, "package.json"],
    [jsr.exports, "jsr.json"],
  ]) {
    for (const key of Object.keys(map)) {
      if (!key.startsWith(prefix)) continue
      const entry = key.slice(prefix.length)
      if (!files.includes(entry)) problems.push(`${name} exports ${key}, which has no source file`)
    }
  }
}

const pkgKeys = Object.keys(pkg.exports).filter((k) => k !== "./package.json")
const jsrKeys = Object.keys(jsr.exports)
for (const key of pkgKeys) {
  if (!jsrKeys.includes(key)) problems.push(`${key} is in package.json but not jsr.json`)
}
for (const key of jsrKeys) {
  if (!pkgKeys.includes(key)) problems.push(`${key} is in jsr.json but not package.json`)
}

if (problems.length > 0) {
  console.error("❌ export maps are out of step:")
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`✅ ${pkgKeys.length} entries, identical in package.json and jsr.json`)
