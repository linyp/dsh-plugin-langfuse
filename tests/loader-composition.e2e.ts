/**
 * REAL-composition tier: boot the fixture Loader composition as a subprocess
 * through the same app/boot path a deployment uses, run one mocked-model turn
 * with a real bash round trip, and assert against what the mock Langfuse
 * collector actually received on the wire: the traces path, Basic auth, and
 * the turn/generation/tool span tree with usage attributes.
 *
 * Requires the built artifact (`npm run build`) — the fixture loads
 * `lib/index.js`, the same file a deployment loads.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/langfuse-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/langfuse.cordis.yml', import.meta.url))

interface OtlpSpan {
  name: string
  parentSpanId?: string
  spanId: string
  attributes?: { key: string; value: Record<string, unknown> }[]
  status?: { code?: number }
}

interface Capture {
  path: string
  authorization: string | undefined
  body: {
    resourceSpans?: {
      resource?: { attributes?: { key: string; value: Record<string, unknown> }[] }
      scopeSpans?: { scope?: { name?: string }; spans?: OtlpSpan[] }[]
    }[]
  }
}

function attr(span: OtlpSpan, key: string): unknown {
  return span.attributes?.find(entry => entry.key === key)?.value
}

describe('dsh-plugin-langfuse REAL composition', () => {
  it('exports the turn/generation/tool span tree over Langfuse-shaped OTLP', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    await runLoaderSmoke({
      label: 'dsh-plugin-langfuse',
      tempDirPrefix: 'dsh-plugin-langfuse-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
      // Installed built packages resolve through real `exports`; no tsx.
      mode: 'lib',
      inspect: async (cwd) => {
        const captures = JSON.parse(await readFile(join(cwd, 'otlp-captures.json'), 'utf8')) as Capture[]
        expect(captures.length).toBeGreaterThan(0)

        for (const capture of captures) {
          expect(capture.path).toBe('/api/public/otel/v1/traces')
          expect(capture.authorization).toBe(`Basic ${Buffer.from('pk-lf-e2e:sk-lf-e2e').toString('base64')}`)
        }

        const spans = captures.flatMap(capture =>
          capture.body.resourceSpans?.flatMap(rs => rs.scopeSpans?.flatMap(ss => ss.spans ?? []) ?? []) ?? [])
        // The real agent loop numbers turns and steps from 1.
        const names = spans.map(span => span.name)
        expect(names).toContain('turn 1')
        expect(names).toContain('step 1')
        expect(names).toContain('tool bash')

        const turn = spans.find(span => span.name === 'turn 1')!
        expect(attr(turn, 'langfuse.trace.input')).toBeDefined()

        const generation = spans.find(span => span.name === 'step 1')!
        expect(generation.parentSpanId).toBe(turn.spanId)
        expect(attr(generation, 'langfuse.observation.type')).toEqual({ stringValue: 'generation' })
        expect(attr(generation, 'gen_ai.usage.input_tokens')).toEqual({ intValue: 11 })

        const tool = spans.find(span => span.name === 'tool bash')!
        expect(tool.parentSpanId).toBe(turn.spanId)
        expect(attr(tool, 'langfuse.observation.output')).toBeDefined()
      },
    })
  })
})
