/**
 * REAL-composition tier: boot the fixture Loader composition as a subprocess
 * through the same app/boot path a deployment uses, run one mocked-model turn
 * with a real bash round trip, and assert against what the mock Langfuse
 * collector actually received on the wire: the traces path, Basic auth, and
 * the turn/generation/tool span tree with usage attributes.
 *
 * Requires the built artifact (`npm run build`) — the fixture loads
 * `lib/index.js`, the same file a deployment loads.
 */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  SYNTHETIC_PARENT_SPAN_ID,
  createDshCompactionTraceId,
  createDshTurnTraceId,
} from '../src/identity.ts'

const driver = fileURLToPath(new URL('./fixtures/langfuse-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/langfuse.cordis.yml', import.meta.url))

interface OtlpSpan {
  name: string
  parentSpanId?: string
  spanId: string
  traceId: string
  attributes?: { key: string; value: Record<string, unknown> }[]
  links?: {
    traceId: string
    spanId: string
    attributes?: { key: string; value: Record<string, unknown> }[]
  }[]
  status?: { code?: number }
  events?: {
    name: string
    attributes?: { key: string; value: Record<string, unknown> }[]
  }[]
}

interface Capture {
  path: string
  authorization: string | undefined
  ingestionVersion: string | undefined
  body: unknown
}

interface OtlpBody {
  resourceSpans?: {
    resource?: { attributes?: { key: string; value: Record<string, unknown> }[] }
    scopeSpans?: { scope?: { name?: string }; spans?: OtlpSpan[] }[]
  }[]
}

interface ScoreBody {
  id: string
  sessionId: string
  name: string
  value: string
  dataType: string
  metadata: Record<string, unknown>
}

function attr(span: OtlpSpan, key: string): unknown {
  return span.attributes?.find(entry => entry.key === key)?.value
}

function eventAttr(event: NonNullable<OtlpSpan['events']>[number], key: string): unknown {
  return event.attributes?.find(entry => entry.key === key)?.value
}

