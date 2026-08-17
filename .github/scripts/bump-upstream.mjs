/**
 * Upstream canary: rewrite every `@deepseek-ai/*` dependency to its newest
 * published version (highest semver, prereleases included) and drop the
 * lockfile so the following `npm install` resolves the whole tree against
 * that upstream state. The npm `latest` dist-tag on these packages trails
 * behind their rc line (rc releases ship under `next`), so `@latest` would
 * test an old build; the `versions` array is the authority.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const changes = []
for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
  const deps = manifest[section] ?? {}
  for (const name of Object.keys(deps)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const versions = JSON.parse(execFileSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8' }))
    const newest = Array.isArray(versions) ? versions.at(-1) : versions
    if (typeof newest !== 'string' || newest.length === 0) {
      throw new Error(`upstream canary: npm returned no published version for ${name}`)
    }
    if (deps[name] !== newest) changes.push({ name, from: deps[name], to: newest })
    deps[name] = newest
  }
}
writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
rmSync('package-lock.json', { force: true })

if (changes.length === 0) {
  console.log('All @deepseek-ai dependencies already use their newest published versions.')
} else {
  for (const { name, from, to } of changes) console.log(`${name}: ${from} -> ${to}`)
}

const stepSummary = process.env['GITHUB_STEP_SUMMARY']
if (stepSummary !== undefined) {
  const rows = changes.length === 0
    ? ['No dependency changes were needed.']
    : [
        '| Package | Pinned | Canary |',
        '|---|---:|---:|',
        ...changes.map(({ name, from, to }) => `| \`${name}\` | \`${from}\` | \`${to}\` |`),
      ]
  appendFileSync(stepSummary, `## Upstream dependency resolution\n\n${rows.join('\n')}\n`)
}
