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
 * @module dsh-plugin-langfuse/projection
 */

import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import {
  ATTR_DSH_EVENT_SEQ,
  ATTR_DSH_FORCE_ENDED,
  ATTR_DSH_STEP,
  ATTR_DSH_TURN,
  ATTR_DSH_TURN_END_REASON,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_TOKENS,
  ATTR_LANGFUSE_COMPLETION_START_TIME,
  ATTR_LANGFUSE_OBSERVATION_INPUT,
  ATTR_LANGFUSE_OBSERVATION_OUTPUT,
  ATTR_LANGFUSE_OBSERVATION_TYPE,
  ATTR_LANGFUSE_SESSION_ID,
  ATTR_LANGFUSE_TRACE_INPUT,
  ATTR_LANGFUSE_TRACE_NAME,
} from './semconv.ts'

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

/**
 * Folds seam records into OTel spans through the given tracer. One folder
 * instance serves every session the backend observes; state is per
 * `session.id` and dies with the session's terminal record or {@link endAll}.
 */
export class SessionSpanFolder {
  private readonly sessions = new Map<string, SessionState>()
  private readonly maxAttributeChars: number

  constructor(private readonly tracer: Tracer, options?: { maxAttributeChars?: number }) {
    this.maxAttributeChars = options?.maxAttributeChars ?? DEFAULT_MAX_ATTRIBUTE_CHARS
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
        const span = this.tracer.startSpan(`turn ${turn}`, {
          startTime: record.time,
          root: true,
          attributes: {
            [ATTR_LANGFUSE_SESSION_ID]: sessionId,
            [ATTR_LANGFUSE_TRACE_NAME]: `dsh turn ${turn}`,
            [ATTR_DSH_TURN]: turn,
            [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
          },
        }, ROOT_CONTEXT)
        state.turn = {
          span,
          context: trace.setSpan(ROOT_CONTEXT, span),
          turn,
          steps: new Map(),
          tools: new Map(),
        }
        return
      }
      case 'user/message': {
        state.turn?.span.setAttribute(ATTR_LANGFUSE_TRACE_INPUT, this.clip(record.body))
        return
      }
      case 'step/start': {
        if (state.turn === undefined) return
        const { turn, step } = body<'step/start'>(record)
        const span = this.tracer.startSpan(`step ${step}`, {
          startTime: record.time,
          attributes: {
            [ATTR_LANGFUSE_OBSERVATION_TYPE]: 'generation',
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
        stepState.span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, this.clip(message))
        if (usage !== undefined) {
          stepState.span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens)
          stepState.span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens)
          if (usage.cacheReadTokens !== undefined) {
            stepState.span.setAttribute(ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS, usage.cacheReadTokens)
          }
          if (usage.reasoningTokens !== undefined) {
            stepState.span.setAttribute(ATTR_GEN_AI_USAGE_REASONING_TOKENS, usage.reasoningTokens)
          }
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
        this.endTurn(state, record.time, false)
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
  private endTurn(state: SessionState, time: number, forced: boolean): void {
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
