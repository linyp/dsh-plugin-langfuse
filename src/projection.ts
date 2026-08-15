/**
 * The folding projection: rebuilds a Langfuse trace tree from the telemetry
 * seam's flat record stream. The seam hands over one record per captured
 * session event; this state machine folds them into OTel spans keyed by
 * `(session.id, turn, step)` — turn → trace root span, step → generation,
 * tool call/result pair → tool span — always timestamped from the record's
 * own `time`, so live capture and `FEEDBACK_ONLY` canonical-log replay
 * produce identical trees.
 *
 * Seam contract notes this projection relies on: `seq` gaps are routine
 * (only the first `assistant/chunk` per step ships) and are never a loss
 * signal; `severity` is pre-mapped (`error` for tool-result `isError` and
 * `turn/end` error reasons), so error status never re-derives event
 * semantics; records may repeat after a cursor-less re-adoption, so
 * duplicate spans are possible downstream (see README: delivery semantics).
 *
 * Identity correlation: `langfuse.session.id`/`langfuse.user.id` resolve once
 * per turn — dynamic attributes on the `turn/start` record win over the
 * static {@link CorrelationConfig}, which wins over the dsh session id — and
 * the snapshot is locked for the whole turn: identity attributes on later
 * records are ignored. Langfuse's v4 query model filters per observation, so
 * the resolved identity rides every span; the original dsh session id stays
 * on the turn root as `dsh.session.id`.
 *
 * Trace identity: every turn derives a versioned Trace ID from the original
 * dsh session id plus turn number. A valid `traceparent`/`tracestate` carried
 * by `turn/start` wins and nests the DSH subtree under the embedding host;
 * the deterministic id remains an attribute for reverse correlation.
 *
 * @module dsh-plugin-langfuse/projection
 */

import {
  SpanStatusCode,
  trace,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import { TelemetryIdentityRegistry, type TurnIdentity } from './identity-registry.ts'
import { TRACEPARENT_ATTRIBUTE, TRACESTATE_ATTRIBUTE } from './identity.ts'
import {
  ATTR_DSH_EVENT_SEQ,
  ATTR_DSH_FORCE_ENDED,
  ATTR_DSH_LINEAGE_LINKED,
  ATTR_DSH_LINEAGE_PARENT_TRACE_ID,
  ATTR_DSH_LINK_TYPE,
  ATTR_DSH_SESSION_ID,
  ATTR_DSH_SESSION_PARENT_ID,
  ATTR_DSH_SESSION_SEED_LENGTH,
  ATTR_DSH_STEP,
  ATTR_DSH_TRACE_DETERMINISTIC_ID,
  ATTR_DSH_TRACE_LOGICAL_ROOT,
  ATTR_DSH_TURN,
  ATTR_DSH_TURN_END_REASON,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_LANGFUSE_COMPLETION_START_TIME,
  ATTR_LANGFUSE_INTERNAL_IS_APP_ROOT,
  ATTR_LANGFUSE_OBSERVATION_INPUT,
  ATTR_LANGFUSE_OBSERVATION_OUTPUT,
  ATTR_LANGFUSE_OBSERVATION_TYPE,
  ATTR_LANGFUSE_SESSION_ID,
  ATTR_LANGFUSE_TRACE_INPUT,
  ATTR_LANGFUSE_TRACE_METADATA_DSH_DETERMINISTIC_TRACE_ID,
  ATTR_LANGFUSE_TRACE_METADATA_DSH_PARENT_SESSION_ID,
  ATTR_LANGFUSE_TRACE_METADATA_DSH_PARENT_TRACE_ID,
  ATTR_LANGFUSE_TRACE_METADATA_DSH_SEED_LENGTH,
  ATTR_LANGFUSE_TRACE_NAME,
  ATTR_LANGFUSE_TRACE_OUTPUT,
  ATTR_LANGFUSE_USER_ID,
} from './semconv.ts'
import { toGenAiUsageAttributes } from './usage.ts'

/**
 * Default serialized-payload ceiling per span attribute. Guards the export
 * pipeline against multi-megabyte tool output; the canonical session log
 * keeps the full bytes. Deployments change it through the plugin's
 * `maxAttributeChars` config field.
 */
export const DEFAULT_MAX_ATTRIBUTE_CHARS = 32_768

/** Serialize a payload for a span attribute, clipped to `budget` characters. */
function clip(value: unknown, budget: number): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length <= budget ? text : `${text.slice(0, budget)}…[clipped]`
}

