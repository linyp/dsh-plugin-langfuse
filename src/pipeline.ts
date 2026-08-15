/** Failure-isolated composition of trace projection and feedback Scores. */

import type { SessionTelemetryRecord, SessionTelemetrySink } from '@deepseek-ai/dsh-session-telemetry'
import type { SessionSpanFolder } from './projection.ts'
import type { FeedbackScoreSink } from './score.ts'

export interface LangfuseTelemetryPipelineOptions {
  folder: SessionSpanFolder
  scoreSink?: FeedbackScoreSink
  shutdownTraces: () => Promise<void>
}

/** One canonical record fans out to traces first and optional Scores second. */
export class LangfuseTelemetryPipeline implements SessionTelemetrySink {
  private readonly folder: SessionSpanFolder
  private readonly scoreSink: FeedbackScoreSink | undefined
  private readonly shutdownTraces: () => Promise<void>

  constructor(options: LangfuseTelemetryPipelineOptions) {
    this.folder = options.folder
    this.scoreSink = options.scoreSink
    this.shutdownTraces = options.shutdownTraces
  }

  emit(record: SessionTelemetryRecord): void {
    let projectionError: unknown
    let projectionFailed = false
    try {
      this.folder.fold(record)
    } catch (error) {
      projectionFailed = true
      projectionError = error
    }
    // The Score sink contains its own failure boundary. Keep this guard so a
    // future implementation cannot accidentally couple it to trace export.
    try {
      this.scoreSink?.accept(record)
    } catch {
      // Score delivery is strictly best-effort.
    }
    if (projectionFailed) throw projectionError
  }

  async shutdown(): Promise<void> {
    const errors: unknown[] = []
    try {
      this.folder.endAll(Date.now())
    } catch (error) {
      errors.push(error)
    }
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.shutdownTraces()),
      Promise.resolve().then(() => this.scoreSink?.shutdown()),
    ])
    errors.push(...results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'dsh-plugin-langfuse: telemetry shutdown failed')
  }
}
