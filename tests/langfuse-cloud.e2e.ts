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

/** Row shape returned by Langfuse's v4 `/api/public/v2/observations` list. */
interface V2Observation {
  id: string
  traceId: string
  type?: string
  name?: string
  model?: string
  usageDetails?: Record<string, number>
  inputUsage?: number
  outputUsage?: number
  totalUsage?: number
  totalCost?: number | null
  parentObservationId?: string | null
  sessionId?: string
  userId?: string
  isRootObservation?: boolean
  input?: unknown
  output?: unknown
}

interface V3Score {
  id: string
  name: string
  value: string | number | boolean
  dataType: string
  metadata?: Record<string, unknown>
  subject?: { kind: string; id: string }
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
    const fromStartTime = new Date(Date.now() - 5_000).toISOString()
    let sessionIds: string[] = []
    let feedbackText = ''
    await runLoaderSmoke({
      label: 'dsh-plugin-langfuse-cloud',
      tempDirPrefix: 'dsh-plugin-langfuse-cloud-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
      mode: 'lib',
      inspect: async (cwd) => {
        const output = JSON.parse(await readFile(join(cwd, 'cloud-session.json'), 'utf8')) as {
          sessionIds: string[]
          feedbackText: string
        }
        sessionIds = output.sessionIds
        feedbackText = output.feedbackText
      },
    })
    expect(sessionIds.length).toBeGreaterThan(0)

    // Poll the v4 observation-first API only. The bounded window plus known
    // user id locates fresh rows; their session id narrows them to this run.
    const deadline = Date.now() + INGESTION_DEADLINE_MS
    let rows: V2Observation[] = []
    for (;;) {
      const params = new URLSearchParams({
        fields: 'core,basic,io,model,usage',
        userId: 'dsh-plugin-langfuse-e2e',
        fromStartTime,
        toStartTime: new Date(Date.now() + 1_000).toISOString(),
        limit: '1000',
      })
      const page = await api<{ data?: V2Observation[] }>(`/api/public/v2/observations?${params}`)
      rows = (page.data ?? []).filter(row => row.sessionId !== undefined && sessionIds.includes(row.sessionId))
      const generations = rows.filter(row => row.type === 'GENERATION')
      const root = rows.find(row => row.isRootObservation === true)
      const ready = generations.length >= 2
        && generations.every(row => row.model === 'langfuse-mock' && row.usageDetails !== undefined)
        && rows.some(row => row.type === 'TOOL' && row.name === 'bash')
        && root?.input != null
        && root.output != null
      if (ready || Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    expect(rows.length, `no complete trace ingested for sessions ${sessionIds.join(', ')} within ${INGESTION_DEADLINE_MS}ms`).toBeGreaterThan(0)

    // Langfuse normalizes canonical inclusive OTel usage back into mutually
    // exclusive buckets: 16 total input = 11 uncached + 2 read + 3 created.
    const generations = rows.filter(row => row.type === 'GENERATION')
    for (const generation of generations) expect(generation.model).toBe('langfuse-mock')
    const step1 = generations.find(row => row.name === 'step 1')
    expect(step1?.usageDetails).toMatchObject({
      input: 11,
      output: 3,
      input_cached_tokens: 2,
      input_cache_creation: 3,
    })
    expect(step1?.inputUsage).toBe(16)
    expect(step1?.outputUsage).toBe(3)
    expect(step1?.totalUsage).toBe(19)

    const step2 = generations.find(row => row.name === 'step 2')
    expect(step2?.usageDetails).toMatchObject({
      input: 7,
      output: 4,
      output_reasoning_tokens: 1,
      total: 12,
    })
    expect(step2?.inputUsage).toBe(7)
    expect(step2?.outputUsage).toBe(5)
    expect(step2?.totalUsage).toBe(12)

    // The tool observation nests under its requesting generation. Langfuse
    // names tool observations from `gen_ai.tool.name` (`bash`), not the span
    // name (`tool bash`).
    const tool = rows.find(row => row.type === 'TOOL' && row.name === 'bash')
    expect(tool, `no tool observation among: ${JSON.stringify(rows.map(o => o.name))}`).toBeDefined()
    const requestingStep = rows.find(row => row.traceId === tool!.traceId && row.name === 'step 1')
    expect(requestingStep).toBeDefined()
    expect(tool!.parentObservationId).toBe(requestingStep!.id)

    // v4 queries filter per observation, so identity must ride every span:
    // each generation/tool row of the observation-first API serves its own
    // session/user fields — the root-span stamp alone is not the contract.
    const root = rows.find(row => row.isRootObservation === true)
    expect(root, 'v4 root observation').toBeDefined()
    expect(root!.input, 'v4 root observation input').toBeDefined()
    expect(root!.output, 'v4 root observation output').toBeDefined()
    const children = rows.filter(row => row.type === 'GENERATION' || row.type === 'TOOL')
    expect(children.length).toBeGreaterThan(0)
    for (const row of children) {
      expect(sessionIds).toContain(row.sessionId)
      expect(row.userId, `observation ${row.name ?? '?'} userId`).toBe('dsh-plugin-langfuse-e2e')
    }

    // The current read API returns one typed `value` and a discriminated
    // session subject. Poll it separately because trace and Score ingestion
    // are deliberately independent asynchronous channels.
    const scoreDeadline = Date.now() + INGESTION_DEADLINE_MS
    let score: V3Score | undefined
    for (;;) {
      const params = new URLSearchParams({
        fields: 'details,subject',
        name: 'dsh_user_feedback',
        sessionId: sessionIds.join(','),
        fromTimestamp: fromStartTime,
        limit: '100',
      })
      const page = await api<{ data?: V3Score[] }>(`/api/public/v3/scores?${params}`)
      score = (page.data ?? []).find(row => row.value === feedbackText)
      if (score !== undefined || Date.now() >= scoreDeadline) break
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    expect(score, `no feedback Score ingested for sessions ${sessionIds.join(', ')} within ${INGESTION_DEADLINE_MS}ms`)
      .toMatchObject({
        name: 'dsh_user_feedback',
        value: feedbackText,
        dataType: 'TEXT',
        subject: { kind: 'session' },
        metadata: { dshTelemetryMode: 'FULL', truncated: false },
      })
    expect(sessionIds).toContain(score?.subject?.id)
  })
})
