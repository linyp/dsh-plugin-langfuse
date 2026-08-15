/**
 * Bounded in-process identity index shared by trace projection and future
 * Score/lineage sinks. It is correlation state, never a replacement for the
 * canonical DSH event log.
 *
 * @module dsh-plugin-langfuse/identity-registry
 */

import type { SpanContext } from '@opentelemetry/api'
import {
  createTurnParentContext,
  type TurnParentContext,
} from './identity.ts'

export const DEFAULT_MAX_IDENTITY_SESSIONS = 2_048
export const DEFAULT_MAX_TURNS_PER_SESSION = 256

export interface BeginTurnIdentity {
  dshSessionId: string
  turn: number
  startSeq: number
  langfuseSessionId: string
  traceparent?: string | number
  tracestate?: string | number
}

/** Identity snapshot locked when a turn starts. */
export interface TurnIdentity extends TurnParentContext {
  dshSessionId: string
  turn: number
  startSeq: number
  langfuseSessionId: string
  /** Actual context of the exported turn root, registered after startSpan. */
  rootSpanContext?: SpanContext
  /** Canonical end seq when present; forced closure deliberately leaves it absent. */
  endSeq?: number
  forcedEnd?: boolean
}

interface SessionIdentity {
  latestLangfuseSessionId: string
  ambiguousLangfuseSession: boolean
  turns: Map<number, TurnIdentity>
}

/** Session-level subject state consumed by the feedback Score mapper. */
export interface ScoreSessionIdentity {
  langfuseSessionId: string | undefined
  /** More than one per-turn Langfuse session id was observed. */
  ambiguous: boolean
}

export interface TelemetryIdentityRegistryOptions {
  maxSessions?: number
  maxTurnsPerSession?: number
  /** Receives bounded, value-free diagnostics safe for the host logger. */
  onWarning?: (message: string) => void
}

const INVALID_CONTEXT_WARNING = 'dsh-plugin-langfuse: invalid W3C trace context on turn/start; using the valid traceparent when possible, otherwise the deterministic dsh trace identity'
const EVICTION_WARNING = 'dsh-plugin-langfuse: telemetry identity registry reached its memory bound; older trace-link context may be unavailable'

/**
 * Session-level LRU with a bounded turn LRU inside every session. Entries are
 * retained after session shutdown so a later fork can link back to its parent;
 * eviction only removes optional correlation context.
 */
export class TelemetryIdentityRegistry {
  private readonly sessions = new Map<string, SessionIdentity>()
  private readonly maxSessions: number
  private readonly maxTurnsPerSession: number
  private readonly onWarning: ((message: string) => void) | undefined
  private warnedInvalidContext = false
  private warnedEviction = false

  constructor(options: TelemetryIdentityRegistryOptions = {}) {
    this.maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_IDENTITY_SESSIONS, 'maxSessions')
    this.maxTurnsPerSession = positiveInteger(options.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION, 'maxTurnsPerSession')
    this.onWarning = options.onWarning
  }

  /** Resolve and retain the immutable identity chosen for one turn. */
  beginTurn(input: BeginTurnIdentity): TurnIdentity {
    let session = this.sessions.get(input.dshSessionId)
    if (session === undefined) {
      session = {
        latestLangfuseSessionId: input.langfuseSessionId,
        ambiguousLangfuseSession: false,
        turns: new Map(),
      }
      this.sessions.set(input.dshSessionId, session)
      this.evictSessionsIfNeeded()
    } else {
      // Touch the session in insertion-ordered Map LRU.
      this.sessions.delete(input.dshSessionId)
      this.sessions.set(input.dshSessionId, session)
    }

    const existing = session.turns.get(input.turn)
    if (existing !== undefined) {
      session.turns.delete(input.turn)
      session.turns.set(input.turn, existing)
      if (session.latestLangfuseSessionId !== existing.langfuseSessionId) {
        session.ambiguousLangfuseSession = true
        session.latestLangfuseSessionId = existing.langfuseSessionId
      }
      return existing
    }

    const parent = createTurnParentContext(input)
    if (parent.invalidExternalContext) this.warnInvalidContextOnce()
    const identity: TurnIdentity = {
      ...parent,
      dshSessionId: input.dshSessionId,
      turn: input.turn,
      startSeq: input.startSeq,
      langfuseSessionId: input.langfuseSessionId,
    }
    if (session.latestLangfuseSessionId !== input.langfuseSessionId) {
      session.ambiguousLangfuseSession = true
      session.latestLangfuseSessionId = input.langfuseSessionId
    }
    session.turns.set(input.turn, identity)
    this.evictTurnsIfNeeded(session)
    return identity
  }

  /** Bind the newly-created root span context to its precomputed identity. */
  registerRootSpan(identity: TurnIdentity, rootSpanContext: SpanContext): void {
    const current = this.sessions.get(identity.dshSessionId)?.turns.get(identity.turn)
    if (current !== identity) return
    current.rootSpanContext = rootSpanContext
  }

  /** Mark the interval complete; forced ends intentionally have no canonical end seq. */
  completeTurn(identity: TurnIdentity, input: { endSeq?: number; forced: boolean }): void {
    const current = this.sessions.get(identity.dshSessionId)?.turns.get(identity.turn)
    if (current !== identity) return
    current.forcedEnd = input.forced
    if (input.endSeq !== undefined) current.endSeq = input.endSeq
  }

  /** Read one retained identity without changing LRU order. */
  getTurn(dshSessionId: string, turn: number): TurnIdentity | undefined {
    return this.sessions.get(dshSessionId)?.turns.get(turn)
  }

  /** Future Score mapping uses the most recently resolved per-turn subject. */
  getLatestLangfuseSessionId(dshSessionId: string): string | undefined {
    return this.sessions.get(dshSessionId)?.latestLangfuseSessionId
  }

  /** Resolve Score subject state without exposing or mutating the registry. */
  resolveScoreSession(dshSessionId: string): ScoreSessionIdentity {
    const session = this.sessions.get(dshSessionId)
    return {
      langfuseSessionId: session?.latestLangfuseSessionId,
      ambiguous: session?.ambiguousLangfuseSession ?? false,
    }
  }

  /** Test/diagnostic visibility without exposing the backing maps. */
  get sessionCount(): number {
    return this.sessions.size
  }

  private evictSessionsIfNeeded(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.sessions.delete(oldest)
      this.warnEvictionOnce()
    }
  }

  private evictTurnsIfNeeded(session: SessionIdentity): void {
    while (session.turns.size > this.maxTurnsPerSession) {
      const oldest = session.turns.keys().next().value as number | undefined
      if (oldest === undefined) return
      session.turns.delete(oldest)
      this.warnEvictionOnce()
    }
  }

  private warnInvalidContextOnce(): void {
    if (this.warnedInvalidContext) return
    this.warnedInvalidContext = true
    this.warn(INVALID_CONTEXT_WARNING)
  }

  private warnEvictionOnce(): void {
    if (this.warnedEviction) return
    this.warnedEviction = true
    this.warn(EVICTION_WARNING)
  }

  private warn(message: string): void {
    try {
      this.onWarning?.(message)
    } catch {
      // A host logger must never be allowed to break telemetry projection.
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-plugin-langfuse: identity registry ${name} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}
