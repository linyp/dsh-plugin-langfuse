import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  LANGFUSE_STATUS_USAGE,
  LangfuseSessionTelemetryBackend,
  LangfuseTelemetryMode,
  createLangfuseStatusReport,
  executeLangfuseCommand,
  formatLangfuseStatus,
  type LangfuseStatusSource,
  type LangfuseTelemetryStatus,
} from '../src/index.ts'

const DEGRADED_STATUS: LangfuseTelemetryStatus = {
  state: 'degraded',
  observedAt: Date.parse('2026-08-21T01:02:03.000Z'),
  traces: {
    state: 'degraded',
    queuedBySdk: 'unknown',
    successfulBatches: 2,
    failedBatches: 1,
    successfulSpans: 5,
    failedSpans: 3,
    consecutiveFailures: 1,
    lastSuccessAt: Date.parse('2026-08-21T01:00:00.000Z'),
    lastFailureAt: Date.parse('2026-08-21T01:01:00.000Z'),
    lastError: { name: 'Error', code: 'UNAVAILABLE', message: 'HTTP 503' },
  },
  scores: {
    state: 'healthy',
    queued: 1,
    delivered: 4,
    dropped: 0,
    skipped: 1,
    failed: 0,
    lastSuccessAt: Date.parse('2026-08-21T00:59:00.000Z'),
  },
}

function source(status: LangfuseTelemetryStatus = DEGRADED_STATUS): LangfuseStatusSource {
  return { sharing: 'full', status: () => status }
}

describe('langfuse status command', () => {
  it('renders a complete human-readable local snapshot', () => {
    const report = createLangfuseStatusReport(source(), '0.5.1')
    expect(formatLangfuseStatus(report)).toBe([
      'dsh-plugin-langfuse 0.5.1',
      'overall=degraded sharing=full observedAt=2026-08-21T01:02:03.000Z',
      'traces=degraded sdkQueue=unknown',
      '  batches: succeeded=2 failed=1',
      '  spans: succeeded=5 failed=3',
      '  consecutiveFailures=1 lastSuccessAt=2026-08-21T01:00:00.000Z lastFailureAt=2026-08-21T01:01:00.000Z',
      '  lastError=Error (UNAVAILABLE): HTTP 503',
      'scores=healthy queued=1 delivered=4 dropped=0 skipped=1 failed=0',
      '  lastSuccessAt=2026-08-21T00:59:00.000Z lastFailureAt=never',
    ].join('\n'))
  })

  it('returns the stable report envelope as JSON', () => {
    const result = executeLangfuseCommand(' status --json ', source(), '0.5.1')
    expect(result.kind).toBe('success')
    if (result.kind !== 'success' || result.text === undefined) throw new Error('missing JSON status result')
    expect(JSON.parse(result.text)).toEqual({
      plugin: 'dsh-plugin-langfuse',
      version: '0.5.1',
      sharing: 'full',
      ...DEGRADED_STATUS,
    })
  })

  it.each(['', 'status extra', '--json', 'health'])('rejects unsupported arguments %j', (rawInput) => {
    expect(executeLangfuseCommand(rawInput, source(), '0.5.1')).toEqual({
      kind: 'error',
      text: LANGFUSE_STATUS_USAGE,
    })
  })

  it('registers through the Harness command service and reports DISABLED locally', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LangfuseSessionTelemetryBackend, { mode: LangfuseTelemetryMode.DISABLED })
    const session = ctx.sessions.create(SessionId('langfuse-status-command'))
    const agent = { id: session.id, session } as Parameters<CommandRuntime['execute']>[0]

    expect(ctx.commands.list(agent)).toContainEqual({
      name: 'langfuse',
      description: 'show local Langfuse telemetry delivery status',
      input: { hint: 'status [--json]' },
    })
    const execution = await ctx.commands.execute(
      agent,
      '/langfuse status --json',
      [],
      new AbortController().signal,
    )
    expect(execution?.result.kind).toBe('success')
    const text = execution?.result.text
    if (text === undefined) throw new Error('missing command result text')
    expect(JSON.parse(text)).toMatchObject({
      plugin: 'dsh-plugin-langfuse',
      version: '0.5.1',
      sharing: 'disabled',
      state: 'disabled',
      traces: { state: 'disabled', queuedBySdk: 'unknown' },
      scores: { state: 'disabled' },
    })
    const run = session.events.find(event => event.type === 'command/run')
    expect(run?.type).toBe('command/run')
    expect(run?.type === 'command/run' && Object.hasOwn(run.data, 'args')).toBe(false)

    await ctx.fiber.dispose()
  })

  it('keeps telemetry-only contexts valid when no command service is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LangfuseSessionTelemetryBackend, { mode: LangfuseTelemetryMode.DISABLED })
    expect(ctx.get('sessionTelemetry')).toBeInstanceOf(LangfuseSessionTelemetryBackend)
    await ctx.fiber.dispose()
  })

  it('registers when the optional command service is composed later', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LangfuseSessionTelemetryBackend, { mode: LangfuseTelemetryMode.DISABLED })
    await ctx.plugin(CommandRuntime)
    const session = ctx.sessions.create(SessionId('late-command-service'))
    const agent = { id: session.id, session } as Parameters<CommandRuntime['execute']>[0]

    expect(ctx.commands.list(agent).map(command => command.name)).toContain('langfuse')
    await ctx.fiber.dispose()
  })
})