/**
 * Static identity correlation for embedding hosts: values stamped as
 * `langfuse.user.id` / `langfuse.session.id` on every exported span so a
 * host's own traces and this plugin's group under one Langfuse user/session.
 * A `turn/start` record carrying either attribute key overrides per turn.
 */
export interface CorrelationConfig {
  /** Langfuse user identity; absent means no `langfuse.user.id` is emitted. */
  userId?: string
  /** Langfuse session identity; absent means the dsh session id. */
  sessionId?: string
}

/** The identity snapshot resolved at `turn/start` and locked for the turn. */
interface TurnCorrelation {
  userId?: string
  langfuseSessionId: string
  dshSessionId: string
}

/** Trace-wide identity every span carries for v4 per-observation queries. */
function identityAttributes(correlation: TurnCorrelation, identity?: TurnIdentity): Record<string, string> {
  return {
    [ATTR_LANGFUSE_SESSION_ID]: correlation.langfuseSessionId,
    ...correlation.userId === undefined ? {} : { [ATTR_LANGFUSE_USER_ID]: correlation.userId },
    ...identity === undefined ? {} : {
      [ATTR_DSH_TRACE_DETERMINISTIC_ID]: identity.deterministicTraceId,
      [ATTR_LANGFUSE_TRACE_METADATA_DSH_DETERMINISTIC_TRACE_ID]: identity.deterministicTraceId,
    },
  }
}

/** Read one dynamic identity attribute from a record; empty values mean absent. */
function dynamicAttr(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = String(value)
  return text.length === 0 ? undefined : text
}

