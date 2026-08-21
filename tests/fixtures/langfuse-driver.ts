#!/usr/bin/env node
/**
 * Test driver: start a mock Langfuse OTLP collector, boot the fixture Loader
 * composition against it, run one mocked-model turn with a real bash round
 * trip, fork a child with one live turn, then persist everything captured to
 * `./otlp-captures.json` for the e2e's inspect step. Erasable-syntax
 * TypeScript only: runs under plain Node type stripping.
 */

import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('langfuse driver requires a config path')

interface Capture {
  path: string
  authorization: string | undefined
  ingestionVersion: string | undefined
  body: unknown
}

const captures: Capture[] = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk as Buffer))
  request.on('end', () => {
    const ingestionVersion = request.headers['x-langfuse-ingestion-version']
    captures.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      ingestionVersion: Array.isArray(ingestionVersion) ? ingestionVersion[0] : ingestionVersion,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    })
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('collector has no port')
// The Langfuse-shaped signal path: the fixture config reads this env url.
process.env.LANGFUSE_E2E_URL = `http://127.0.0.1:${address.port}/api/public/otel/v1/traces`
process.env.LANGFUSE_E2E_SCORE_URL = `http://127.0.0.1:${address.port}/api/public/scores`

const ctx = await boot('langfuse-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'prove the langfuse trace export' })
  const session = ctx.get('sessions')?.list()[0]
  if (session === undefined) throw new Error('langfuse driver saw no session after the fixture turn')
  recordFeedback(session, 'e2e feedback score')
  // Exercise the merge-extensible session vocabulary without taking a direct
  // dependency on the compaction plugin's release-candidate peer graph.
  const appendExtensionEvent = session.append.bind(session) as unknown as (type: string, data: unknown, options?: unknown) => void
  appendExtensionEvent('compaction/start', { compactionId: 'e2e-compaction', turn: null })
  appendExtensionEvent('compaction/summary', {
    compactionId: 'e2e-compaction',
    summary: 'e2e compacted context',
    shadowedRange: { start: 1, end: 3 },
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 512,
    provider: 'deepseek',
    model: 'deepseek-chat',
    usage: { inputTokens: 8, outputTokens: 2 },
  })
  appendExtensionEvent('compaction/end', { compactionId: 'e2e-compaction', turn: null })
  // A compaction inherited without its summary/end must close at the seed
  // boundary even when no turn is open, rather than lingering until shutdown.
  appendExtensionEvent('compaction/start', { compactionId: 'e2e-seed-orphan', turn: null })
  appendExtensionEvent('session/end-seed', {})
  // Exercise the real SessionStore fork path: inherited seed rows are not
  // re-emitted, while every live child row carries parent/seed attributes.
  const child = ctx.sessions.fork(session)
  const appendChildEvent = child.append.bind(child) as unknown as (type: string, data: unknown, options?: unknown) => void
  appendChildEvent('agent-preset/selected', { agentPreset: 'diagnostic' })
  appendChildEvent('subagent/descriptor', {
    version: 2,
    mode: 'continuable',
    provider: 'langfuse-e2e',
    label: 'diagnostic child',
  })
  appendChildEvent('session/title', {
    title: 'E2E child trace',
    messageSeqs: [],
    source: { kind: 'user' },
  })
  appendChildEvent('turn/start', { turn: 2 })
  appendChildEvent('step/start', { turn: 2, step: 1 })
  appendChildEvent('request/header', {
    header: {
      config: {
        provider: 'langfuse-mock',
        model: 'langfuse-diagnostic',
        maxTokens: 512,
        temperature: 0.1,
        reasoningEffort: 'off',
      },
    },
    reason: 'change',
  })
  appendChildEvent('request/context', {
    provider: 'langfuse-mock',
    model: 'langfuse-diagnostic',
    contextWindow: 16_384,
  })
  appendChildEvent('llm/retry', {
    retryId: 'e2e-retry',
    turn: 2,
    step: 1,
    provider: 'langfuse-mock',
    mode: 'normal',
    policyKey: 'e2e',
    retry: 1,
    maxRetries: 2,
    delayMs: 25,
    failure: { message: 'synthetic rate limit', code: 'RATE_LIMIT', status: 429 },
  })
  appendChildEvent('llm/retry-started', {
    retryId: 'e2e-retry',
    turn: 2,
    step: 1,
    retry: 1,
  })
  const callId = CallId('langfuse-e2e-diagnostic-call')
  appendChildEvent('tool/call', {
    turn: 2,
    step: 1,
    callId,
    name: 'diagnostic',
    arguments: JSON.stringify({ probe: true }),
  })
  appendChildEvent('approval/asked', {
    id: 'langfuse-e2e-approval',
    toolName: 'diagnostic',
    callId,
    reason: 'exercise approval telemetry',
  })
  appendChildEvent('approval/decided', {
    id: 'langfuse-e2e-approval',
    outcome: 'rejected',
  })
  appendChildEvent('tool/result', {
    turn: 2,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [
        { type: 'text', text: 'diagnostic first block' },
        { type: 'text', text: 'diagnostic second block' },
      ],
      isError: true,
    }),
    error: { name: 'DiagnosticError', code: 'DIAGNOSTIC_REJECTED' },
    meta: { safe: 'visible', secret: 'must-not-export' },
  }, { surfaceOp: 'append' })
  appendChildEvent('step/end', { turn: 2, step: 1 })
  appendChildEvent('turn/end', { turn: 2, reason: { kind: 'completed' } })
} finally {
  await ctx.fiber.dispose()
}
await writeFile('./otlp-captures.json', JSON.stringify(captures))
server.close()
server.closeAllConnections()
