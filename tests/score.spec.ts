import { describe, expect, it, vi } from 'vitest'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import { createDshFeedbackScoreId } from '../src/identity.ts'
import { TelemetryIdentityRegistry } from '../src/identity-registry.ts'
import {
  FEEDBACK_SCORE_NAME,
  FeedbackScoreSink,
  LangfuseScoreHttpTransport,
  MAX_TEXT_SCORE_CHARS,
  ScoreTransportError,
  mapFeedbackRecord,
  type ScoreTransport,
  type SessionTextScore,
} from '../src/score.ts'

const EVENT_TIME = Date.UTC(2026, 7, 15, 3, 4, 5, 6)

function feedbackRecord(options: {
  sessionId?: string
  seq?: number
  text?: unknown
  langfuseSessionId?: string
  time?: number
} = {}): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time: options.time ?? EVENT_TIME,
    severity: 'info',
    attributes: {
      'session.id': options.sessionId ?? 'dsh-session',
      'event.type': 'feedback/record',
      'event.seq': options.seq ?? 7,
      ...options.langfuseSessionId === undefined
        ? {}
        : { 'langfuse.session.id': options.langfuseSessionId },
    },
    body: { text: options.text ?? 'helpful answer' },
  }
}

function mapperOptions(identityRegistry = new TelemetryIdentityRegistry()) {
  return { identityRegistry, mode: 'FULL' as const }
}

describe('feedback Score identity and mapping', () => {
  it('keeps fixed SHA-256 vectors for the v1 Score wire contract', () => {
    expect(createDshFeedbackScoreId('ses-test-1', 1)).toBe('6065d65017a386bb68621d0febe7a2b9')
    expect(createDshFeedbackScoreId('ses-test-1', 2)).toBe('6d4f70bf6a93ea35858c1769ad4ffc19')
    expect(createDshFeedbackScoreId('你好-session', 42)).toBe('289c7badc65c18183603dc8755c93696')
  })

  it('rejects inputs that cannot identify a canonical feedback event', () => {
    expect(() => createDshFeedbackScoreId('', 1)).toThrow(/dshSessionId must be non-empty/)
    expect(() => createDshFeedbackScoreId('session', -1)).toThrow(/eventSeq/)
    expect(() => createDshFeedbackScoreId('session', 1.5)).toThrow(/eventSeq/)
  })

  it('maps post-waterfall feedback to the current Langfuse TEXT Score body', () => {
    const score = mapFeedbackRecord(feedbackRecord(), {
      ...mapperOptions(),
      staticSessionId: 'host-session',
    })
    expect(score).toEqual({
      id: createDshFeedbackScoreId('dsh-session', 7),
      sessionId: 'host-session',
      name: FEEDBACK_SCORE_NAME,
      value: 'helpful answer',
      dataType: 'TEXT',
      metadata: {
        dshSessionId: 'dsh-session',
        dshEventSeq: 7,
        dshEventTime: '2026-08-15T03:04:05.006Z',
        dshTelemetryMode: 'FULL',
        truncated: false,
      },
    })
    expect(score).not.toHaveProperty('timestamp')
    expect(score).not.toHaveProperty('stringValue')
  })

  it('resolves subject as explicit record, latest turn, static config, then DSH session', () => {
    const registry = new TelemetryIdentityRegistry()
    registry.beginTurn({
      dshSessionId: 'dsh-session',
      turn: 1,
      startSeq: 0,
      langfuseSessionId: 'turn-session-one',
    })
    registry.beginTurn({
      dshSessionId: 'dsh-session',
      turn: 2,
      startSeq: 5,
      langfuseSessionId: 'turn-session-two',
    })
    const ambiguous = vi.fn()
    const latest = mapFeedbackRecord(feedbackRecord(), {
      identityRegistry: registry,
      mode: 'FULL',
      staticSessionId: 'static-session',
      onAmbiguousSubject: ambiguous,
    })
    expect(latest?.sessionId).toBe('turn-session-two')
    expect(ambiguous).toHaveBeenCalledOnce()

    const explicit = mapFeedbackRecord(feedbackRecord({ langfuseSessionId: 'feedback-session' }), {
      identityRegistry: registry,
      mode: 'FULL',
      staticSessionId: 'static-session',
      onAmbiguousSubject: ambiguous,
    })
    expect(explicit?.sessionId).toBe('feedback-session')
    expect(ambiguous).toHaveBeenCalledOnce()

    expect(mapFeedbackRecord(feedbackRecord({ sessionId: 'without-registry' }), {
      ...mapperOptions(),
      staticSessionId: 'static-session',
    })?.sessionId).toBe('static-session')
    expect(mapFeedbackRecord(feedbackRecord({ sessionId: 'dsh-fallback' }), mapperOptions())?.sessionId)
      .toBe('dsh-fallback')
  })

  it('clips safely by Unicode code points and keeps the marker within 500 characters', () => {
    const score = mapFeedbackRecord(feedbackRecord({ text: '😀'.repeat(501) }), mapperOptions())
    expect(Array.from(score!.value)).toHaveLength(MAX_TEXT_SCORE_CHARS)
    expect(score!.value).toMatch(/…\[clipped\]$/)
    expect(score!.metadata.truncated).toBe(true)
  })

  it.each([
    feedbackRecord({ text: '' }),
    feedbackRecord({ text: '   ' }),
    feedbackRecord({ text: 42 }),
    { ...feedbackRecord(), body: 'redacted' },
    { ...feedbackRecord(), channel: 'ops' as const },
    feedbackRecord({ time: Number.MAX_VALUE }),
  ])('skips empty, invalid, or non-ledger records', (record) => {
    expect(mapFeedbackRecord(record, mapperOptions())).toBeUndefined()
  })
})

