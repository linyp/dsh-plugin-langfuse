/**
 * Release smoke: pack exactly what npm would publish, inspect the manifest,
 * install the tarball into an empty consumer, import its public entry, and
 * compose the bundled profile patch through the real DSH patch parser.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const root = process.cwd()
const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PACKAGE_NAME = sourceManifest.name
const PACKAGE_VERSION = sourceManifest.version
const temporary = mkdtempSync(join(tmpdir(), 'dsh-plugin-langfuse-package-'))
const cache = join(temporary, 'npm-cache')

try {
  const packed = JSON.parse(execFileSync('npm', [
    'pack',
    '--json',
    '--pack-destination', temporary,
    '--cache', cache,
  ], { cwd: root, encoding: 'utf8' }))
  assert.equal(packed.length, 1)
  const artifact = packed[0]
  assert.equal(artifact.name, PACKAGE_NAME)
  assert.equal(artifact.version, PACKAGE_VERSION)

  const files = new Set(artifact.files.map(file => file.path))
  for (const required of [
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'README.zh.md',
    'lib/index.js',
    'lib/types/index.d.ts',
    'src/index.ts',
  ]) assert(files.has(required), `packed artifact is missing ${required}`)
  for (const file of files) {
    assert(!file.startsWith('tests/'), `packed artifact leaked test file ${file}`)
    assert(!file.includes('.env'), `packed artifact leaked environment file ${file}`)
  }

  const consumer = join(temporary, 'consumer')
  mkdirSync(consumer)
  const tarball = join(temporary, artifact.filename)
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'dsh-plugin-langfuse-clean-install',
    private: true,
    type: 'module',
    dependencies: { [PACKAGE_NAME]: `file:${tarball}` },
  }, null, 2)}\n`)
  execFileSync('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--cache', cache,
  ], { cwd: consumer, stdio: 'inherit' })

  const installedRoot = join(consumer, 'node_modules', PACKAGE_NAME)
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))
  assert.equal(installedManifest.version, PACKAGE_VERSION)
  assert.equal(installedManifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const publicApi = await import(pathToFileURL(join(installedRoot, 'lib/index.js')).href)
  assert.equal(typeof publicApi.createDshTurnTraceId, 'function')
  assert.equal(typeof publicApi.FeedbackScoreSink, 'function')

  const patches = loadOverlayPatches('dsh-plugin-langfuse-package-smoke', join(installedRoot, 'cordis.patch.yml'))
  const warnings = []
  const entries = composeEntries([[
    { insert: [{ id: 'session-telemetry-otel', name: '@deepseek-ai/dsh-session-telemetry-otel', config: {} }] },
  ], patches], warning => warnings.push(warning))
  assert.deepEqual(warnings, [])
  const official = entries.find(entry => entry.id === 'session-telemetry-otel')
  const langfuse = entries.find(entry => entry.id === 'session-telemetry-langfuse')
  assert.equal(official?.disabled, true)
  assert.equal(langfuse?.name, PACKAGE_NAME)
  assert.match(langfuse?.config?.exporter?.url?.__jsExpr ?? '', /api\/public\/otel\/v1\/traces/)
  assert.match(langfuse?.config?.feedbackScores?.url?.__jsExpr ?? '', /api\/public\/scores/)

  console.log(`verified ${artifact.filename}: ${files.size} files, clean import, bundle composition`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