/** Parse one non-empty string identity attribute without coercion. */
function stringAttr(value: string | number | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Parse one non-negative integer identity attribute without throwing. */
function nonNegativeIntegerAttr(value: string | number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

interface StepState {
  span: Span
  /** OTel context carrying the step span, parent for its tool children. */
  context: OtelContext
  sawFirstChunk: boolean
}

interface TurnState {
  span: Span
  /** OTel context carrying the turn span, parent for step/tool children. */
  context: OtelContext
  turn: number
  steps: Map<number, StepState>
  /** Open tool spans keyed by the model-issued call id. */
  tools: Map<string, Span>
  /** The step currently between `step/start` and `step/end`, if any. */
  currentStep?: StepState
  /** Identity locked at `turn/start`; later records cannot change it. */
  correlation: TurnCorrelation
  /** Stable trace identity plus the explicit parent selected at turn/start. */
  identity: TurnIdentity
}

interface SessionState {
  /** Latest `request/header` snapshot; names the model on generation spans. */
  header?: SessionEventMap['request/header']['header']
  turn?: TurnState
}

/** The payload of the ledger record's source event, per the seam's record contract. */
function body<T extends keyof SessionEventMap>(record: SessionTelemetryRecord): SessionEventMap[T] {
  return record.body as SessionEventMap[T]
}

export interface SessionSpanFolderOptions {
  maxAttributeChars?: number
  correlation?: CorrelationConfig
  identityRegistry?: TelemetryIdentityRegistry
}

/**
 * Folds seam records into OTel spans through the given tracer. One folder
 * instance serves every session the backend observes; state is per
 * `session.id` and dies with the session's terminal record or {@link endAll}.
 */
export class SessionSpanFolder {
  private readonly sessions = new Map<string, SessionState>()
  private readonly maxAttributeChars: number
  private readonly correlation: CorrelationConfig | undefined
  private readonly identityRegistry: TelemetryIdentityRegistry

  constructor(private readonly tracer: Tracer, options?: SessionSpanFolderOptions) {
    this.maxAttributeChars = options?.maxAttributeChars ?? DEFAULT_MAX_ATTRIBUTE_CHARS
    this.correlation = options?.correlation
    this.identityRegistry = options?.identityRegistry ?? new TelemetryIdentityRegistry()
  }

  /**
   * Resolve the turn's identity snapshot: dynamic attributes on the
   * `turn/start` record (a deployment's `session-telemetry/record` waterfall
   * listener injects them) win over the static config, which wins over the
   * dsh session id.
   */
  private resolveCorrelation(record: SessionTelemetryRecord, dshSessionId: string): TurnCorrelation {
    return {
      langfuseSessionId: dynamicAttr(record.attributes[ATTR_LANGFUSE_SESSION_ID])
        ?? this.correlation?.sessionId ?? dshSessionId,
      userId: dynamicAttr(record.attributes[ATTR_LANGFUSE_USER_ID]) ?? this.correlation?.userId,
      dshSessionId,
    }
  }

  /** Serialize a payload for a span attribute within this folder's budget. */
  private clip(value: unknown): string {
    return clip(value, this.maxAttributeChars)
  }

  /**
   * Fold one handed-over record into the span tree. Synchronous O(1) map
   * work plus SDK span calls (themselves queue pushes into the batch
   * processor), so it satisfies the seam's non-blocking `emit` contract.
   * @param record - the seam record, owned by the backend after handoff.
   */
  fold(record: SessionTelemetryRecord): void {
    if (record.channel === 'ops') {
      this.foldOps(record)
      return
    }
    const sessionId = String(record.attributes['session.id'])
    const state = this.sessions.get(sessionId) ?? {}
    this.sessions.set(sessionId, state)
    switch (record.attributes['event.type']) {
      case 'request/header': {
        state.header = body<'request/header'>(record).header
        // The header is appended inside its step before dispatch, so the
        // step span opened before it; stamp the model identity onto the
        // open step now rather than only seeding the next one.
        const open = state.turn?.currentStep
        if (open !== undefined) {
          open.span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, state.header.config.model)
          open.span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, state.header.config.provider)
        }
        return
      }
      case 'turn/start': {
        const { turn } = body<'turn/start'>(record)
        // A still-open previous turn means its turn/end never shipped
        // (crash window or dropped record); close it before opening the next.
        if (state.turn !== undefined) this.endTurn(state, record.time, true)
        const correlation = this.resolveCorrelation(record, sessionId)
        const identity = this.identityRegistry.beginTurn({
          dshSessionId: sessionId,
          turn,
          startSeq: Number(record.attributes['event.seq']),
          langfuseSessionId: correlation.langfuseSessionId,
          parentId: stringAttr(record.attributes['session.parent_id']),
          seedLength: nonNegativeIntegerAttr(record.attributes['session.seed_length']),
          traceparent: record.attributes[TRACEPARENT_ATTRIBUTE],
          tracestate: record.attributes[TRACESTATE_ATTRIBUTE],
        })
        const lineage = this.identityRegistry.resolveForkLink(sessionId)
        const span = this.tracer.startSpan(`turn ${turn}`, {
          startTime: record.time,
          ...lineage?.parentSpanContext === undefined ? {} : {
            links: [{
              context: lineage.parentSpanContext,
              attributes: {
                [ATTR_DSH_LINK_TYPE]: 'fork',
                ...lineage.parentId === undefined ? {} : { [ATTR_DSH_SESSION_PARENT_ID]: lineage.parentId },
                ...lineage.seedLength === undefined ? {} : { [ATTR_DSH_SESSION_SEED_LENGTH]: lineage.seedLength },
              },
            }],
          },
          attributes: {
            ...identityAttributes(correlation, identity),
            [ATTR_DSH_SESSION_ID]: correlation.dshSessionId,
            [ATTR_DSH_TRACE_LOGICAL_ROOT]: true,
            [ATTR_LANGFUSE_INTERNAL_IS_APP_ROOT]: true,
            [ATTR_LANGFUSE_TRACE_NAME]: `dsh turn ${turn}`,
            ...lineage === undefined ? {} : {
              [ATTR_DSH_LINEAGE_LINKED]: lineage.linked,
              ...lineage.parentId === undefined ? {} : {
                [ATTR_DSH_SESSION_PARENT_ID]: lineage.parentId,
                [ATTR_LANGFUSE_TRACE_METADATA_DSH_PARENT_SESSION_ID]: lineage.parentId,
              },
              ...lineage.seedLength === undefined ? {} : {
                [ATTR_DSH_SESSION_SEED_LENGTH]: lineage.seedLength,
                [ATTR_LANGFUSE_TRACE_METADATA_DSH_SEED_LENGTH]: lineage.seedLength,
              },
              ...lineage.parentTraceId === undefined ? {} : {
                [ATTR_DSH_LINEAGE_PARENT_TRACE_ID]: lineage.parentTraceId,
                [ATTR_LANGFUSE_TRACE_METADATA_DSH_PARENT_TRACE_ID]: lineage.parentTraceId,
              },
            },
            [ATTR_DSH_TURN]: turn,
            [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
          },
        }, identity.parentContext)
        this.identityRegistry.registerRootSpan(identity, span.spanContext())
        state.turn = {
          span,
          context: trace.setSpan(identity.parentContext, span),
          turn,
          steps: new Map(),
          tools: new Map(),
          correlation,
          identity,
        }
        return
      }
      case 'user/message': {
        const input = this.clip(record.body)
        // V4 has no separate trace input: the overall request belongs to the
        // root observation. Retain the legacy attribute for trace-level
        // evaluators while they migrate.
        state.turn?.span.setAttributes({
          [ATTR_LANGFUSE_OBSERVATION_INPUT]: input,
          [ATTR_LANGFUSE_TRACE_INPUT]: input,
        })
        return
      }
      case 'step/start': {
        if (state.turn === undefined) return
        const { turn, step } = body<'step/start'>(record)
        const span = this.tracer.startSpan(`step ${step}`, {
          startTime: record.time,
          attributes: {
            [ATTR_LANGFUSE_OBSERVATION_TYPE]: 'generation',
            ...identityAttributes(state.turn.correlation, state.turn.identity),
            [ATTR_DSH_TURN]: turn,
            [ATTR_DSH_STEP]: step,
            [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
            ...state.header === undefined ? {} : {
              [ATTR_GEN_AI_REQUEST_MODEL]: state.header.config.model,
              [ATTR_GEN_AI_PROVIDER_NAME]: state.header.config.provider,
            },
          },
        }, state.turn.context)
        const stepState: StepState = { span, context: trace.setSpan(state.turn.context, span), sawFirstChunk: false }
        state.turn.steps.set(step, stepState)
        state.turn.currentStep = stepState
        return
      }
      case 'assistant/chunk': {
        // The seam ships only the first chunk of each (turn, step): it is the
        // stream-started signal, and its time is the first-token time.
        const { step } = body<'assistant/chunk'>(record)
        const stepState = state.turn?.steps.get(step)
        if (stepState === undefined || stepState.sawFirstChunk) return
        stepState.sawFirstChunk = true
        stepState.span.setAttribute(ATTR_LANGFUSE_COMPLETION_START_TIME, new Date(record.time).toISOString())
        return
      }
      case 'assistant/message': {
        const { step, message, usage } = body<'assistant/message'>(record)
        const stepState = state.turn?.steps.get(step)
        if (stepState === undefined) return
        const output = this.clip(message)
        stepState.span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, output)
        // Each completed assistant message replaces the turn root's output;
        // after the final step this is the overall turn response. Keep the
        // deprecated trace attribute only for legacy evaluator compatibility.
        state.turn?.span.setAttributes({
          [ATTR_LANGFUSE_OBSERVATION_OUTPUT]: output,
          [ATTR_LANGFUSE_TRACE_OUTPUT]: output,
        })
        if (usage !== undefined) {
          stepState.span.setAttributes(toGenAiUsageAttributes(usage))
        }
        return
      }
      case 'step/end': {
        const { step } = body<'step/end'>(record)
        const stepState = state.turn?.steps.get(step)
        if (stepState === undefined) return
        stepState.span.end(record.time)
        state.turn?.steps.delete(step)
        if (state.turn?.currentStep === stepState) state.turn.currentStep = undefined
        return
      }
      case 'tool/call': {
        if (state.turn === undefined) return
        const { turn, step, callId, name, arguments: args } = body<'tool/call'>(record)
        // A step is one model request plus the tools it calls, so the tool
        // span nests under its requesting step's generation span; a call
        // whose step is no longer open (crash-window replay) falls back to
        // the turn.
        const parent = state.turn.steps.get(step)?.context ?? state.turn.context
        const span = this.tracer.startSpan(`tool ${name}`, {
          startTime: record.time,
          attributes: {
            [ATTR_LANGFUSE_OBSERVATION_TYPE]: 'tool',
            ...identityAttributes(state.turn.correlation, state.turn.identity),
            [ATTR_GEN_AI_TOOL_NAME]: name,
            [ATTR_GEN_AI_TOOL_CALL_ID]: String(callId),
            [ATTR_LANGFUSE_OBSERVATION_INPUT]: this.clip(args),
            [ATTR_DSH_TURN]: turn,
            [ATTR_DSH_STEP]: step,
            [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
          },
        }, parent)
        state.turn.tools.set(String(callId), span)
        return
      }
      case 'tool/result': {
        const { message } = body<'tool/result'>(record)
        const callId = String(message.content[0].toolCallId)
        const span = state.turn?.tools.get(callId)
        if (span === undefined) return
        span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, this.clip(message.content[0].content))
        if (record.severity === 'error') span.setStatus({ code: SpanStatusCode.ERROR })
        span.end(record.time)
        state.turn?.tools.delete(callId)
        return
      }
      case 'turn/end': {
        if (state.turn === undefined) return
        const { reason } = body<'turn/end'>(record)
        state.turn.span.setAttribute(ATTR_DSH_TURN_END_REASON, this.clip(reason))
        if (record.severity === 'error') state.turn.span.setStatus({ code: SpanStatusCode.ERROR })
        this.endTurn(state, record.time, false, Number(record.attributes['event.seq']))
        return
      }
      default: {
        // The event vocabulary is merge-extensible; every type without its own
        // fold (compaction, todo, plan, hooks, plugin events this package
        // never heard of) lands as a point-in-time span event on the open
        // turn so the trace timeline stays complete. Events between turns
        // are dropped — the canonical log keeps them.
        // TODO: dedicated folds for compaction/* (span) and subagent
        //   descriptors (trace links via session.parent_id).
        state.turn?.span.addEvent(
          String(record.attributes['event.type']),
          { [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'] },
          record.time,
        )
      }
    }
  }

  /** Ops records: `shutdown` sweeps the session's open spans; `agent-error` marks the open turn. */
  private foldOps(record: SessionTelemetryRecord): void {
    const sessionId = String(record.attributes['session.id'])
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    switch (record.attributes['telemetry.op']) {
      case 'shutdown': {
        if (state.turn !== undefined) this.endTurn(state, record.time, true)
        this.sessions.delete(sessionId)
        return
      }
      case 'agent-error': {
        if (state.turn === undefined) return
        state.turn.span.addEvent('agent-error', {
          'error.name': String(record.attributes['error.name'] ?? 'Error'),
        }, record.time)
        state.turn.span.setStatus({ code: SpanStatusCode.ERROR })
        return
      }
      default:
        // Ops vocabulary is the seam's to extend; unknown ops carry no
        // foldable structure, so they are dropped rather than guessed at.
        return
    }
  }

  /** End the open turn and everything still open beneath it. */
  private endTurn(state: SessionState, time: number, forced: boolean, endSeq?: number): void {
    const turn = state.turn
    if (turn === undefined) return
    for (const [, stepState] of turn.steps) {
      if (forced) stepState.span.setAttribute(ATTR_DSH_FORCE_ENDED, true)
      stepState.span.end(time)
    }
    for (const [, span] of turn.tools) {
      if (forced) span.setAttribute(ATTR_DSH_FORCE_ENDED, true)
      span.end(time)
    }
    if (forced) turn.span.setAttribute(ATTR_DSH_FORCE_ENDED, true)
    turn.span.end(time)
    this.identityRegistry.completeTurn(turn.identity, { endSeq, forced })
    state.turn = undefined
  }

  /**
   * Force-end every open span across all sessions — the backend's shutdown
   * sweep, so teardown never abandons started spans in the SDK queue.
   * @param time - epoch milliseconds stamped on each force-ended span.
   */
  endAll(time: number): void {
    for (const [id, state] of this.sessions) {
      if (state.turn !== undefined) this.endTurn(state, time, true)
      this.sessions.delete(id)
    }
  }
}
