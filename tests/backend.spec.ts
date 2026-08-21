/**
 * Backend/coordinator integration tier. The OTel transport is replaced with
 * an in-memory SDK pipeline, while the real SessionStore, canonical feedback
 * producer, capture coordinator, backend, and folding projection stay intact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TraceFlags } from '@opentelemetry/api'
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
    buildTracerPipeline: (options: {
      scopeName: string
      scopeVersion: string
      onExportResult?: (success: boolean, spanCount: number, error?: Error) => void
    }) => {
      const exporter = new InMemorySpanExporter()
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      })
      pipelines.push({ exporter, provider, onExportResult: options.onExportResult })
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
  createDshTurnTraceId,
  type Config,
} from '../src/index.ts'

interface CapturedPipeline {
  exporter: { getFinishedSpans(): ReadableSpan[] }
  onExportResult?: (success: boolean, spanCount: number, error?: Error) => void
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

afterEach(() => {
  vi.unstubAllGlobals()
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

async function mount(mode: LangfuseTelemetryMode, feedbackScores?: Config['feedbackScores']): Promise<{
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
    feedbackScores,
  })
  const pipeline = pipelines.at(-1) as CapturedPipeline | undefined
  if (pipeline === undefined) throw new Error('test OTel pipeline was not constructed')
  return { ctx, session: ctx.sessions.create(SessionId('feedback-replay')), pipeline }
}

/** Stable tree shape including the now-deterministic OTel Trace ID. */
function normalize(spans: ReadableSpan[]): unknown[] {
  const namesBySpanId = new Map(spans.map(span => [span.spanContext().spanId, span.name]))
  return spans.map(span => ({
    name: span.name,
    traceId: span.spanContext().traceId,
    parent: span.parentSpanContext === undefined ? undefined : namesBySpanId.get(span.parentSpanContext.spanId),
    attributes: span.attributes,
  })).sort((a, b) => a.name.localeCompare(b.name))
}

