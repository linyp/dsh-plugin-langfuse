/**
 * Key-gated cloud round trip: boot the real composition against the real
 * Langfuse OTLP endpoint, then read the export back through Langfuse's
 * public API and assert the ingested trace tree — proving Langfuse actually
 * understands our gen_ai/langfuse attribute mapping, which the mock
 * collector cannot. Self-skips without LANGFUSE_PUBLIC_KEY /
 * LANGFUSE_SECRET_KEY (region via LANGFUSE_HOST). Requires `npm run build`.
 * Ingestion is asynchronous on Langfuse's side, so the readback polls.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY
const HOST = (process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com').replace(/\/$/, '')

const driver = fileURLToPath(new URL('./fixtures/langfuse-cloud-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/langfuse-cloud.cordis.yml', import.meta.url))

const INGESTION_DEADLINE_MS = 120_000
const POLL_INTERVAL_MS = 5_000

interface TraceSummary {
  id: string
  name?: string
  sessionId?: string
}

interface Observation {
  type?: string
  name?: string
  model?: string
  usage?: { input?: number; output?: number }
  parentObservationId?: string | null
  id?: string
}

interface TraceDetail extends TraceSummary {
  observations?: Observation[]
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${HOST}${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')}` },
  })
  if (!response.ok) throw new Error(`Langfuse API ${path} responded ${response.status}: ${await response.text()}`)
  return await response.json() as T
}

describe.skipIf(PUBLIC_KEY === undefined || SECRET_KEY === undefined)('Langfuse cloud round trip', () => {
  it('ingests the exported session and serves the trace tree back through the public API', { timeout: 300_000 }, async () => {
    let sessionIds: string[] = []
    await runLoaderSmoke({
      label: 'dsh-plugin-langfuse-cloud',
      tempDirPrefix: 'dsh-plugin-langfuse-cloud-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
      mode: 'lib',
      inspect: async (cwd) => {
        const output = JSON.parse(await readFile(join(cwd, 'cloud-session.json'), 'utf8')) as { sessionIds: string[] }
        sessionIds = output.sessionIds
      },
    })
    expect(sessionIds.length).toBeGreaterThan(0)

    // Poll until Langfuse's asynchronous ingestion surfaces the COMPLETE
    // trace: the trace summary, its observation rows, and their fields
    // (model, usage) all materialize incrementally, so a readiness predicate
    // gates the assertions instead of the first partial snapshot.
    const deadline = Date.now() + INGESTION_DEADLINE_MS
    let detail: TraceDetail | undefined
    for (;;) {
      const pages = await Promise.all(sessionIds.map(id =>
        api<{ data?: TraceSummary[] }>(`/api/public/traces?sessionId=${encodeURIComponent(id)}`)))
      for (const trace of pages.flatMap(page => page.data ?? [])) {
        const candidate = await api<TraceDetail>(`/api/public/traces/${trace.id}`)
        const generations = (candidate.observations ?? []).filter(o => o.type === 'GENERATION')
        const ready = generations.length > 0 && generations.every(o => o.model != null)
          && (candidate.observations ?? []).some(o => o.name === 'bash')
        if (ready) detail = candidate
      }
      if (detail !== undefined || Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    expect(detail, `no complete trace ingested for sessions ${sessionIds.join(', ')} within ${INGESTION_DEADLINE_MS}ms`).toBeDefined()
    const observations = detail!.observations ?? []

    // Every generation carries the model identity; the first step carries
    // the mock adapter's fixed usage.
    const generations = observations.filter(observation => observation.type === 'GENERATION')
    expect(generations.length).toBeGreaterThan(0)
    for (const generation of generations) expect(generation.model).toBe('langfuse-mock')
    const step1 = observations.find(observation => observation.name === 'step 1')
    expect(step1?.usage?.input).toBe(11)
    expect(step1?.usage?.output).toBe(3)

    // The tool observation nests under its requesting generation. Langfuse
    // names tool observations from `gen_ai.tool.name` (`bash`), not the span
    // name (`tool bash`).
    const tool = observations.find(observation => observation.name === 'bash')
    expect(tool, `no tool observation among: ${JSON.stringify(observations.map(o => o.name))}`).toBeDefined()
    const requestingStep = observations.find(observation => observation.name === 'step 1')
    expect(requestingStep).toBeDefined()
    expect(tool!.parentObservationId).toBe(requestingStep!.id)
  })
})
