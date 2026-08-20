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
import {
  TRACEPARENT_ATTRIBUTE,
  TRACESTATE_ATTRIBUTE,
  createCompactionParentContext,
  type CompactionParentContext,
} from './identity.ts'
import {
  ATTR_DSH_ASSISTANT_INTERRUPTED,
  ATTR_DSH_COMPACTION_DURATION_SCOPE,
  ATTR_DSH_COMPACTION_ERROR,
  ATTR_DSH_COMPACTION_ID,
  ATTR_DSH_COMPACTION_ORPHANED_OWNER,
  ATTR_DSH_COMPACTION_SHADOWED_EVENT_COUNT,
  ATTR_DSH_COMPACTION_SHADOWED_SEQ_END,
  ATTR_DSH_COMPACTION_SHADOWED_SEQ_START,
  ATTR_DSH_COMPACTION_SHADOWED_TOKEN_COUNT,
  ATTR_DSH_COMPACTION_SOURCE_COMMAND_ID,
  ATTR_DSH_COMPACTION_SUMMARY_SEEN,
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
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
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
interface TraceCorrelation {
  userId?: string
  langfuseSessionId: string
  dshSessionId: string
}

interface TraceIdentityAttributes {
  deterministicTraceId: string
}

/** Trace-wide identity every span carries for v4 per-observation queries. */
function identityAttributes(
  correlation: TraceCorrelation,
  identity?: TraceIdentityAttributes,
): Record<string, string> {
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

/** Minimal read-only contract consumed from merge-extensible compaction events. */
interface CompactionStartBody {
  compactionId: string
  sourceCommandId?: string
  turn: number | null
}

interface CompactionSummaryBody {
  compactionId: string
  sourceCommandId?: string
  summary: unknown
  shadowedRange: { start: number; end: number }
  shadowedSeqs: unknown[]
  shadowedTokenCount: number
  provider: string
  model: string
  maxTokens?: number
  usage?: NonNullable<SessionEventMap['assistant/message']['usage']>
}

interface CompactionEndBody {
  compactionId: string
  sourceCommandId?: string
  turn: number | null
  error?: string
}

interface CompactionPruneBody {
  shadowedRange: { start: number; end: number }
  shadowedSeqs: unknown[]
  shadowedTokenCount: number
}

interface CompactionState {
  span: Span
  compactionId: string
  sourceCommandId?: string
  sawSummary: boolean
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
  correlation: TraceCorrelation
  /** Stable trace identity plus the explicit parent selected at turn/start. */
  identity: TurnIdentity
}

interface SessionState {
  /** Latest `request/header` snapshot; names the model on generation spans. */
  header?: SessionEventMap['request/header']['header']
  turn?: TurnState
  /** Open compaction transactions keyed by their canonical opaque id. */
  compactions: Map<string, CompactionState>
}

/** The payload of the ledger record's source event, per the seam's record contract. */
function body<T extends keyof SessionEventMap>(record: SessionTelemetryRecord): SessionEventMap[T] {
  return record.body as SessionEventMap[T]
}

function objectBody(record: SessionTelemetryRecord): Record<string, unknown> | undefined {
  return typeof record.body === 'object' && record.body !== null && !Array.isArray(record.body)
    ? record.body as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function compactionOwner(value: unknown): number | null | undefined {
  return value === null ? null : nonNegativeInteger(value)
}

function rangeBody(value: unknown): { start: number; end: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const range = value as Record<string, unknown>
  const start = nonNegativeInteger(range['start'])
  const end = nonNegativeInteger(range['end'])
  return start === undefined || end === undefined ? undefined : { start, end }
}

function readCompactionStart(record: SessionTelemetryRecord): CompactionStartBody | undefined {
  const value = objectBody(record)
  if (value === undefined) return undefined
  const compactionId = nonEmptyString(value['compactionId'])
  const turn = compactionOwner(value['turn'])
  if (compactionId === undefined || turn === undefined) return undefined
  const sourceCommandId = nonEmptyString(value['sourceCommandId'])
  return { compactionId, turn, ...sourceCommandId === undefined ? {} : { sourceCommandId } }
}

function readCompactionSummary(record: SessionTelemetryRecord): CompactionSummaryBody | undefined {
  const value = objectBody(record)
  if (value === undefined) return undefined
  const compactionId = nonEmptyString(value['compactionId'])
  const shadowedRange = rangeBody(value['shadowedRange'])
  const shadowedTokenCount = nonNegativeInteger(value['shadowedTokenCount'])
  const provider = nonEmptyString(value['provider'])
  const model = nonEmptyString(value['model'])
  if (compactionId === undefined || shadowedRange === undefined || shadowedTokenCount === undefined
    || provider === undefined || model === undefined || !Array.isArray(value['shadowedSeqs'])) return undefined
  const sourceCommandId = nonEmptyString(value['sourceCommandId'])
  const maxTokens = nonNegativeInteger(value['maxTokens'])
  const usage = readCompactionUsage(value['usage'])
  return {
    compactionId,
    summary: value['summary'],
    shadowedRange,
    shadowedSeqs: value['shadowedSeqs'],
    shadowedTokenCount,
    provider,
    model,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...usage === undefined ? {} : { usage },
  }
}

function readCompactionUsage(
  value: unknown,
): NonNullable<SessionEventMap['assistant/message']['usage']> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const inputTokens = nonNegativeInteger(usage['inputTokens'])
  const outputTokens = nonNegativeInteger(usage['outputTokens'])
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = nonNegativeInteger(usage['cacheReadTokens'])
  const cacheWriteTokens = nonNegativeInteger(usage['cacheWriteTokens'])
  const reasoningTokens = nonNegativeInteger(usage['reasoningTokens'])
  return {
    inputTokens,
    outputTokens,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

function readCompactionEnd(record: SessionTelemetryRecord): CompactionEndBody | undefined {
  const value = objectBody(record)
  if (value === undefined) return undefined
  const compactionId = nonEmptyString(value['compactionId'])
  const turn = compactionOwner(value['turn'])
  if (compactionId === undefined || turn === undefined) return undefined
  const sourceCommandId = nonEmptyString(value['sourceCommandId'])
  const error = typeof value['error'] === 'string' ? value['error'] : undefined
  return {
    compactionId,
    turn,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
    ...error === undefined ? {} : { error },
  }
}

function readCompactionPrune(record: SessionTelemetryRecord): CompactionPruneBody | undefined {
  const value = objectBody(record)
  if (value === undefined) return undefined
  const shadowedRange = rangeBody(value['shadowedRange'])
  const shadowedTokenCount = nonNegativeInteger(value['shadowedTokenCount'])
  if (shadowedRange === undefined || shadowedTokenCount === undefined || !Array.isArray(value['shadowedSeqs'])) {
    return undefined
  }
  return { shadowedRange, shadowedSeqs: value['shadowedSeqs'], shadowedTokenCount }
}

/** Recognize the checkpoint replacement paired with compaction/summary. */
function isCompactionCheckpointMessage(record: SessionTelemetryRecord): boolean {
  const value = objectBody(record)
  if (value === undefined || typeof value['source'] !== 'object' || value['source'] === null) return false
  const source = value['source'] as Record<string, unknown>
  return source['kind'] === 'plugin'
    && source['plugin'] === 'compact'
    && nonEmptyString(source['compactionId']) !== undefined
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
  private resolveCorrelation(record: SessionTelemetryRecord, dshSessionId: string): TraceCorrelation {
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
    const state = this.sessions.get(sessionId) ?? { compactions: new Map<string, CompactionState>() }
    this.sessions.set(sessionId, state)
    switch (record.attributes['event.type']) {
      case 'request/header': return this.foldRequestHeader(state, record)
      case 'turn/start': return this.foldTurnStart(state, record, sessionId)
      case 'user/message': return this.foldUserMessage(state, record)
      case 'step/start': return this.foldStepStart(state, record)
      case 'assistant/chunk': return this.foldAssistantChunk(state, record)
      case 'assistant/message': return this.foldAssistantMessage(state, record)
      case 'step/end': return this.foldStepEnd(state, record)
      case 'tool/call': return this.foldToolCall(state, record)
      case 'tool/result': return this.foldToolResult(state, record)
      case 'turn/end': return this.foldTurnEnd(state, record)
      case 'compaction/start': return this.foldCompactionStart(state, record, sessionId)
      case 'compaction/summary': return this.foldCompactionSummary(state, record)
      case 'compaction/end': return this.foldCompactionEnd(state, record)
      case 'compaction/prune': return this.foldCompactionPrune(state, record)
      default: return this.foldPointEvent(state, record)
    }
  }

  private foldRequestHeader(state: SessionState, record: SessionTelemetryRecord): void {
    state.header = body<'request/header'>(record).header
    // The header is appended inside its step before dispatch, so the step
    // span opened before it; stamp the model identity onto the open step now.
    const open = state.turn?.currentStep
    if (open === undefined) return
    open.span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, state.header.config.model)
    open.span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, state.header.config.provider)
  }

  private foldTurnStart(state: SessionState, record: SessionTelemetryRecord, sessionId: string): void {
    const { turn } = body<'turn/start'>(record)
    // A still-open previous turn means its turn/end never shipped. Descendant
    // compaction spans must close before their parent turn.
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
  }

  private foldUserMessage(state: SessionState, record: SessionTelemetryRecord): void {
    // A successful compaction writes its checkpoint as a replacement
    // user/message immediately after compaction/summary. It is model-visible
    // context, but not a new human prompt and must not overwrite root input.
    if (isCompactionCheckpointMessage(record)) return
    const input = this.clip(record.body)
    state.turn?.span.setAttributes({
      [ATTR_LANGFUSE_OBSERVATION_INPUT]: input,
      [ATTR_LANGFUSE_TRACE_INPUT]: input,
    })
  }

  private foldStepStart(state: SessionState, record: SessionTelemetryRecord): void {
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
    const stepState: StepState = {
      span,
      context: trace.setSpan(state.turn.context, span),
      sawFirstChunk: false,
    }
    state.turn.steps.set(step, stepState)
    state.turn.currentStep = stepState
  }

  private foldAssistantChunk(state: SessionState, record: SessionTelemetryRecord): void {
    const { step } = body<'assistant/chunk'>(record)
    const stepState = state.turn?.steps.get(step)
    if (stepState === undefined || stepState.sawFirstChunk) return
    stepState.sawFirstChunk = true
    stepState.span.setAttribute(ATTR_LANGFUSE_COMPLETION_START_TIME, new Date(record.time).toISOString())
  }

  private foldAssistantMessage(state: SessionState, record: SessionTelemetryRecord): void {
    const { step, message, usage, interrupted } = body<'assistant/message'>(record)
    const stepState = state.turn?.steps.get(step)
    if (stepState === undefined) return
    const output = this.clip(message)
    stepState.span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, output)
    state.turn?.span.setAttributes({
      [ATTR_LANGFUSE_OBSERVATION_OUTPUT]: output,
      [ATTR_LANGFUSE_TRACE_OUTPUT]: output,
    })
    if (interrupted === true) {
      stepState.span.setAttribute(ATTR_DSH_ASSISTANT_INTERRUPTED, true)
      state.turn?.span.setAttribute(ATTR_DSH_ASSISTANT_INTERRUPTED, true)
    }
    if (usage !== undefined) stepState.span.setAttributes(toGenAiUsageAttributes(usage))
  }

  private foldStepEnd(state: SessionState, record: SessionTelemetryRecord): void {
    const { step } = body<'step/end'>(record)
    const stepState = state.turn?.steps.get(step)
    if (stepState === undefined) return
    stepState.span.end(record.time)
    state.turn?.steps.delete(step)
    if (state.turn?.currentStep === stepState) state.turn.currentStep = undefined
  }

  private foldToolCall(state: SessionState, record: SessionTelemetryRecord): void {
    if (state.turn === undefined) return
    const { turn, step, callId, name, arguments: args } = body<'tool/call'>(record)
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
  }

  private foldToolResult(state: SessionState, record: SessionTelemetryRecord): void {
    const { message } = body<'tool/result'>(record)
    const callId = String(message.content[0].toolCallId)
    const span = state.turn?.tools.get(callId)
    if (span === undefined) return
    span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, this.clip(message.content[0].content))
    if (record.severity === 'error') span.setStatus({ code: SpanStatusCode.ERROR })
    span.end(record.time)
    state.turn?.tools.delete(callId)
  }

  private foldTurnEnd(state: SessionState, record: SessionTelemetryRecord): void {
    if (state.turn === undefined) return
    const { reason } = body<'turn/end'>(record)
    state.turn.span.setAttribute(ATTR_DSH_TURN_END_REASON, this.clip(reason))
    if (record.severity === 'error') state.turn.span.setStatus({ code: SpanStatusCode.ERROR })
    this.endTurn(state, record.time, false, Number(record.attributes['event.seq']))
  }

  /** Open a compaction transaction under its owning turn or as its own trace. */
  private foldCompactionStart(
    state: SessionState,
    record: SessionTelemetryRecord,
    sessionId: string,
  ): void {
    const payload = readCompactionStart(record)
    if (payload === undefined) return this.foldPointEvent(state, record)

    const duplicate = state.compactions.get(payload.compactionId)
    if (duplicate !== undefined) {
      duplicate.span.addEvent('compaction/start.duplicate', {
        [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
      }, record.time)
      return
    }
    // Upstream serializes compaction transactions. A distinct overlapping id
    // signals an incomplete previous lifecycle, so close it before proceeding.
    this.endCompactions(state, record.time, true)

    const owner = payload.turn === null || state.turn?.turn !== payload.turn
      ? undefined
      : state.turn
    const orphanedOwner = payload.turn !== null && owner === undefined
    let parentContext: OtelContext
    let correlation: TraceCorrelation
    let identity: TraceIdentityAttributes
    let rootAttributes: Record<string, string | number | boolean> = {}

    if (owner !== undefined) {
      parentContext = owner.context
      correlation = owner.correlation
      identity = owner.identity
    } else {
      const standaloneIdentity: CompactionParentContext = createCompactionParentContext({
        dshSessionId: sessionId,
        compactionId: payload.compactionId,
        traceparent: record.attributes[TRACEPARENT_ATTRIBUTE],
        tracestate: record.attributes[TRACESTATE_ATTRIBUTE],
      })
      parentContext = standaloneIdentity.parentContext
      correlation = this.resolveCorrelation(record, sessionId)
      identity = standaloneIdentity
      const parentId = stringAttr(record.attributes['session.parent_id'])
      const seedLength = nonNegativeIntegerAttr(record.attributes['session.seed_length'])
      rootAttributes = {
        [ATTR_DSH_SESSION_ID]: sessionId,
        [ATTR_DSH_TRACE_LOGICAL_ROOT]: true,
        [ATTR_LANGFUSE_INTERNAL_IS_APP_ROOT]: true,
        [ATTR_LANGFUSE_TRACE_NAME]: 'dsh compaction',
        ...parentId === undefined ? {} : {
          [ATTR_DSH_SESSION_PARENT_ID]: parentId,
          [ATTR_LANGFUSE_TRACE_METADATA_DSH_PARENT_SESSION_ID]: parentId,
        },
        ...seedLength === undefined ? {} : {
          [ATTR_DSH_SESSION_SEED_LENGTH]: seedLength,
          [ATTR_LANGFUSE_TRACE_METADATA_DSH_SEED_LENGTH]: seedLength,
        },
      }
    }

    const span = this.tracer.startSpan('compaction', {
      startTime: record.time,
      attributes: {
        [ATTR_LANGFUSE_OBSERVATION_TYPE]: 'generation',
        ...identityAttributes(correlation, identity),
        ...rootAttributes,
        [ATTR_DSH_COMPACTION_ID]: payload.compactionId,
        [ATTR_DSH_COMPACTION_DURATION_SCOPE]: 'transaction',
        [ATTR_DSH_COMPACTION_SUMMARY_SEEN]: false,
        [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
        ...payload.turn === null ? {} : { [ATTR_DSH_TURN]: payload.turn },
        ...payload.sourceCommandId === undefined ? {} : {
          [ATTR_DSH_COMPACTION_SOURCE_COMMAND_ID]: payload.sourceCommandId,
        },
        ...orphanedOwner ? { [ATTR_DSH_COMPACTION_ORPHANED_OWNER]: true } : {},
      },
    }, parentContext)
    state.compactions.set(payload.compactionId, {
      span,
      compactionId: payload.compactionId,
      sourceCommandId: payload.sourceCommandId,
      sawSummary: false,
    })
  }

  /** Enrich the open transaction without exporting raw provider output or seq lists. */
  private foldCompactionSummary(state: SessionState, record: SessionTelemetryRecord): void {
    const payload = readCompactionSummary(record)
    if (payload === undefined) return this.foldPointEvent(state, record)
    const compaction = state.compactions.get(payload.compactionId)
    if (compaction === undefined) return this.foldPointEvent(state, record)

    compaction.sawSummary = true
    if (compaction.sourceCommandId === undefined && payload.sourceCommandId !== undefined) {
      compaction.sourceCommandId = payload.sourceCommandId
      compaction.span.setAttribute(ATTR_DSH_COMPACTION_SOURCE_COMMAND_ID, payload.sourceCommandId)
    }
    compaction.span.setAttributes({
      [ATTR_DSH_COMPACTION_SUMMARY_SEEN]: true,
      [ATTR_DSH_COMPACTION_SHADOWED_SEQ_START]: payload.shadowedRange.start,
      [ATTR_DSH_COMPACTION_SHADOWED_SEQ_END]: payload.shadowedRange.end,
      [ATTR_DSH_COMPACTION_SHADOWED_EVENT_COUNT]: payload.shadowedSeqs.length,
      [ATTR_DSH_COMPACTION_SHADOWED_TOKEN_COUNT]: payload.shadowedTokenCount,
      [ATTR_GEN_AI_PROVIDER_NAME]: payload.provider,
      [ATTR_GEN_AI_REQUEST_MODEL]: payload.model,
      [ATTR_LANGFUSE_OBSERVATION_INPUT]: this.clip({
        shadowedRange: payload.shadowedRange,
        shadowedEventCount: payload.shadowedSeqs.length,
        shadowedTokenCount: payload.shadowedTokenCount,
      }),
      [ATTR_LANGFUSE_OBSERVATION_OUTPUT]: this.clip(payload.summary),
      ...payload.maxTokens === undefined ? {} : {
        [ATTR_GEN_AI_REQUEST_MAX_TOKENS]: payload.maxTokens,
      },
      ...payload.usage === undefined ? {} : toGenAiUsageAttributes(payload.usage),
    })
  }

  private foldCompactionEnd(state: SessionState, record: SessionTelemetryRecord): void {
    const payload = readCompactionEnd(record)
    if (payload === undefined) return this.foldPointEvent(state, record)
    const compaction = state.compactions.get(payload.compactionId)
    if (compaction === undefined) return this.foldPointEvent(state, record)
    if (compaction.sourceCommandId === undefined && payload.sourceCommandId !== undefined) {
      compaction.sourceCommandId = payload.sourceCommandId
      compaction.span.setAttribute(ATTR_DSH_COMPACTION_SOURCE_COMMAND_ID, payload.sourceCommandId)
    }
    this.endCompaction(state, compaction, record.time, false, payload.error)
  }

  /** Pruning is instantaneous bookkeeping, so it stays a span event. */
  private foldCompactionPrune(state: SessionState, record: SessionTelemetryRecord): void {
    const payload = readCompactionPrune(record)
    if (payload === undefined) return this.foldPointEvent(state, record)
    this.pointEventTarget(state)?.addEvent('compaction/prune', {
      [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
      [ATTR_DSH_COMPACTION_SHADOWED_SEQ_START]: payload.shadowedRange.start,
      [ATTR_DSH_COMPACTION_SHADOWED_SEQ_END]: payload.shadowedRange.end,
      [ATTR_DSH_COMPACTION_SHADOWED_EVENT_COUNT]: payload.shadowedSeqs.length,
      [ATTR_DSH_COMPACTION_SHADOWED_TOKEN_COUNT]: payload.shadowedTokenCount,
    }, record.time)
  }

  /** Preserve merge-extensible and malformed events without inventing spans. */
  private foldPointEvent(state: SessionState, record: SessionTelemetryRecord): void {
    this.pointEventTarget(state)?.addEvent(
      String(record.attributes['event.type']),
      { [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'] },
      record.time,
    )
  }

  private pointEventTarget(state: SessionState): Span | undefined {
    if (state.turn !== undefined) return state.turn.span
    let latest: Span | undefined
    for (const compaction of state.compactions.values()) latest = compaction.span
    return latest
  }

  private endCompaction(
    state: SessionState,
    compaction: CompactionState,
    time: number,
    forced: boolean,
    error?: string,
  ): void {
    state.compactions.delete(compaction.compactionId)
    compaction.span.setAttribute(ATTR_DSH_COMPACTION_SUMMARY_SEEN, compaction.sawSummary)
    if (forced) compaction.span.setAttribute(ATTR_DSH_FORCE_ENDED, true)

    const incomplete = error === undefined && !compaction.sawSummary
    if (error !== undefined || incomplete || forced) {
      const message = error
        ?? (forced ? 'compaction lifecycle force-ended before compaction/end' : 'compaction/end arrived before compaction/summary')
      compaction.span.setAttribute(ATTR_DSH_COMPACTION_ERROR, this.clip(message))
      compaction.span.setStatus({ code: SpanStatusCode.ERROR, message })
    }
    compaction.span.end(time)
  }

  private endCompactions(state: SessionState, time: number, forced: boolean): void {
    for (const compaction of [...state.compactions.values()]) {
      this.endCompaction(state, compaction, time, forced)
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
        else this.endCompactions(state, record.time, true)
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
    this.endCompactions(state, time, forced)
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
      else this.endCompactions(state, time, true)
      this.sessions.delete(id)
    }
  }
}
