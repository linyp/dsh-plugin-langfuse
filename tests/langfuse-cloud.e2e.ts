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
import { SYNTHETIC_PARENT_SPAN_ID, createDshCompactionTraceId } from '../src/identity.ts'

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY
const HOST = (process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com').replace(/\/$/, '')
const REQUIRE_TOTAL_COST = /^(1|true|yes)$/iu.test(process.env.LANGFUSE_REQUIRE_TOTAL_COST ?? '')
const CLOUD_STEP_MODEL = process.env.LANGFUSE_E2E_COST_MODEL ?? 'deepseek-v4-flash'

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
  level?: string
  statusMessage?: string | null
  model?: string
  usageDetails?: Record<string, number>
  inputUsage?: number
  outputUsage?: number
  totalUsage?: number
  totalCost?: number | null
  environment?: string
  tags?: string[]
  traceName?: string
  parentObservationId?: string | null
  sessionId?: string
  userId?: string
  isRootObservation?: boolean
  metadata?: Record<string, unknown>
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

function otelAttributes(observation: V2Observation | undefined): Record<string, unknown> {
  const metadata = observation?.metadata
  if (metadata === undefined) return {}
  const nested = metadata.attributes
  const attributes: Record<string, unknown> = nested !== null && typeof nested === 'object' && !Array.isArray(nested)
    ? { ...nested as Record<string, unknown> }
    : {}
  // Langfuse Cloud v4 currently serializes the same catch-all object through
  // Observations v2 as flat `metadata["attributes.<key>"]` entries. Accept
  // both representations so this test locks semantics rather than one read
  // API serialization detail.
  for (const [key, value] of Object.entries(metadata)) {
    if (key.startsWith('attributes.')) attributes[key.slice('attributes.'.length)] = value
  }
  return attributes
}

describe.skipIf(!PUBLIC_KEY || !SECRET_KEY)('Langfuse cloud round trip', () => {
  it('ingests the exported session and serves the trace tree back through the public API', { timeout: 300_000 }, async () => {
    const fromStartTime = new Date(Date.now() - 5_000).toISOString()
    let sessionIds: string[] = []
    let parentSessionId = ''
    let childSessionId = ''
    let feedbackText = ''
    let compactionId = ''
    let compactionSummary = ''
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
          parentSessionId: string
          childSessionId: string
          feedbackText: string
          compactionId: string
          compactionSummary: string
        }
        sessionIds = output.sessionIds
        parentSessionId = output.parentSessionId
        childSessionId = output.childSessionId
        feedbackText = output.feedbackText
        compactionId = output.compactionId
        compactionSummary = output.compactionSummary
      },
    })
    expect(sessionIds.length).toBeGreaterThan(0)

    // Poll the v4 observation-first API only. The bounded window plus known
    // user id locates fresh rows; their session id narrows them to this run.
    const deadline = Date.now() + INGESTION_DEADLINE_MS
    let rows: V2Observation[] = []
    for (;;) {
      const params = new URLSearchParams({
        fields: 'core,basic,io,metadata,model,usage,trace_context',
        userId: 'dsh-plugin-langfuse-e2e',
        fromStartTime,
        toStartTime: new Date(Date.now() + 1_000).toISOString(),
        limit: '1000',
      })
      const page = await api<{ data?: V2Observation[] }>(`/api/public/v2/observations?${params}`)
      rows = (page.data ?? []).filter(row => row.sessionId !== undefined && sessionIds.includes(row.sessionId))
      const generations = rows.filter(row => row.type === 'GENERATION')
      const stepGenerations = generations.filter(row => row.sessionId === parentSessionId
        && (row.name === 'step 1' || row.name === 'step 2'))
      const compaction = generations.find(row => row.name === 'compaction'
        && row.sessionId === parentSessionId
        && row.model === 'langfuse-compaction-mock')
      const root = rows.find(row => row.isRootObservation === true
        && row.sessionId === parentSessionId
        && row.name === 'turn 1')
      const childRoot = rows.find(row => row.isRootObservation === true && row.sessionId === childSessionId)
      const diagnosticGeneration = generations.find(row => row.sessionId === childSessionId && row.name === 'step 1')
      const diagnosticTool = rows.find(row => row.sessionId === childSessionId
        && row.type === 'TOOL'
        && row.name === 'diagnostic'
        && row.level === 'ERROR')
      const approval = rows.find(row => row.sessionId === childSessionId
        && row.type === 'SPAN'
        && row.name === 'approval diagnostic'
        && otelAttributes(row)['dsh.approval.id'] === 'langfuse-cloud-e2e-approval')
      const costReady = !REQUIRE_TOTAL_COST || stepGenerations.every(row => (
        typeof row.totalCost === 'number' && Number.isFinite(row.totalCost) && row.totalCost > 0
      ))
      const ready = stepGenerations.length >= 2
        && stepGenerations.every(row => row.model === CLOUD_STEP_MODEL && row.usageDetails !== undefined)
        && costReady
        && compaction?.usageDetails !== undefined
        && JSON.stringify(compaction.output).includes(compactionSummary)
        && rows.some(row => row.type === 'TOOL' && row.name === 'bash')
        && root?.input != null
        && root.output != null
        && root.environment === 'integration'
        && root.tags?.includes('cloud') === true
        && root.traceName?.endsWith(' · turn 1') === true
        && childRoot?.metadata?.dsh_parent_session_id === parentSessionId
        && childRoot.metadata.dsh_parent_trace_id === root.traceId
        && diagnosticGeneration !== undefined
        && otelAttributes(diagnosticTool)['dsh.tool.error.code'] === 'DIAGNOSTIC_REJECTED'
        && otelAttributes(approval)['dsh.approval.outcome'] === 'rejected'
      if (ready || Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    expect(rows.length, `no complete trace ingested for sessions ${sessionIds.join(', ')} within ${INGESTION_DEADLINE_MS}ms`).toBeGreaterThan(0)

    // Langfuse normalizes canonical inclusive OTel usage back into mutually
    // exclusive buckets: 16 total input = 11 uncached + 2 read + 3 created.
    const generations = rows.filter(row => row.type === 'GENERATION')
    const stepGenerations = generations.filter(row => row.sessionId === parentSessionId
      && (row.name === 'step 1' || row.name === 'step 2'))
    for (const generation of stepGenerations) expect(generation.model).toBe(CLOUD_STEP_MODEL)
    const step1 = generations.find(row => row.sessionId === parentSessionId && row.name === 'step 1')
    expect(step1?.usageDetails).toMatchObject({
      input: 11,
      output: 3,
      input_cached_tokens: 2,
      input_cache_creation: 3,
    })
    expect(step1?.inputUsage).toBe(16)
    expect(step1?.outputUsage).toBe(3)
    expect(step1?.totalUsage).toBe(19)

    const step2 = generations.find(row => row.sessionId === parentSessionId && row.name === 'step 2')
    expect(step2?.usageDetails).toMatchObject({
      input: 7,
      output: 4,
      output_reasoning_tokens: 1,
      total: 12,
    })
    expect(step2?.inputUsage).toBe(7)
    expect(step2?.outputUsage).toBe(5)
    expect(step2?.totalUsage).toBe(12)

    if (REQUIRE_TOTAL_COST) {
      expect(stepGenerations.length).toBeGreaterThanOrEqual(2)
      for (const generation of stepGenerations) {
        expect(
          generation.totalCost,
          `Langfuse returned no totalCost for ${generation.name ?? 'step'} model ${CLOUD_STEP_MODEL}; configure matching model pricing in the test project or unset LANGFUSE_REQUIRE_TOTAL_COST`,
        ).toEqual(expect.any(Number))
        expect(Number.isFinite(generation.totalCost)).toBe(true)
        expect(generation.totalCost!).toBeGreaterThan(0)
      }
    }

    // Standalone compaction is a first-class root Generation with its stable
    // deterministic trace identity, summary output, aggregate-only input,
    // canonical usage normalization, and queryable transaction metadata.
    const compaction = generations.find(row => row.name === 'compaction'
      && row.sessionId === parentSessionId
      && row.model === 'langfuse-compaction-mock')
    expect(compaction, `no compaction observation among: ${JSON.stringify(rows.map(o => o.name))}`).toBeDefined()
    expect(compaction).toMatchObject({
      traceId: createDshCompactionTraceId(parentSessionId, compactionId),
      sessionId: parentSessionId,
      userId: 'dsh-plugin-langfuse-e2e',
      isRootObservation: true,
      model: 'langfuse-compaction-mock',
      inputUsage: 18,
      outputUsage: 5,
      totalUsage: 23,
    })
    // Deterministic OTel Trace IDs are seeded through a valid non-recording
    // parent. Langfuse preserves that span id while the app-root marker makes
    // this observation the logical root in its v4 model.
    expect(compaction?.parentObservationId).toBe(SYNTHETIC_PARENT_SPAN_ID)
    expect(compaction?.usageDetails).toMatchObject({
      input: 13,
      output: 5,
      input_cached_tokens: 2,
      input_cache_creation: 3,
    })
    expect(JSON.stringify(compaction?.input)).toContain('shadowedTokenCount')
    expect(JSON.stringify(compaction?.input)).toContain('777')
    expect(JSON.stringify(compaction?.output)).toContain(compactionSummary)
    expect(JSON.stringify(compaction?.metadata)).toContain(compactionId)

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
    const root = rows.find(row => row.isRootObservation === true
      && row.sessionId === parentSessionId
      && row.name === 'turn 1')
    expect(root, 'v4 root observation').toBeDefined()
    expect(root!.input, 'v4 root observation input').toBeDefined()
    expect(root!.output, 'v4 root observation output').toBeDefined()
    expect(root).toMatchObject({ environment: 'integration' })
    expect(root!.traceName).toMatch(/ · turn 1$/u)
    expect(root!.tags).toEqual(expect.arrayContaining(['dsh', 'e2e', 'cloud']))
    const children = rows.filter(row => row.type === 'GENERATION' || row.type === 'TOOL')
    expect(children.length).toBeGreaterThan(0)
    for (const row of children) {
      expect(sessionIds).toContain(row.sessionId)
      expect(row.userId, `observation ${row.name ?? '?'} userId`).toBe('dsh-plugin-langfuse-e2e')
    }

    // Langfuse may not render OTel Links as a clickable UI edge, so the Cloud
    // contract is the queryable metadata mirror on every child trace root.
    const childRoot = rows.find(row => row.isRootObservation === true && row.sessionId === childSessionId)
    expect(childRoot, 'child root observation').toBeDefined()
    expect(childRoot?.metadata).toMatchObject({
      dsh_parent_session_id: parentSessionId,
      dsh_parent_trace_id: root?.traceId,
    })
    expect(childRoot?.metadata?.dsh_seed_length).toEqual(expect.any(Number))
    expect(childRoot).toMatchObject({ environment: 'integration', traceName: 'dsh turn 2' })

    // The child emits a retry lifecycle plus one diagnostic request. Langfuse
    // v2 exposes observations, not embedded OTel span events, so Cloud proves
    // the retry did not fabricate extra generations while the local raw-OTLP
    // E2E owns the retry event payload assertions.
    const diagnosticGenerations = generations.filter(row => row.sessionId === childSessionId && row.name === 'step 1')
    expect(diagnosticGenerations).toHaveLength(1)
    const diagnosticGeneration = diagnosticGenerations[0]!
    expect(diagnosticGeneration).toMatchObject({
      model: CLOUD_STEP_MODEL,
      parentObservationId: childRoot?.id,
      environment: 'integration',
      traceName: 'dsh turn 2',
    })

    const diagnosticTool = rows.find(row => row.sessionId === childSessionId
      && row.type === 'TOOL'
      && row.name === 'diagnostic'
      && row.level === 'ERROR')
    expect(diagnosticTool).toMatchObject({
      parentObservationId: diagnosticGeneration.id,
      level: 'ERROR',
      statusMessage: 'DIAGNOSTIC_REJECTED',
      environment: 'integration',
      traceName: 'dsh turn 2',
    })
    expect(JSON.stringify(diagnosticTool?.output)).toContain('cloud diagnostic second block')
    expect(otelAttributes(diagnosticTool)).toMatchObject({
      'dsh.tool.error.name': 'DiagnosticError',
      'dsh.tool.error.code': 'DIAGNOSTIC_REJECTED',
      'dsh.tool.outcome': 'error',
    })

    const approval = rows.find(row => row.sessionId === childSessionId
      && row.type === 'SPAN'
      && row.name === 'approval diagnostic'
      && otelAttributes(row)['dsh.approval.id'] === 'langfuse-cloud-e2e-approval')
    expect(approval).toMatchObject({
      parentObservationId: diagnosticTool?.id,
      environment: 'integration',
      traceName: 'dsh turn 2',
    })
    expect(otelAttributes(approval)).toMatchObject({
      'dsh.approval.outcome': 'rejected',
      'dsh.approval.reason': 'exercise cloud approval telemetry',
      'dsh.approval.tool.name': 'diagnostic',
      'dsh.approval.tool.call_id': 'langfuse-cloud-e2e-diagnostic-call',
    })
    for (const observation of [diagnosticGeneration, diagnosticTool!, approval!]) {
      expect(observation.tags).toEqual(expect.arrayContaining(['dsh', 'e2e', 'cloud']))
      expect(observation.userId).toBe('dsh-plugin-langfuse-e2e')
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
        sessionId: parentSessionId,
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
