/**
 * Folding-projection unit tier: feed scripted seam records through the REAL
 * OTel SDK (BasicTracerProvider → SimpleSpanProcessor → InMemorySpanExporter)
 * and assert the produced span tree — structure, parentage, GenAI/Langfuse
 * attributes, and record-time (not wall-clock) timestamps.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import { SessionSpanFolder } from '../src/projection.ts'

const SESSION_ID = 'ses-test-1'

/** Build one ledger record the way the seam's capture coordinator does. */
function ledger(type: string, seq: number, time: number, body: unknown, severity: 'info' | 'warn' | 'error' = 'info'): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time,
    severity,
    attributes: { 'session.id': SESSION_ID, 'event.type': type, 'event.seq': seq },
    body,
  }
}

/** Convert a ReadableSpan HrTime tuple to epoch milliseconds. */
function millis(time: [number, number]): number {
  return time[0] * 1_000 + time[1] / 1_000_000
}

const HEADER = { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' }

describe('SessionSpanFolder', () => {
  let exporter: InMemorySpanExporter
  let folder: SessionSpanFolder

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    folder = new SessionSpanFolder(provider.getTracer('test'))
  })

  function spansByName(): Map<string, ReadableSpan> {
    return new Map(exporter.getFinishedSpans().map(span => [span.name, span]))
  }

  it('folds one turn into a turn/generation/tool span tree with record-time stamps', () => {
    folder.fold(ledger('request/header', 1, 1_000, HEADER))
    folder.fold(ledger('turn/start', 2, 1_010, { turn: 1 }))
    folder.fold(ledger('user/message', 3, 1_020, { role: 'user', content: [{ type: 'text', text: 'run the tests' }] }))
    folder.fold(ledger('step/start', 4, 1_030, { turn: 1, step: 0 }))
    folder.fold(ledger('assistant/chunk', 5, 1_500, { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'ok' } }))
    folder.fold(ledger('assistant/message', 6, 2_000, {
      turn: 1,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 },
    }))
    folder.fold(ledger('tool/call', 7, 2_010, { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"true"}' }))
    folder.fold(ledger('step/end', 8, 2_020, { turn: 1, step: 0 }))
    folder.fold(ledger('tool/result', 9, 2_500, {
      turn: 1,
      step: 0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }] },
    }))
    folder.fold(ledger('turn/end', 10, 3_000, { turn: 1, reason: { kind: 'completed' } }))

    const spans = spansByName()
    expect([...spans.keys()].sort()).toEqual(['step 0', 'tool bash', 'turn 1'])

    const turn = spans.get('turn 1')!
    expect(turn.parentSpanContext).toBeUndefined()
    expect(turn.attributes['langfuse.session.id']).toBe(SESSION_ID)
    expect(turn.attributes['langfuse.trace.input']).toContain('run the tests')
    expect(turn.attributes['dsh.turn.end_reason']).toContain('completed')
    expect(millis(turn.startTime)).toBe(1_010)
    expect(millis(turn.endTime)).toBe(3_000)

    const step = spans.get('step 0')!
    expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId)
    expect(step.attributes['langfuse.observation.type']).toBe('generation')
    expect(step.attributes['gen_ai.request.model']).toBe('deepseek-chat')
    expect(step.attributes['gen_ai.provider.name']).toBe('deepseek')
    expect(step.attributes['gen_ai.usage.input_tokens']).toBe(11)
    expect(step.attributes['gen_ai.usage.output_tokens']).toBe(3)
    expect(step.attributes['gen_ai.usage.cache_read_tokens']).toBe(2)
    expect(step.attributes['langfuse.observation.completion_start_time']).toBe(new Date(1_500).toISOString())
    expect(step.attributes['langfuse.observation.output']).toContain('done')
    expect(millis(step.startTime)).toBe(1_030)
    expect(millis(step.endTime)).toBe(2_020)

    // A step is one model request plus the tools it calls, so the tool span
    // nests under its requesting step's generation span.
    const tool = spans.get('tool bash')!
    expect(tool.parentSpanContext?.spanId).toBe(step.spanContext().spanId)
    expect(tool.attributes['langfuse.observation.type']).toBe('tool')
    expect(tool.attributes['gen_ai.tool.name']).toBe('bash')
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('call-1')
    expect(tool.attributes['langfuse.observation.output']).toContain('ok')
    expect(millis(tool.endTime)).toBe(2_500)
  })

  it('maps pre-mapped error severity onto span status, never re-deriving event semantics', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold(ledger('tool/call', 2, 1_010, { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' }))
    folder.fold(ledger('tool/result', 3, 1_020, {
      turn: 1,
      step: 0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], isError: true }] },
    }, 'error'))
    folder.fold(ledger('turn/end', 4, 1_030, { turn: 1, reason: { kind: 'error' } }, 'error'))

    const spans = spansByName()
    expect(spans.get('tool bash')!.status.code).toBe(SpanStatusCode.ERROR)
    expect(spans.get('turn 1')!.status.code).toBe(SpanStatusCode.ERROR)
    // No step/start was folded, so the tool span falls back to the turn parent.
    expect(spans.get('tool bash')!.parentSpanContext?.spanId).toBe(spans.get('turn 1')!.spanContext().spanId)
  })

  it('stamps model identity from a request/header appended inside its own step', () => {
    // The real loop appends request/header AFTER step/start (inside the
    // step, before dispatch), so the first step must receive the model
    // attributes retroactively rather than from a pre-seeded snapshot.
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold(ledger('step/start', 2, 1_010, { turn: 1, step: 1 }))
    folder.fold(ledger('request/header', 3, 1_020, HEADER))
    folder.fold(ledger('step/end', 4, 1_030, { turn: 1, step: 1 }))
    folder.fold(ledger('turn/end', 5, 1_040, { turn: 1, reason: { kind: 'completed' } }))

    const step = spansByName().get('step 1')!
    expect(step.attributes['gen_ai.request.model']).toBe('deepseek-chat')
    expect(step.attributes['gen_ai.provider.name']).toBe('deepseek')
  })

  it('treats seq gaps as routine: a step with no chunk record still folds cleanly', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold(ledger('step/start', 4, 1_010, { turn: 1, step: 0 }))
    folder.fold(ledger('step/end', 9, 1_020, { turn: 1, step: 0 }))
    folder.fold(ledger('turn/end', 12, 1_030, { turn: 1, reason: { kind: 'completed' } }))

    const step = spansByName().get('step 0')!
    expect(step.attributes['langfuse.observation.completion_start_time']).toBeUndefined()
    expect(millis(step.endTime)).toBe(1_020)
  })

  it('force-ends open spans on the shutdown sweep and marks them', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold(ledger('step/start', 2, 1_010, { turn: 1, step: 0 }))
    expect(exporter.getFinishedSpans()).toHaveLength(0)

    folder.endAll(5_000)
    const spans = spansByName()
    expect(spans.get('turn 1')!.attributes['dsh.force_ended']).toBe(true)
    expect(spans.get('step 0')!.attributes['dsh.force_ended']).toBe(true)
    expect(millis(spans.get('turn 1')!.endTime)).toBe(5_000)
  })

  it('closes a still-open turn when the next turn/start arrives', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold(ledger('turn/start', 5, 2_000, { turn: 2 }))
    folder.fold(ledger('turn/end', 8, 3_000, { turn: 2, reason: { kind: 'completed' } }))

    const spans = spansByName()
    expect(spans.get('turn 1')!.attributes['dsh.force_ended']).toBe(true)
    expect(millis(spans.get('turn 1')!.endTime)).toBe(2_000)
    expect(spans.get('turn 2')!.attributes['dsh.force_ended']).toBeUndefined()
  })

  it('lands unknown event types as span events on the open turn', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold(ledger('todo/write', 2, 1_010, { todos: [] }))
    folder.fold(ledger('turn/end', 3, 1_020, { turn: 1, reason: { kind: 'completed' } }))

    const turn = spansByName().get('turn 1')!
    expect(turn.events.map(event => event.name)).toContain('todo/write')
  })

  it('sweeps one session on its ops shutdown record without touching others', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold({
      channel: 'ops',
      time: 2_000,
      severity: 'info',
      attributes: { 'telemetry.op': 'shutdown', 'session.id': SESSION_ID },
      body: {},
    })
    expect(spansByName().get('turn 1')!.attributes['dsh.force_ended']).toBe(true)
  })

  it('clips oversized payloads at the configured attribute budget', () => {
    const clippedExporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(clippedExporter)],
    })
    const small = new SessionSpanFolder(provider.getTracer('test'), { maxAttributeChars: 64 })
    small.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    small.fold(ledger('tool/call', 2, 1_010, { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: 'x'.repeat(500) }))
    small.fold(ledger('tool/result', 3, 1_020, {
      turn: 1,
      step: 0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'y'.repeat(500) }] }] },
    }))
    small.fold(ledger('turn/end', 4, 1_030, { turn: 1, reason: { kind: 'completed' } }))

    const tool = clippedExporter.getFinishedSpans().find(span => span.name === 'tool bash')!
    const input = tool.attributes['langfuse.observation.input'] as string
    const output = tool.attributes['langfuse.observation.output'] as string
    for (const clipped of [input, output]) {
      expect(clipped.endsWith('…[clipped]')).toBe(true)
      expect(clipped.length).toBe(64 + '…[clipped]'.length)
    }
  })

  it.todo('FEEDBACK_ONLY replay: a historical prefix rebuilds the identical tree (same mechanism, add a scripted replay fixture)')
  it.todo('fork/resume lineage: seeds never re-fold; stitch via session.parent_id trace links')
  it.todo('agent-error ops record marks the open turn span with an exception event')
})