describe('LangfuseScoreHttpTransport', () => {
  it('uses fresh async auth headers and sends value without a synthetic timestamp', async () => {
    const requests: Array<{ input: string; init: RequestInit | undefined }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input: String(input), init })
      return new Response('{}', { status: 201 })
    }) as typeof globalThis.fetch
    let headerVersion = 0
    const headers = vi.fn(async () => ({ authorization: `Basic rotating-${++headerVersion}` }))
    const transport = new LangfuseScoreHttpTransport({
      url: 'https://example.test/api/public/scores',
      headers,
      fetch: fetcher,
    })
    const score = mapFeedbackRecord(feedbackRecord(), mapperOptions())!

    await transport.send(score)
    await transport.send({ ...score, id: createDshFeedbackScoreId('dsh-session', 8) })

    expect(headers).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.input).toBe('https://example.test/api/public/scores')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(requests[0]?.init?.headers).toEqual({
      authorization: 'Basic rotating-1',
      'content-type': 'application/json',
    })
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: 'Basic rotating-2' })
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ value: 'helpful answer', dataType: 'TEXT' })
    expect(body).not.toHaveProperty('timestamp')
    expect(body).not.toHaveProperty('stringValue')
  })

  it('forces JSON content type even when reused OTLP headers specify another representation', async () => {
    const requests: RequestInit[] = []
    const transport = new LangfuseScoreHttpTransport({
      url: 'https://example.test/api/public/scores',
      headers: { authorization: 'Basic test', 'Content-Type': 'application/x-protobuf' },
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init !== undefined) requests.push(init)
        return new Response('{}', { status: 201 })
      }) as typeof globalThis.fetch,
    })

    await transport.send(mapFeedbackRecord(feedbackRecord(), mapperOptions())!)

    expect(requests[0]?.headers).toEqual({
      authorization: 'Basic test',
      'content-type': 'application/json',
    })
  })

  it.each([
    [400, false],
    [429, true],
    [503, true],
  ])('classifies HTTP %i retryability as %s', async (status, retriable) => {
    const transport = new LangfuseScoreHttpTransport({
      url: 'https://example.test/api/public/scores',
      headers: { authorization: 'Basic test' },
      fetch: vi.fn(async () => new Response('{}', { status })) as typeof globalThis.fetch,
    })
    await expect(transport.send(mapFeedbackRecord(feedbackRecord(), mapperOptions())!))
      .rejects.toMatchObject({ status, retriable })
  })

  it('turns request timeout into a retriable transport error', async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as typeof globalThis.fetch
    const transport = new LangfuseScoreHttpTransport({
      url: 'https://example.test/api/public/scores',
      headers: { authorization: 'Basic test' },
      requestTimeoutMillis: 1,
      fetch: fetcher,
    })
    await expect(transport.send(mapFeedbackRecord(feedbackRecord(), mapperOptions())!))
      .rejects.toMatchObject({ retriable: true })
  })

  it('rejects invalid direct-construction timeout values', () => {
    expect(() => new LangfuseScoreHttpTransport({
      url: 'https://example.test/api/public/scores',
      headers: { authorization: 'Basic test' },
      requestTimeoutMillis: 0,
    })).toThrow(/request timeout/)
  })
})

