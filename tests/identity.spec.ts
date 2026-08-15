import { describe, expect, it } from 'vitest'
import { TraceFlags, trace } from '@opentelemetry/api'
import {
  SYNTHETIC_PARENT_SPAN_ID,
  createDshTurnTraceId,
  createTurnParentContext,
  parseW3CTraceContext,
} from '../src/identity.ts'
import { TelemetryIdentityRegistry } from '../src/identity-registry.ts'

const EXTERNAL_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const EXTERNAL_SPAN_ID = '00f067aa0ba902b7'
const TRACEPARENT = `00-${EXTERNAL_TRACE_ID}-${EXTERNAL_SPAN_ID}-01`

describe('stable turn identity', () => {
  it('keeps fixed SHA-256 test vectors for the v1 wire contract', () => {
    expect(createDshTurnTraceId('ses-test-1', 1)).toBe('0eda5e63686080e82ee0a5ee2d2a2ef1')
    expect(createDshTurnTraceId('ses-test-1', 2)).toBe('e00c9c24ff99295ac8daadae578e233b')
    expect(createDshTurnTraceId('你好-session', 42)).toBe('e5916e2ed476c02f4016ae01d87a9d91')
  })

  it('rejects identity inputs that cannot name a canonical turn', () => {
    expect(() => createDshTurnTraceId('', 1)).toThrow(/dshSessionId must be non-empty/)
    expect(() => createDshTurnTraceId('session', -1)).toThrow(/non-negative safe integer/)
    expect(() => createDshTurnTraceId('session', 1.5)).toThrow(/non-negative safe integer/)
  })

  it('uses a sampled synthetic parent for deterministic Trace ID injection', () => {
    const resolved = createTurnParentContext({ dshSessionId: 'ses-test-1', turn: 1 })
    expect(resolved.source).toBe('deterministic')
    expect(resolved.traceId).toBe(createDshTurnTraceId('ses-test-1', 1))
    expect(resolved.parentSpanContext).toMatchObject({
      traceId: resolved.deterministicTraceId,
      spanId: SYNTHETIC_PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    })
    expect(trace.getSpanContext(resolved.parentContext)).toEqual(resolved.parentSpanContext)
  })
})

describe('W3C turn parent context', () => {
  it('parses a valid remote parent and tracestate', () => {
    const parsed = parseW3CTraceContext(TRACEPARENT, 'vendor=value')
    expect(parsed).toMatchObject({
      traceId: EXTERNAL_TRACE_ID,
      spanId: EXTERNAL_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    })
    expect(parsed?.traceState?.serialize()).toBe('vendor=value')
  })

  it('accepts future traceparent versions but enforces version 00 width', () => {
    expect(parseW3CTraceContext(`01-${EXTERNAL_TRACE_ID}-${EXTERNAL_SPAN_ID}-01-extra`)).toBeDefined()
    expect(parseW3CTraceContext(`${TRACEPARENT}-extra`)).toBeUndefined()
  })

  it.each([
    '',
    `ff-${EXTERNAL_TRACE_ID}-${EXTERNAL_SPAN_ID}-01`,
    `00-${'0'.repeat(32)}-${EXTERNAL_SPAN_ID}-01`,
    `00-${EXTERNAL_TRACE_ID}-${'0'.repeat(16)}-01`,
    `00-${EXTERNAL_TRACE_ID.toUpperCase()}-${EXTERNAL_SPAN_ID}-01`,
  ])('rejects invalid traceparent %j', (value) => {
    expect(parseW3CTraceContext(value)).toBeUndefined()
  })

  it('prefers a valid external parent and retains the stable DSH logical id', () => {
    const resolved = createTurnParentContext({
      dshSessionId: 'ses-test-1',
      turn: 1,
      traceparent: TRACEPARENT,
      tracestate: 'vendor=value',
    })
    expect(resolved.source).toBe('external')
    expect(resolved.traceId).toBe(EXTERNAL_TRACE_ID)
    expect(resolved.deterministicTraceId).toBe(createDshTurnTraceId('ses-test-1', 1))
    expect(resolved.invalidExternalContext).toBe(false)
  })

  it('falls back without throwing when the external carrier is invalid', () => {
    const resolved = createTurnParentContext({
      dshSessionId: 'ses-test-1',
      turn: 1,
      traceparent: 'not-a-traceparent',
    })
    expect(resolved.source).toBe('deterministic')
    expect(resolved.traceId).toBe(createDshTurnTraceId('ses-test-1', 1))
    expect(resolved.invalidExternalContext).toBe(true)
  })
})

describe('TelemetryIdentityRegistry', () => {
  it('locks one turn identity and records its exported root/completion interval', () => {
    const registry = new TelemetryIdentityRegistry()
    const identity = registry.beginTurn({
      dshSessionId: 'session-a',
      turn: 1,
      startSeq: 3,
      langfuseSessionId: 'host-session-a',
    })
    const rootSpanContext = {
      traceId: identity.traceId,
      spanId: '1111111111111111',
      traceFlags: TraceFlags.SAMPLED,
    }
    registry.registerRootSpan(identity, rootSpanContext)
    registry.completeTurn(identity, { endSeq: 9, forced: false })

    expect(registry.getTurn('session-a', 1)).toMatchObject({
      startSeq: 3,
      endSeq: 9,
      forcedEnd: false,
      rootSpanContext,
    })
    expect(registry.getLatestLangfuseSessionId('session-a')).toBe('host-session-a')
    expect(registry.resolveScoreSession('session-a')).toEqual({
      langfuseSessionId: 'host-session-a',
      ambiguous: false,
    })

    // A repeated start for the same canonical turn cannot silently move it
    // under a different upstream trace within this process.
    const repeated = registry.beginTurn({
      dshSessionId: 'session-a',
      turn: 1,
      startSeq: 3,
      langfuseSessionId: 'changed-later',
      traceparent: TRACEPARENT,
    })
    expect(repeated).toBe(identity)
    expect(repeated.source).toBe('deterministic')
    expect(registry.getLatestLangfuseSessionId('session-a')).toBe('host-session-a')

    registry.beginTurn({
      dshSessionId: 'session-a',
      turn: 2,
      startSeq: 10,
      langfuseSessionId: 'host-session-b',
    })
    expect(registry.resolveScoreSession('session-a')).toEqual({
      langfuseSessionId: 'host-session-b',
      ambiguous: true,
    })
  })

  it('bounds session/turn state and emits each diagnostic at most once', () => {
    const warnings: string[] = []
    const registry = new TelemetryIdentityRegistry({
      maxSessions: 1,
      maxTurnsPerSession: 1,
      onWarning: warning => warnings.push(warning),
    })
    registry.beginTurn({
      dshSessionId: 'session-a',
      turn: 1,
      startSeq: 1,
      langfuseSessionId: 'session-a',
      traceparent: 'invalid',
    })
    registry.beginTurn({
      dshSessionId: 'session-a',
      turn: 2,
      startSeq: 2,
      langfuseSessionId: 'session-a',
      traceparent: 'still-invalid',
    })
    expect(registry.getTurn('session-a', 1)).toBeUndefined()
    registry.beginTurn({
      dshSessionId: 'session-b',
      turn: 1,
      startSeq: 1,
      langfuseSessionId: 'session-b',
    })
    expect(registry.sessionCount).toBe(1)
    expect(registry.getTurn('session-a', 2)).toBeUndefined()
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/invalid W3C trace context/)
    expect(warnings[1]).toMatch(/memory bound/)
  })
})
