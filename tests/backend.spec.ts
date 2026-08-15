/**
 * Backend/coordinator integration tier. The OTel transport is replaced with
 * an in-memory SDK pipeline, while the real SessionStore, canonical feedback
 * producer, capture coordinator, backend, and folding projection stay intact.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

const pipelines = vi.hoisted(() => [] as unknown[])

vi.mock('../src/otel.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/otel.ts')>()
  const {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
  } = await import('@opentelemetry/sdk-trace-base')
  return {
    ...original,
    buildTracerPipeline: (options: { scopeName: string; scopeVersion: string }) => {
      const exporter = new InMemorySpanExporter()
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      })
      pipelines.push({ exporter, provider })
      return {
        provider,
        tracer: provider.getTracer(options.scopeName, options.scopeVersion),
      }
    },
  }
})

import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'
import {
  LangfuseSessionTelemetryBackend,
  LangfuseTelemetryMode,
} from '../src/index.ts'

interface CapturedPipeline {
  exporter: { getFinishedSpans(): ReadableSpan[] }
}

const USER_MESSAGE = createUserMessage({
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'user' },
})
const ASSISTANT_MESSAGE = createAssistantMessage({
  content: [{ type: 'text', text: 'world' }],
  source: { provider: 'test-provider', model: 'test-model' },
})

beforeEach(() => {
  pipelines.length = 0
})

function appendTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', USER_MESSAGE, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: ASSISTANT_MESSAGE,
    usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

async function mount(mode: LangfuseTelemetryMode): Promise<{
  ctx: Context
  session: Session
  pipeline: CapturedPipeline
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LangfuseSessionTelemetryBackend, {
    mode,
    exporter: { url: 'https://example.invalid/api/public/otel/v1/traces' },
    auth: { publicKey: 'pk-test', secretKey: 'sk-test' },
  })
  const pipeline = pipelines.at(-1) as CapturedPipeline | undefined
  if (pipeline === undefined) throw new Error('test OTel pipeline was not constructed')
  return { ctx, session: ctx.sessions.create(SessionId('feedback-replay')), pipeline }
}

/** Stable tree shape independent of random OTel trace/span identifiers. */
function normalize(spans: ReadableSpan[]): unknown[] {
  const namesBySpanId = new Map(spans.map(span => [span.spanContext().spanId, span.name]))
  return spans.map(span => ({
    name: span.name,
    parent: span.parentSpanContext === undefined ? undefined : namesBySpanId.get(span.parentSpanContext.spanId),
    attributes: span.attributes,
  })).sort((a, b) => a.name.localeCompare(b.name))
}

describe('LangfuseSessionTelemetryBackend FEEDBACK_ONLY', () => {
  it('replays only a canonical feedback-gated prefix through the same tree projection as FULL', async () => {
    const full = await mount(LangfuseTelemetryMode.FULL)
    appendTurn(full.session)
    const expected = normalize(full.pipeline.exporter.getFinishedSpans())

    const gated = await mount(LangfuseTelemetryMode.FEEDBACK_ONLY)
    appendTurn(gated.session)

    // Neither continuous capture nor the public backend service can bypass
    // the feedback gate.
    const service = gated.ctx.get('sessionTelemetry')!
    service.emit({
      channel: 'ledger',
      time: Date.now(),
      severity: 'info',
      attributes: { 'session.id': 'direct', 'event.type': 'turn/start', 'event.seq': 0 },
      body: { turn: 99 },
    })
    service.emit({
      channel: 'ledger',
      time: Date.now(),
      severity: 'info',
      attributes: { 'session.id': 'direct', 'event.type': 'turn/end', 'event.seq': 1 },
      body: { turn: 99, reason: { kind: 'completed' } },
    })
    expect(gated.pipeline.exporter.getFinishedSpans()).toEqual([])

    // A bus-shaped value that is not the exact canonical log object is not
    // consent and must not release history.
    const forged = {
      type: 'feedback/record',
      seq: 999,
      time: Date.now(),
      data: { text: 'forged' },
    } as SessionEvent<'feedback/record'>
    gated.ctx.emit('session/event', gated.session, forged)
    expect(gated.pipeline.exporter.getFinishedSpans()).toEqual([])

    recordFeedback(gated.session, 'release this prefix')
    expect(normalize(gated.pipeline.exporter.getFinishedSpans())).toEqual(expected)

    // A later feedback with no new trace-producing events advances the
    // canonical cursor but must not replay the already released tree.
    const firstCaptureCount = gated.pipeline.exporter.getFinishedSpans().length
    recordFeedback(gated.session, 'release nothing new')
    expect(gated.pipeline.exporter.getFinishedSpans()).toHaveLength(firstCaptureCount)

    // Continuous capture remains disabled after consent. A later turn stays
    // local until another canonical feedback releases only that new suffix.
    gated.session.append('turn/start', { turn: 2 })
    gated.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(gated.pipeline.exporter.getFinishedSpans()).toHaveLength(firstCaptureCount)
    recordFeedback(gated.session, 'release the second turn')
    const afterSecondPrefix = gated.pipeline.exporter.getFinishedSpans()
    expect(afterSecondPrefix).toHaveLength(firstCaptureCount + 1)
    expect(afterSecondPrefix.filter(span => span.name === 'turn 1')).toHaveLength(1)
    expect(afterSecondPrefix.filter(span => span.name === 'turn 2')).toHaveLength(1)

    await gated.ctx.fiber.dispose()
    await full.ctx.fiber.dispose()
  })
})