describe('dsh-plugin-langfuse REAL composition', () => {
  it('exports the turn/generation/tool span tree over Langfuse-shaped OTLP', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    await runLoaderSmoke({
      label: 'dsh-plugin-langfuse',
      tempDirPrefix: 'dsh-plugin-langfuse-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
      // Installed built packages resolve through real `exports`; no tsx.
      mode: 'lib',
      inspect: async (cwd) => {
        const captures = JSON.parse(await readFile(join(cwd, 'otlp-captures.json'), 'utf8')) as Capture[]
        expect(captures.length).toBeGreaterThan(1)

        const otlpCaptures = captures.filter(capture => capture.path === '/api/public/otel/v1/traces')
        const scoreCaptures = captures.filter(capture => capture.path === '/api/public/scores')
        expect(otlpCaptures.length).toBeGreaterThan(0)
        expect(scoreCaptures).toHaveLength(1)

        for (const capture of otlpCaptures) {
          expect(capture.path).toBe('/api/public/otel/v1/traces')
          expect(capture.authorization).toBe(`Basic ${Buffer.from('pk-lf-e2e:sk-lf-e2e').toString('base64')}`)
          // Defaulted so new spans land on Langfuse's v4 data model in real time.
          expect(capture.ingestionVersion).toBe('4')
        }

        const spans = otlpCaptures.flatMap(capture =>
          (capture.body as OtlpBody).resourceSpans?.flatMap(rs => rs.scopeSpans?.flatMap(ss => ss.spans ?? []) ?? []) ?? [])
        // The real agent loop numbers turns and steps from 1.
        const names = spans.map(span => span.name)
        expect(names).toContain('turn 1')
        expect(names).toContain('step 1')
        expect(names).toContain('tool bash')
        expect(spans.filter(span => span.name === 'turn 1')).toHaveLength(1)

        const turn = spans.find(span => span.name === 'turn 1')!
        expect(attr(turn, 'langfuse.observation.input')).toBeDefined()
        expect(attr(turn, 'langfuse.observation.output')).toBeDefined()
        // Legacy aliases remain for trace-level evaluators during migration.
        expect(attr(turn, 'langfuse.trace.input')).toBeDefined()
        expect(attr(turn, 'langfuse.trace.output')).toBeDefined()
        expect(attr(turn, 'dsh.session.id')).toBeDefined()
        const dshSessionId = (attr(turn, 'dsh.session.id') as { stringValue: string }).stringValue
        expect(turn.traceId).toBe(createDshTurnTraceId(dshSessionId, 1))
        expect(turn.parentSpanId).toBe(SYNTHETIC_PARENT_SPAN_ID)
        expect(attr(turn, 'dsh.trace.deterministic_id')).toEqual({ stringValue: turn.traceId })
        expect(attr(turn, 'dsh.trace.logical_root')).toEqual({ boolValue: true })
        expect(attr(turn, 'langfuse.internal.is_app_root')).toEqual({ boolValue: true })

        // The fixture forks a real child session after the parent turn. Its
        // new turn is a separate trace linked to the completed parent root.
        const child = spans.find(span => span.name === 'turn 2')!
        const childSessionId = (attr(child, 'dsh.session.id') as { stringValue: string }).stringValue
        expect(child.traceId).toBe(createDshTurnTraceId(childSessionId, 2))
        expect(attr(child, 'dsh.session.parent_id')).toEqual({ stringValue: dshSessionId })
        expect(attr(child, 'dsh.session.seed_length')).toEqual(expect.objectContaining({ intValue: expect.any(Number) }))
        expect(attr(child, 'dsh.lineage.parent_trace_id')).toEqual({ stringValue: turn.traceId })
        expect(attr(child, 'dsh.lineage.linked')).toEqual({ boolValue: true })
        expect(attr(child, 'langfuse.trace.metadata.dsh_parent_session_id')).toEqual({ stringValue: dshSessionId })
        expect(attr(child, 'langfuse.trace.metadata.dsh_parent_trace_id')).toEqual({ stringValue: turn.traceId })
        expect(attr(child, 'langfuse.trace.name')).toEqual({ stringValue: 'E2E child trace · turn 2' })
        expect(attr(child, 'langfuse.environment')).toEqual({ stringValue: 'integration' })
        expect(attr(child, 'langfuse.trace.tags')).toEqual({
          arrayValue: { values: [{ stringValue: 'dsh' }, { stringValue: 'e2e' }] },
        })
        expect(attr(child, 'dsh.session.cwd')).toEqual({ stringValue: basename(cwd) })
        expect(attr(child, 'langfuse.trace.metadata.dsh_cwd')).toEqual({ stringValue: basename(cwd) })
        expect(attr(child, 'langfuse.trace.metadata.dsh_agent_preset')).toEqual({ stringValue: 'diagnostic' })
        expect(attr(child, 'langfuse.trace.metadata.dsh_subagent_label')).toEqual({ stringValue: 'diagnostic child' })
        expect(child.links).toHaveLength(1)
        expect(child.links?.[0]).toMatchObject({ traceId: turn.traceId, spanId: turn.spanId })
        const linkType = child.links?.[0]?.attributes?.find(entry => entry.key === 'dsh.link.type')?.value
        expect(linkType).toEqual({ stringValue: 'fork' })

        const generation = spans.find(span => span.name === 'step 1')!
        expect(generation.parentSpanId).toBe(turn.spanId)
        expect(attr(generation, 'langfuse.observation.type')).toEqual({ stringValue: 'generation' })
        // DSH buckets are disjoint; canonical OTel input is inclusive.
        expect(attr(generation, 'gen_ai.usage.input_tokens')).toEqual({ intValue: 16 })
        expect(attr(generation, 'gen_ai.usage.output_tokens')).toEqual({ intValue: 3 })
        expect(attr(generation, 'gen_ai.usage.cache_read.input_tokens')).toEqual({ intValue: 2 })
        expect(attr(generation, 'gen_ai.usage.cache_creation.input_tokens')).toEqual({ intValue: 3 })
        expect(attr(generation, 'gen_ai.usage.cache_read_tokens')).toBeUndefined()

        const secondGeneration = spans.find(span => span.name === 'step 2')!
        expect(attr(secondGeneration, 'gen_ai.usage.output_tokens')).toEqual({ intValue: 5 })
        expect(attr(secondGeneration, 'gen_ai.usage.reasoning.output_tokens')).toEqual({ intValue: 1 })
        expect(attr(secondGeneration, 'gen_ai.usage.reasoning_tokens')).toBeUndefined()

        const diagnosticGeneration = spans.find(span => span.name === 'step 1' && span.traceId === child.traceId)!
        expect(diagnosticGeneration.parentSpanId).toBe(child.spanId)
        expect(attr(diagnosticGeneration, 'gen_ai.request.model')).toEqual({ stringValue: 'langfuse-diagnostic' })
        expect(attr(diagnosticGeneration, 'gen_ai.request.max_tokens')).toEqual({ intValue: 512 })
        expect(attr(diagnosticGeneration, 'gen_ai.request.temperature')).toEqual({ doubleValue: 0.1 })
        expect(attr(diagnosticGeneration, 'dsh.request.context_window')).toEqual({ intValue: 16_384 })
        expect(attr(diagnosticGeneration, 'langfuse.trace.name')).toEqual({ stringValue: 'E2E child trace · turn 2' })
        expect(spans.filter(span => span.name === 'step 1' && span.traceId === child.traceId)).toHaveLength(1)
        const retryScheduled = diagnosticGeneration.events?.find(event => event.name === 'dsh.llm.retry.scheduled')
        expect(retryScheduled).toBeDefined()
        expect(eventAttr(retryScheduled!, 'dsh.llm.retry.id')).toEqual({ stringValue: 'e2e-retry' })
        expect(eventAttr(retryScheduled!, 'dsh.llm.retry.failure.code')).toEqual({ stringValue: 'RATE_LIMIT' })
        expect(diagnosticGeneration.events?.some(event => event.name === 'dsh.llm.retry.started')).toBe(true)

        // The tool span nests under the generation whose model request called it.
        const tool = spans.find(span => span.name === 'tool bash')!
        expect(tool.parentSpanId).toBe(generation.spanId)
        expect(attr(tool, 'langfuse.observation.output')).toBeDefined()

        const diagnosticTool = spans.find(span => span.name === 'tool diagnostic')!
        expect(diagnosticTool.parentSpanId).toBe(diagnosticGeneration.spanId)
        expect(attr(diagnosticTool, 'dsh.tool.outcome')).toEqual({ stringValue: 'error' })
        expect(attr(diagnosticTool, 'dsh.tool.error.name')).toEqual({ stringValue: 'DiagnosticError' })
        expect(attr(diagnosticTool, 'dsh.tool.error.code')).toEqual({ stringValue: 'DIAGNOSTIC_REJECTED' })
        expect(attr(diagnosticTool, 'langfuse.observation.output')).toEqual(expect.objectContaining({
          stringValue: expect.stringContaining('diagnostic second block'),
        }))
        expect(attr(diagnosticTool, 'langfuse.observation.metadata.tool.safe')).toEqual({ stringValue: '"visible"' })
        expect(attr(diagnosticTool, 'langfuse.observation.metadata.tool.secret')).toBeUndefined()
        expect(JSON.stringify(diagnosticTool.attributes)).not.toContain('must-not-export')

        const approval = spans.find(span => span.name === 'approval diagnostic')!
        expect(approval.parentSpanId).toBe(diagnosticTool.spanId)
        expect(attr(approval, 'dsh.approval.outcome')).toEqual({ stringValue: 'rejected' })
        expect(attr(approval, 'dsh.approval.reason')).toEqual({ stringValue: 'exercise approval telemetry' })

        // A compaction outside an open turn becomes a stable standalone trace
        // while retaining the same Langfuse correlation identity.
        const compaction = spans.find(span => span.name === 'compaction')!
        expect(compaction.traceId).toBe(createDshCompactionTraceId(dshSessionId, 'e2e-compaction'))
        expect(compaction.parentSpanId).toBe(SYNTHETIC_PARENT_SPAN_ID)
        expect(attr(compaction, 'langfuse.observation.type')).toEqual({ stringValue: 'generation' })
        expect(attr(compaction, 'langfuse.observation.output')).toEqual({ stringValue: '"e2e compacted context"' })
        expect(attr(compaction, 'dsh.compaction.shadowed_token_count')).toEqual({ intValue: 512 })
        expect(attr(compaction, 'dsh.compaction.summary_seen')).toEqual({ boolValue: true })

        // Correlation identity rides every span on the wire — Langfuse v4
        // filters per observation, so the root-span stamp alone is not enough.
        for (const span of [turn, generation, tool, child, diagnosticGeneration, diagnosticTool, approval]) {
          expect(attr(span, 'langfuse.session.id'), `${span.name} session`).toEqual({ stringValue: 'e2e-host-session' })
          expect(attr(span, 'langfuse.user.id'), `${span.name} user`).toEqual({ stringValue: 'e2e-host-user' })
          expect(attr(span, 'langfuse.trace.metadata.dsh_deterministic_trace_id'), `${span.name} deterministic id`)
            .toEqual({ stringValue: span.traceId })
        }

        const scoreCapture = scoreCaptures[0]!
        expect(scoreCapture.authorization).toBe(`Basic ${Buffer.from('pk-lf-e2e:sk-lf-e2e').toString('base64')}`)
        const score = scoreCapture.body as ScoreBody
        expect(score).toMatchObject({
          sessionId: 'e2e-host-session',
          name: 'dsh_user_feedback',
          value: 'e2e feedback score',
          dataType: 'TEXT',
          metadata: {
            dshSessionId,
            dshTelemetryMode: 'FULL',
            truncated: false,
          },
        })
        expect(score.id).toMatch(/^[0-9a-f]{32}$/)
        expect(score).not.toHaveProperty('timestamp')
        expect(score).not.toHaveProperty('stringValue')
      },
    })
  })
})
