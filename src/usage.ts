/**
 * Provider-neutral DSH usage -> canonical OpenTelemetry GenAI attributes.
 *
 * DSH reports mutually exclusive input buckets: `inputTokens` is uncached
 * input, while cache reads and cache writes are separate. OpenTelemetry's
 * `gen_ai.usage.input_tokens` is inclusive, so reconstruct the total before
 * Langfuse normalizes the detail buckets back to mutually exclusive usage.
 *
 * @module dsh-plugin-langfuse/usage
 */

import type { Attributes } from '@opentelemetry/api'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from './semconv.ts'

/** Map one DSH model call's disjoint usage buckets to inclusive OTel totals. */
export function toGenAiUsageAttributes(usage: TokenUsage): Attributes {
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  return {
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens + cacheReadTokens + cacheWriteTokens,
    // DSH outputTokens is already inclusive of the optional reasoning detail.
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
    ...usage.cacheReadTokens === undefined ? {} : {
      [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheReadTokens,
    },
    ...usage.cacheWriteTokens === undefined ? {} : {
      [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheWriteTokens,
    },
    ...usage.reasoningTokens === undefined ? {} : {
      [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: usage.reasoningTokens,
    },
  }
}
