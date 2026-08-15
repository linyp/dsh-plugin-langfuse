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
function ledger(type: string, seq: number, time: number, body: unknown, severity: 'info' | 'warn' | 'error' = 'info', extraAttributes: Record<string, string | number> = {}): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time,
    severity,
    attributes: { 'session.id': SESSION_ID, 'event.type': type, 'event.seq': seq, ...extraAttributes },
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
      usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 3 },
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
    expect(turn.attributes['dsh.session.id']).toBe(SESSION_ID)
    expect(turn.attributes['langfuse.observation.input']).toContain('run the tests')
    expect(turn.attributes['langfuse.observation.output']).toContain('done')
    // Deprecated aliases remain while trace-level evaluators migrate to the
    // v4 root-observation contract.
    expect(turn.attributes['langfuse.trace.input']).toContain('run the tests')
    expect(turn.attributes['langfuse.trace.output']).toContain('done')
    expect(turn.attributes['dsh.turn.end_reason']).toContain('completed')
    expect(millis(turn.startTime)).toBe(1_010)
    expect(millis(turn.endTime)).toBe(3_000)

    const step = spans.get('step 0')!
    expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId)
    expect(step.attributes['langfuse.observation.type']).toBe('generation')
    // Langfuse v4 filters and aggregates per observation, so identity rides
    // every span, not only the trace root.
    expect(step.attributes['langfuse.session.id']).toBe(SESSION_ID)
    expect(step.attributes['gen_ai.request.model']).toBe('deepseek-chat')
    expect(step.attributes['gen_ai.provider.name']).toBe('deepseek')
    expect(step.attributes['gen_ai.usage.input_tokens']).toBe(16)
    expect(step.attributes['gen_ai.usage.output_tokens']).toBe(3)
    expect(step.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(2)
    expect(step.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(3)
    expect(step.attributes['langfuse.observation.completion_start_time']).toBe(new Date(1_500).toISOString())
    expect(step.attributes['langfuse.observation.output']).toContain('done')
    expect(millis(step.startTime)).toBe(1_030)
    expect(millis(step.endTime)).toBe(2_020)

    // A step is one model request plus the tools it calls, so the tool span
    // nests under its requesting step's generation span.
    const tool = spans.get('tool bash')!
    expect(tool.parentSpanContext?.spanId).toBe(step.spanContext().spanId)
    expect(tool.attributes['langfuse.observation.type']).toBe('tool')
    expect(tool.attributes['langfuse.session.id']).toBe(SESSION_ID)
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

  it('keeps the latest assistant message as the root observation output', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold(ledger('step/start', 2, 1_010, { turn: 1, step: 0 }))
    folder.fold(ledger('assistant/message', 3, 1_020, {
      turn: 1,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'intermediate' }] },
    }))
    folder.fold(ledger('step/end', 4, 1_030, { turn: 1, step: 0 }))
    folder.fold(ledger('step/start', 5, 1_040, { turn: 1, step: 1 }))
    folder.fold(ledger('assistant/message', 6, 1_050, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    }))
    folder.fold(ledger('step/end', 7, 1_060, { turn: 1, step: 1 }))
    folder.fold(ledger('turn/end', 8, 1_070, { turn: 1, reason: { kind: 'completed' } }))

    const spans = spansByName()
    expect(spans.get('step 0')!.attributes['langfuse.observation.output']).toContain('intermediate')
    expect(spans.get('step 1')!.attributes['langfuse.observation.output']).toContain('final answer')
    expect(spans.get('turn 1')!.attributes['langfuse.observation.output']).toContain('final answer')
    expect(spans.get('turn 1')!.attributes['langfuse.trace.output']).toContain('final answer')
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

  it('stamps configured correlation identity on every span, keeping dsh.session.id on the root', () => {
    const correlatedExporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(correlatedExporter)],
    })
    const correlated = new SessionSpanFolder(provider.getTracer('test'), {
      correlation: { userId: 'host-user-42', sessionId: 'host-conversation-789' },
    })
    correlated.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    correlated.fold(ledger('step/start', 2, 1_010, { turn: 1, step: 0 }))
    correlated.fold(ledger('tool/call', 3, 1_020, { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' }))
    correlated.fold(ledger('tool/result', 4, 1_030, {
      turn: 1,
      step: 0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] },
    }))
    correlated.fold(ledger('step/end', 5, 1_040, { turn: 1, step: 0 }))
    correlated.fold(ledger('turn/end', 6, 1_050, { turn: 1, reason: { kind: 'completed' } }))

    const spans = new Map(correlatedExporter.getFinishedSpans().map(span => [span.name, span]))
    const turn = spans.get('turn 1')!
    expect(turn.attributes['langfuse.session.id']).toBe('host-conversation-789')
    expect(turn.attributes['langfuse.user.id']).toBe('host-user-42')
    expect(turn.attributes['dsh.session.id']).toBe(SESSION_ID)
    // Identity rides child observations for v4 per-observation queries; the
    // diagnostic dsh.session.id pointer stays root-only.
    for (const name of ['step 0', 'tool bash']) {
      const span = spans.get(name)!
      expect(span.attributes['langfuse.session.id']).toBe('host-conversation-789')
      expect(span.attributes['langfuse.user.id']).toBe('host-user-42')
      expect(span.attributes['dsh.session.id']).toBeUndefined()
    }
  })

  it('locks identity at turn/start: dynamic attributes there win, later ones are ignored', () => {
    const correlatedExporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(correlatedExporter)],
    })
    const correlated = new SessionSpanFolder(provider.getTracer('test'), {
      correlation: { userId: 'config-user', sessionId: 'config-session' },
    })
    // A deployment waterfall listener injected dynamic identity onto the
    // turn/start record; it outranks the static config for this turn.
    correlated.fold(ledger('turn/start', 1, 1_000, { turn: 1 }, 'info', {
      'langfuse.user.id': 'dynamic-user',
      'langfuse.session.id': 'dynamic-session',
    }))
    // Identity attributes on any later record must not reopen the snapshot.
    correlated.fold(ledger('step/start', 2, 1_010, { turn: 1, step: 0 }, 'info', {
      'langfuse.user.id': 'late-user',
      'langfuse.session.id': 'late-session',
    }))
    correlated.fold(ledger('step/end', 3, 1_020, { turn: 1, step: 0 }))
    correlated.fold(ledger('turn/end', 4, 1_030, { turn: 1, reason: { kind: 'completed' } }))
    // The next turn carries no dynamic identity, so the static config resumes.
    correlated.fold(ledger('turn/start', 5, 2_000, { turn: 2 }))
    correlated.fold(ledger('turn/end', 6, 2_010, { turn: 2, reason: { kind: 'completed' } }))

    const spans = new Map(correlatedExporter.getFinishedSpans().map(span => [span.name, span]))
    expect(spans.get('turn 1')!.attributes['langfuse.session.id']).toBe('dynamic-session')
    expect(spans.get('turn 1')!.attributes['langfuse.user.id']).toBe('dynamic-user')
    expect(spans.get('step 0')!.attributes['langfuse.session.id']).toBe('dynamic-session')
    expect(spans.get('step 0')!.attributes['langfuse.user.id']).toBe('dynamic-user')
    expect(spans.get('turn 2')!.attributes['langfuse.session.id']).toBe('config-session')
    expect(spans.get('turn 2')!.attributes['langfuse.user.id']).toBe('config-user')
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

  it('marks the open turn when an agent-error ops record arrives', () => {
    folder.fold(ledger('turn/start', 1, 1_000, { turn: 1 }))
    folder.fold({
      channel: 'ops',
      time: 1_010,
      severity: 'error',
      attributes: {
        'telemetry.op': 'agent-error',
        'session.id': SESSION_ID,
        'error.name': 'TypeError',
      },
      body: { name: 'TypeError', message: 'adapter exploded' },
    })
    folder.fold(ledger('turn/end', 2, 1_020, { turn: 1, reason: { kind: 'error' } }, 'error'))

    const turn = spansByName().get('turn 1')!
    expect(turn.status.code).toBe(SpanStatusCode.ERROR)
    expect(turn.events).toContainEqual(expect.objectContaining({
      name: 'agent-error',
      attributes: { 'error.name': 'TypeError' },
    }))
  })

  it.todo('[v0.2] fork/resume lineage: seeds never re-fold; stitch via session.parent_id trace links')
})
