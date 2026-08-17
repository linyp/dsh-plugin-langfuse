/**
 * Attribute keys this exporter emits, in Langfuse's ingestion priority order:
 * `langfuse.*` keys override inferred values, `gen_ai.*` follows the OTel
 * GenAI semantic conventions Langfuse maps natively, and `dsh.*` keys carry
 * harness identity Langfuse passes through as observation metadata.
 *
 * Sources: https://langfuse.com/integrations/native/opentelemetry (property
 * mapping) and the OTel GenAI semantic conventions.
 *
 * @module dsh-plugin-langfuse/semconv
 */

/**
 * Groups traces under one Langfuse session; the correlation-resolved value
 * (defaults to the dsh session id). Langfuse's v4 query model filters and
 * aggregates per observation, so this rides every span, not only the root.
 */
export const ATTR_LANGFUSE_SESSION_ID = 'langfuse.session.id'
/** Langfuse user identity; correlation-resolved, on every span when configured. */
export const ATTR_LANGFUSE_USER_ID = 'langfuse.user.id'
/** Observation type Langfuse assigns the span: `generation`, `span`, `tool`, or `event`. */
export const ATTR_LANGFUSE_OBSERVATION_TYPE = 'langfuse.observation.type'
/** Deprecated trace-level input retained for legacy evaluator compatibility. */
export const ATTR_LANGFUSE_TRACE_INPUT = 'langfuse.trace.input'
/** Deprecated trace-level output retained for legacy evaluator compatibility. */
export const ATTR_LANGFUSE_TRACE_OUTPUT = 'langfuse.trace.output'
/** Trace display name in Langfuse's trace list. */
export const ATTR_LANGFUSE_TRACE_NAME = 'langfuse.trace.name'
/**
 * Marks the DSH turn as the application root observation. This is distinct
 * from being a physical OTel root: deterministic Trace IDs require a
 * non-recording synthetic parent, and distributed traces may have a real
 * upstream parent. Langfuse uses this marker to expose the turn through
 * `isRootObservation` in its observation-first API.
 */
export const ATTR_LANGFUSE_INTERNAL_IS_APP_ROOT = 'langfuse.internal.is_app_root'
/** Stable DSH logical Trace ID, queryable when an external W3C Trace ID wins. */
export const ATTR_LANGFUSE_TRACE_METADATA_DSH_DETERMINISTIC_TRACE_ID = 'langfuse.trace.metadata.dsh_deterministic_trace_id'
/** ISO-8601 first-token time; Langfuse derives time-to-first-token from it. */
export const ATTR_LANGFUSE_COMPLETION_START_TIME = 'langfuse.observation.completion_start_time'
/** Observation-level input (prompt/tool arguments). */
export const ATTR_LANGFUSE_OBSERVATION_INPUT = 'langfuse.observation.input'
/** Observation-level output (completion/tool result). */
export const ATTR_LANGFUSE_OBSERVATION_OUTPUT = 'langfuse.observation.output'

export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model'
export const ATTR_GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens'
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name'
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens'
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens'
export const ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens'
export const ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation.input_tokens'
export const ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS = 'gen_ai.usage.reasoning.output_tokens'
/** @deprecated Use `ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS`. */
export const ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS = ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS
/** @deprecated Use `ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS`. */
export const ATTR_GEN_AI_USAGE_REASONING_TOKENS = ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name'
export const ATTR_GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id'

/** dsh identity attributes, carried for receiver-side dedupe and stitching. */
/** The original dsh session id, kept on the turn root even when correlation overrides `langfuse.session.id` — the pointer back into `$DSH_HOME/sessions`. */
export const ATTR_DSH_SESSION_ID = 'dsh.session.id'
export const ATTR_DSH_EVENT_SEQ = 'dsh.event.seq'
export const ATTR_DSH_TURN = 'dsh.turn'
export const ATTR_DSH_STEP = 'dsh.step'
export const ATTR_DSH_TURN_END_REASON = 'dsh.turn.end_reason'
/** Stable identity and transaction facts for context compaction observations. */
export const ATTR_DSH_COMPACTION_ID = 'dsh.compaction.id'
export const ATTR_DSH_COMPACTION_SOURCE_COMMAND_ID = 'dsh.compaction.source_command_id'
export const ATTR_DSH_COMPACTION_DURATION_SCOPE = 'dsh.compaction.duration_scope'
export const ATTR_DSH_COMPACTION_ORPHANED_OWNER = 'dsh.compaction.orphaned_owner'
export const ATTR_DSH_COMPACTION_SHADOWED_SEQ_START = 'dsh.compaction.shadowed_seq_start'
export const ATTR_DSH_COMPACTION_SHADOWED_SEQ_END = 'dsh.compaction.shadowed_seq_end'
export const ATTR_DSH_COMPACTION_SHADOWED_EVENT_COUNT = 'dsh.compaction.shadowed_event_count'
export const ATTR_DSH_COMPACTION_SHADOWED_TOKEN_COUNT = 'dsh.compaction.shadowed_token_count'
export const ATTR_DSH_COMPACTION_SUMMARY_SEEN = 'dsh.compaction.summary_seen'
export const ATTR_DSH_COMPACTION_ERROR = 'dsh.compaction.error'
/** Versioned logical identity derived from `(dsh session id, turn)`. */
export const ATTR_DSH_TRACE_DETERMINISTIC_ID = 'dsh.trace.deterministic_id'
/** Marks the root of the DSH-owned subtree, even when it has an external parent. */
export const ATTR_DSH_TRACE_LOGICAL_ROOT = 'dsh.trace.logical_root'
/** Direct DSH session from which this child borrowed its seed. */
export const ATTR_DSH_SESSION_PARENT_ID = 'dsh.session.parent_id'
/** Number of leading canonical events inherited from the direct parent. */
export const ATTR_DSH_SESSION_SEED_LENGTH = 'dsh.session.seed_length'
/** Trace ID of the resolved completed parent turn at the fork boundary. */
export const ATTR_DSH_LINEAGE_PARENT_TRACE_ID = 'dsh.lineage.parent_trace_id'
/** Whether the child root contains a real OTel Link to the parent turn. */
export const ATTR_DSH_LINEAGE_LINKED = 'dsh.lineage.linked'
/** Causal relationship type carried on an OTel Link. */
export const ATTR_DSH_LINK_TYPE = 'dsh.link.type'
/** Langfuse trace metadata mirrors for lineage filtering. */
export const ATTR_LANGFUSE_TRACE_METADATA_DSH_PARENT_SESSION_ID = 'langfuse.trace.metadata.dsh_parent_session_id'
export const ATTR_LANGFUSE_TRACE_METADATA_DSH_SEED_LENGTH = 'langfuse.trace.metadata.dsh_seed_length'
export const ATTR_LANGFUSE_TRACE_METADATA_DSH_PARENT_TRACE_ID = 'langfuse.trace.metadata.dsh_parent_trace_id'
/** Marks a span closed by teardown or crash sweep rather than its own end event. */
export const ATTR_DSH_FORCE_ENDED = 'dsh.force_ended'