describe('LangfuseSessionTelemetryBackend', () => {
  it('exposes observed exporter failure and recovery through the public status API', async () => {
    const mounted = await mount(LangfuseTelemetryMode.FULL)
    const backend = mounted.ctx.get('sessionTelemetry') as LangfuseSessionTelemetryBackend
    expect(backend.status().state).toBe('starting')

    mounted.pipeline.onExportResult?.(false, 2, Object.assign(new Error('HTTP 503'), { code: 'UNAVAILABLE' }))
    expect(backend.status()).toMatchObject({
      state: 'degraded',
      traces: {
        failedBatches: 1,
        failedSpans: 2,
        consecutiveFailures: 1,
        lastError: { code: 'UNAVAILABLE', message: 'HTTP 503' },
      },
    })

    mounted.pipeline.onExportResult?.(true, 3)
    expect(backend.status()).toMatchObject({
      state: 'healthy',
      traces: {
        successfulBatches: 1,
        successfulSpans: 3,
        failedBatches: 1,
        failedSpans: 2,
        consecutiveFailures: 0,
      },
    })

    await mounted.ctx.fiber.dispose()
  })

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
    expect(gated.pipeline.exporter.getFinishedSpans().find(span => span.name === 'turn 1')?.spanContext().traceId)
      .toBe(createDshTurnTraceId('feedback-replay', 1))

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
    expect(afterSecondPrefix.find(span => span.name === 'turn 2')?.spanContext().traceId)
      .toBe(createDshTurnTraceId('feedback-replay', 2))

    await gated.ctx.fiber.dispose()
    await full.ctx.fiber.dispose()
  })

  it('carries a per-turn W3C parent through the real telemetry waterfall', async () => {
    const mounted = await mount(LangfuseTelemetryMode.FULL)
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const parentSpanId = '00f067aa0ba902b7'
    mounted.ctx.on('session-telemetry/record', (record, next) => {
      const outbound = next()
      if (outbound.attributes['event.type'] !== 'turn/start') return outbound
      return {
        ...outbound,
        attributes: {
          ...outbound.attributes,
          traceparent: `00-${traceId}-${parentSpanId}-01`,
          tracestate: 'host=runtime',
        },
      }
    })

    appendTurn(mounted.session)
    const turn = mounted.pipeline.exporter.getFinishedSpans().find(span => span.name === 'turn 1')!
    expect(turn.spanContext().traceId).toBe(traceId)
    expect(turn.parentSpanContext).toMatchObject({
      traceId,
      spanId: parentSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    })
    expect(turn.parentSpanContext?.traceState?.serialize()).toBe('host=runtime')
    expect(turn.attributes['dsh.trace.deterministic_id'])
      .toBe(createDshTurnTraceId('feedback-replay', 1))

    await mounted.ctx.fiber.dispose()
  })

  it('sends only canonical FEEDBACK_ONLY consent as a Score', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init !== undefined) requests.push(init)
      return new Response('{}', { status: 201 })
    }))
    const mounted = await mount(LangfuseTelemetryMode.FEEDBACK_ONLY, {
      enabled: true,
      url: 'https://example.invalid/api/public/scores',
    })
    appendTurn(mounted.session)

    const forged = {
      type: 'feedback/record',
      seq: 999,
      time: Date.now(),
      data: { text: 'forged' },
    } as SessionEvent<'feedback/record'>
    mounted.ctx.emit('session/event', mounted.session, forged)
    expect(requests).toHaveLength(0)

    recordFeedback(mounted.session, 'canonical feedback')
    await mounted.ctx.fiber.dispose()

    expect(requests).toHaveLength(1)
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      sessionId: 'feedback-replay',
      name: 'dsh_user_feedback',
      value: 'canonical feedback',
      dataType: 'TEXT',
      metadata: { dshTelemetryMode: 'FEEDBACK_ONLY' },
    })
  })

  it('uses the post-waterfall redacted text and feedback-level subject', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init !== undefined) requests.push(init)
      return new Response('{}', { status: 201 })
    }))
    const mounted = await mount(LangfuseTelemetryMode.FULL, {
      enabled: true,
      url: 'https://example.invalid/api/public/scores',
    })
    mounted.ctx.on('session-telemetry/record', (record, next) => {
      const outbound = next()
      if (outbound.attributes['event.type'] !== 'feedback/record') return outbound
      return {
        ...outbound,
        attributes: {
          ...outbound.attributes,
          'langfuse.session.id': 'feedback-subject',
        },
        body: { text: '[redacted by host]' },
      }
    })

    appendTurn(mounted.session)
    recordFeedback(mounted.session, 'raw secret feedback')
    expect(mounted.pipeline.exporter.getFinishedSpans().length).toBeGreaterThan(0)
    await mounted.ctx.fiber.dispose()

    const body = JSON.parse(String(requests[0]?.body)) as Record<string, unknown>
    expect(requests).toHaveLength(1)
    expect(body).toMatchObject({
      sessionId: 'feedback-subject',
      value: '[redacted by host]',
    })
    expect(JSON.stringify(body)).not.toContain('raw secret feedback')
  })

  it('does not send feedback withheld by a throwing fail-closed waterfall rule', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetcher)
    const mounted = await mount(LangfuseTelemetryMode.FULL, {
      enabled: true,
      url: 'https://example.invalid/api/public/scores',
    })
    mounted.ctx.on('session-telemetry/record', (record, next) => {
      const outbound = next()
      if (outbound.attributes['event.type'] === 'feedback/record') throw new Error('withhold feedback')
      return outbound
    })

    appendTurn(mounted.session)
    expect(() => recordFeedback(mounted.session, 'must remain local')).not.toThrow()
    await mounted.ctx.fiber.dispose()

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps trace shutdown successful when the Score endpoint rejects a payload', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 400 }))
    vi.stubGlobal('fetch', fetcher)
    const mounted = await mount(LangfuseTelemetryMode.FULL, {
      enabled: true,
      url: 'https://example.invalid/api/public/scores',
    })
    appendTurn(mounted.session)
    recordFeedback(mounted.session, 'will fail remotely')
    expect(mounted.pipeline.exporter.getFinishedSpans().length).toBeGreaterThan(0)

    await expect(mounted.ctx.fiber.dispose()).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
