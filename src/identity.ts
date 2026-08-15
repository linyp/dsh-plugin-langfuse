/**
 * Stable trace identity and explicit W3C parent-context handling.
 *
 * The hash namespace is a durable wire contract: changing it would move an
 * already exported DSH turn to a different Langfuse trace. External parent
 * context is parsed locally instead of relying on a process-global OTel
 * propagator, which may be absent in embedded Cordis deployments.
 *
 * @module dsh-plugin-langfuse/identity
 */

import { createHash } from 'node:crypto'
import {
  ROOT_CONTEXT,
  TraceFlags,
  createTraceState,
  trace,
  type Context as OtelContext,
  type SpanContext,
} from '@opentelemetry/api'

const TURN_TRACE_ID_NAMESPACE = 'dsh-plugin-langfuse:turn-trace:v1'
const INVALID_TRACE_ID = '00000000000000000000000000000000'

/**
 * A valid, deliberately non-exported parent id used only to seed a chosen
 * Trace ID through the standard OTel API. It is scoped by Trace ID, so the
 * same value is safe across independent turns.
 */
export const SYNTHETIC_PARENT_SPAN_ID = '0000000000000001'

/** Canonical record attributes used as the per-turn W3C carrier. */
export const TRACEPARENT_ATTRIBUTE = 'traceparent'
export const TRACESTATE_ATTRIBUTE = 'tracestate'

/** Whether a turn joined an upstream trace or used its stable DSH identity. */
export type TurnTraceContextSource = 'external' | 'deterministic'

/** Parent context selected before the turn root span is created. */
export interface TurnParentContext {
  /** Context passed as the explicit parent to `Tracer.startSpan`. */
  parentContext: OtelContext
  /** The parent SpanContext carried by {@link parentContext}. */
  parentSpanContext: SpanContext
  /** Stable DSH identity, retained even when an upstream trace wins. */
  deterministicTraceId: string
  /** Actual Trace ID the new turn span will inherit. */
  traceId: string
  source: TurnTraceContextSource
  /** The supplied carrier was malformed or incomplete and was degraded safely. */
  invalidExternalContext: boolean
}

/**
 * Derive the stable 128-bit Trace ID for one DSH turn.
 *
 * This algorithm is versioned and covered by fixed test vectors. Do not
 * change the namespace, separators, encoding, or truncation in 0.2.x.
 */
export function createDshTurnTraceId(dshSessionId: string, turn: number): string {
  if (typeof dshSessionId !== 'string' || dshSessionId.length === 0) {
    throw new Error('dsh-plugin-langfuse: dshSessionId must be non-empty')
  }
  if (!Number.isSafeInteger(turn) || turn < 0) {
    throw new Error(`dsh-plugin-langfuse: turn must be a non-negative safe integer, got ${String(turn)}`)
  }
  const traceId = createHash('sha256')
    .update(TURN_TRACE_ID_NAMESPACE)
    .update('\0')
    .update(dshSessionId)
    .update('\0')
    .update(String(turn))
    .digest('hex')
    .slice(0, 32)
  // SHA-256 producing 128 zero prefix bits is astronomically unlikely, but
  // W3C forbids the all-zero Trace ID, so preserve validity defensively.
  return traceId === INVALID_TRACE_ID ? `${traceId.slice(0, -1)}1` : traceId
}

/**
 * Parse one W3C `traceparent` plus optional `tracestate` into a remote parent.
 * Returns undefined for any invalid traceparent; callers decide the fallback.
 */
export function parseW3CTraceContext(traceparent: string, tracestate?: string): SpanContext | undefined {
  const value = traceparent.trim()
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/.exec(value)
  if (match === null) return undefined
  const [, version, traceId, spanId, flags, futureFields] = match
  if (version === 'ff' || traceId === INVALID_TRACE_ID || spanId === '0000000000000000') return undefined
  // Version 00 has a fixed width. Future versions may append fields that an
  // older implementation must ignore rather than reject.
  if (version === '00' && futureFields !== undefined) return undefined
  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
    ...tracestate === undefined || tracestate.length === 0
      ? {}
      : { traceState: createTraceState(tracestate) },
  }
}

/**
 * Resolve the explicit per-turn carrier, falling back to the stable DSH ID.
 * A malformed tracestate does not discard an otherwise valid traceparent;
 * non-string carrier values are considered invalid and reported to callers.
 */
export function createTurnParentContext(input: {
  dshSessionId: string
  turn: number
  traceparent?: string | number
  tracestate?: string | number
}): TurnParentContext {
  const deterministicTraceId = createDshTurnTraceId(input.dshSessionId, input.turn)
  const external = typeof input.traceparent === 'string'
    ? parseW3CTraceContext(
        input.traceparent,
        typeof input.tracestate === 'string' ? input.tracestate : undefined,
      )
    : undefined
  const invalidExternalContext = input.traceparent !== undefined || input.tracestate !== undefined
    ? external === undefined || (input.tracestate !== undefined && typeof input.tracestate !== 'string')
    : false
  const parentSpanContext: SpanContext = external ?? {
    traceId: deterministicTraceId,
    spanId: SYNTHETIC_PARENT_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  }
  return {
    parentContext: trace.setSpanContext(ROOT_CONTEXT, parentSpanContext),
    parentSpanContext,
    deterministicTraceId,
    traceId: parentSpanContext.traceId,
    source: external === undefined ? 'deterministic' : 'external',
    invalidExternalContext,
  }
}
