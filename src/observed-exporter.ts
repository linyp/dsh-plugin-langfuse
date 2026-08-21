import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

type ExportCallback = Parameters<SpanExporter['export']>[1]

export type SpanExportObserver = (success: boolean, spanCount: number, error?: unknown) => void

const EXPORT_SUCCESS = 0
const EXPORT_FAILED = 1

/** Transparent SpanExporter decorator that observes the delegate callback. */
export class ObservedSpanExporter implements SpanExporter {
  constructor(
    private readonly delegate: SpanExporter,
    private readonly observer: SpanExportObserver,
  ) {}

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    let completed = false
    const complete: ExportCallback = result => {
      if (completed) return
      completed = true
      this.safeObserve(result.code === EXPORT_SUCCESS, spans.length, result.error)
      resultCallback(result)
    }
    try {
      this.delegate.export(spans, complete)
    } catch (error) {
      complete({ code: EXPORT_FAILED, error: toError(error) })
    }
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve()
  }

  private safeObserve(success: boolean, spanCount: number, error?: unknown): void {
    try {
      this.observer(success, spanCount, error)
    } catch {
      // Diagnostics cannot change the exporter contract.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
