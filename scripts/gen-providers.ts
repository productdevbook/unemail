import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTypeExports } from 'mlly'
import { camelCase, upperFirst } from 'scule'

const providersDir = fileURLToPath(new URL('../src/providers', import.meta.url))

const providersMetaFile = fileURLToPath(
  new URL('../src/_providers.ts', import.meta.url),
)

// Get all .ts files in the providers directory (excluding utils folder and index.ts)
const providerEntries: string[] = (
  await readdir(providersDir, { withFileTypes: true })
)
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'index.ts')
  .map(entry => entry.name)

const providers: {
  name: string
  safeName: string
  names: string[]
  subpath: string
  optionsTExport?: string
  optionsTName?: string
}[] = []

for (const entry of providerEntries) {
  const name = entry.replace(/\.ts$/, '')
  const subpath = `unemail/providers/${name}`
  const fullPath = join(providersDir, `${name}.ts`)

  const contents = await readFile(fullPath, 'utf8')
  const optionsTExport = findTypeExports(contents).find(type =>
    type.name?.endsWith('Options'),
  )?.name

  // Convert to camelCase (aws-ses -> awsSes)
  const safeName = camelCase(name)

  // Both kebab-case and camelCase names
  const names = [...new Set([name, safeName])]

  // Options type name (AwsSesOptions, SmtpOptions, etc.)
  const optionsTName = `${upperFirst(safeName)}Options`

  providers.push({
    name,
    safeName,
    names,
    subpath,
    optionsTExport,
    optionsTName,
  })
}

const genCode = /* ts */ `// Auto-generated using scripts/gen-providers.
// Do not manually edit!

${providers
  .filter(d => d.optionsTExport)
  .map(
    d =>
      /* ts */ `import type { ${d.optionsTExport} as ${d.optionsTName} } from "${d.subpath}";`,
  )
  .join('\n')}

export type BuiltinProviderName = ${providers.flatMap(d => d.names.map(name => `"${name}"`)).join(' | ')};

export type BuiltinProviderOptions = {
  ${providers
    .filter(d => d.optionsTExport)
    .flatMap(d => d.names.map(name => `"${name}": ${d.optionsTName};`))
    .join('\n  ')}
};

export const builtinProviders = {
  ${providers.flatMap(d => d.names.map(name => `"${name}": "${d.subpath}"`)).join(',\n  ')},
} as const;
`

await writeFile(providersMetaFile, genCode, 'utf8')
console.log('Generated providers metadata file to', providersMetaFile)