describe('FeedbackScoreSink', () => {
  it('rejects invalid direct-construction queue bounds', () => {
    const transport: ScoreTransport = { send: async () => {}, shutdown: async () => {} }
    expect(() => new FeedbackScoreSink({ ...mapperOptions(), transport, maxQueueSize: 0 }))
      .toThrow(/maxQueueSize/)
  })

  it('retries transient errors at most three times with the identical Score ID', async () => {
    const sent: SessionTextScore[] = []
    const transport: ScoreTransport = {
      send: vi.fn(async (score) => {
        sent.push(score)
        if (sent.length < 3) throw new ScoreTransportError('temporary', true)
      }),
      shutdown: vi.fn(async () => {}),
    }
    const sink = new FeedbackScoreSink({
      ...mapperOptions(),
      transport,
      sleep: async () => {},
    })
    sink.accept(feedbackRecord())
    await sink.shutdown()

    expect(sent).toHaveLength(3)
    expect(new Set(sent.map(score => score.id)).size).toBe(1)
    expect(sink.failedCount).toBe(0)
    expect(transport.shutdown).toHaveBeenCalledOnce()
  })

  it('does not initiate transport work inside the synchronous accept call', async () => {
    const transport: ScoreTransport = {
      send: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    }
    const onEvent = vi.fn()
    const sink = new FeedbackScoreSink({ ...mapperOptions(), transport, onEvent })

    sink.accept(feedbackRecord())
    expect(transport.send).not.toHaveBeenCalled()
    expect(sink.queuedCount).toBe(1)
    expect(onEvent).toHaveBeenCalledWith({ kind: 'queued' })

    await sink.shutdown()
    expect(transport.send).toHaveBeenCalledOnce()
    expect(sink.deliveredCount).toBe(1)
    expect(onEvent).toHaveBeenLastCalledWith({ kind: 'delivered' })
  })

  it('does not retry permanent 4xx failures', async () => {
    const transport: ScoreTransport = {
      send: vi.fn(async () => { throw new ScoreTransportError('bad request', false, 400) }),
      shutdown: vi.fn(async () => {}),
    }
    const sink = new FeedbackScoreSink({ ...mapperOptions(), transport, sleep: async () => {} })
    sink.accept(feedbackRecord())
    await sink.shutdown()

    expect(transport.send).toHaveBeenCalledOnce()
    expect(sink.failedCount).toBe(1)
  })

  it('drops newest on overflow and isolates a throwing host logger', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const transport: ScoreTransport = {
      send: vi.fn(async () => gate),
      shutdown: vi.fn(async () => {}),
    }
    const sink = new FeedbackScoreSink({
      ...mapperOptions(),
      transport,
      maxQueueSize: 1,
      onWarning: () => { throw new Error('logger failed') },
    })

    expect(() => sink.accept(feedbackRecord({ seq: 1 }))).not.toThrow()
    expect(() => sink.accept(feedbackRecord({ seq: 2 }))).not.toThrow()
    expect(sink.droppedCount).toBe(1)
    release()
    await sink.shutdown()
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('skips invalid post-waterfall feedback without calling transport', async () => {
    const transport: ScoreTransport = {
      send: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    }
    const sink = new FeedbackScoreSink({ ...mapperOptions(), transport })
    sink.accept(feedbackRecord({ text: '   ' }))
    await sink.shutdown()
    expect(sink.skippedCount).toBe(1)
    expect(transport.send).not.toHaveBeenCalled()
  })
})
