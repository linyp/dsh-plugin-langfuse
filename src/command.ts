/** Human-facing diagnostics command for the Langfuse telemetry backend. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionTelemetrySharingStatus } from '@deepseek-ai/dsh-session-telemetry'
import type { LangfuseTelemetryStatus, SanitizedTelemetryError } from './health.ts'

export const LANGFUSE_STATUS_USAGE = 'Usage: /langfuse status [--json]'

/** Minimum backend surface consumed by the command. */
export interface LangfuseStatusSource {
  readonly sharing: SessionTelemetrySharingStatus
  status(): LangfuseTelemetryStatus
}

/** Stable machine-readable envelope returned by `/langfuse status --json`. */
export interface LangfuseStatusReport extends LangfuseTelemetryStatus {
  readonly plugin: 'dsh-plugin-langfuse'
  readonly version: string
  readonly sharing: SessionTelemetrySharingStatus
}

/** Add plugin identity and sharing policy to one detached health snapshot. */
export function createLangfuseStatusReport(
  source: LangfuseStatusSource,
  pluginVersion: string,
): LangfuseStatusReport {
  return {
    plugin: 'dsh-plugin-langfuse',
    version: pluginVersion,
    sharing: source.sharing,
    ...source.status(),
  }
}

function timestamp(value: number | undefined): string {
  if (value === undefined) return 'never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function errorText(error: SanitizedTelemetryError | undefined): string | undefined {
  if (error === undefined) return undefined
  return `${error.name}${error.code === undefined ? '' : ` (${error.code})`}: ${error.message}`
}

/** Render a compact, line-oriented status suitable for Harness command UIs. */
export function formatLangfuseStatus(report: LangfuseStatusReport): string {
  const traceError = errorText(report.traces.lastError)
  const scoreError = errorText(report.scores.lastError)
  return [
    `${report.plugin} ${report.version}`,
    `overall=${report.state} sharing=${report.sharing} observedAt=${timestamp(report.observedAt)}`,
    `traces=${report.traces.state} sdkQueue=${report.traces.queuedBySdk}`,
    `  batches: succeeded=${report.traces.successfulBatches} failed=${report.traces.failedBatches}`,
    `  spans: succeeded=${report.traces.successfulSpans} failed=${report.traces.failedSpans}`,
    `  consecutiveFailures=${report.traces.consecutiveFailures} lastSuccessAt=${timestamp(report.traces.lastSuccessAt)} lastFailureAt=${timestamp(report.traces.lastFailureAt)}`,
    ...traceError === undefined ? [] : [`  lastError=${traceError}`],
    `scores=${report.scores.state} queued=${report.scores.queued} delivered=${report.scores.delivered} dropped=${report.scores.dropped} skipped=${report.scores.skipped} failed=${report.scores.failed}`,
    `  lastSuccessAt=${timestamp(report.scores.lastSuccessAt)} lastFailureAt=${timestamp(report.scores.lastFailureAt)}`,
    ...scoreError === undefined ? [] : [`  lastError=${scoreError}`],
  ].join('\n')
}

/** Parse and execute the `langfuse` command without performing network I/O. */
export function executeLangfuseCommand(
  rawInput: string,
  source: LangfuseStatusSource,
  pluginVersion: string,
): CommandResult {
  const args = rawInput.trim().split(/\s+/u).filter(Boolean)
  const json = args.length === 2 && args[0] === 'status' && args[1] === '--json'
  if (!(args.length === 1 && args[0] === 'status') && !json) {
    return { kind: 'error', text: LANGFUSE_STATUS_USAGE }
  }
  const report = createLangfuseStatusReport(source, pluginVersion)
  return {
    kind: 'success',
    text: json ? JSON.stringify(report, null, 2) : formatLangfuseStatus(report),
  }
}

/**
 * Register `/langfuse status` whenever the host composes the optional commands
 * service. Headless telemetry-only contexts remain valid.
 */
export function installLangfuseStatusCommand(
  ctx: Context,
  source: LangfuseStatusSource,
  pluginVersion: string,
): void {
  ctx.inject(['commands'], (commandContext) => {
    commandContext.commands.register({
      name: 'langfuse',
      description: 'show local Langfuse telemetry delivery status',
      input: { hint: 'status [--json]' },
      recordInput: false,
      handler: invocation => executeLangfuseCommand(invocation.rawInput, source, pluginVersion),
    })
  })
}
