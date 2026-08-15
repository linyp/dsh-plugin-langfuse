import { describe, expect, it } from 'vitest'
import { toGenAiUsageAttributes } from '../src/usage.ts'
import {
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_TOKENS,
} from '../src/semconv.ts'

describe('toGenAiUsageAttributes', () => {
  it('maps uncached usage without inventing optional detail buckets', () => {
    expect(toGenAiUsageAttributes({ inputTokens: 11, outputTokens: 3 })).toEqual({
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 3,
    })
  })

  it('reconstructs the inclusive OTel input total from DSH disjoint buckets', () => {
    expect(toGenAiUsageAttributes({
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 1,
    })).toEqual({
      'gen_ai.usage.input_tokens': 16,
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.cache_read.input_tokens': 2,
      'gen_ai.usage.cache_creation.input_tokens': 3,
      'gen_ai.usage.reasoning.output_tokens': 1,
    })
  })

  it('preserves explicit zero detail buckets while keeping totals unchanged', () => {
    expect(toGenAiUsageAttributes({
      inputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })).toEqual({
      'gen_ai.usage.input_tokens': 7,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.cache_read.input_tokens': 0,
      'gen_ai.usage.cache_creation.input_tokens': 0,
      'gen_ai.usage.reasoning.output_tokens': 0,
    })
  })
})

describe('usage semantic-convention compatibility aliases', () => {
  it('keeps deprecated deep-import constants on their canonical attribute keys', () => {
    expect(ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS).toBe(ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS)
    expect(ATTR_GEN_AI_USAGE_REASONING_TOKENS).toBe(ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS)
  })
})
