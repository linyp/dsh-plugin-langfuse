/** Health and delivery diagnostics for the two Langfuse telemetry channels. */

export const DEFAULT_HEALTH_WARNING_INTERVAL_MILLIS = 60_000
export const DEFAULT_HEALTH_MAX_ERROR_CHARS = 1_000

export type TelemetryHealthState = 'disabled' | 'starting' | 'healthy' | 'degraded' | 'stopped'

export interface SanitizedTelemetryError {
  readonly name: string
  readonly code?: string
  readonly message: string
}

export interface LangfuseTelemetryStatus {
  readonly state: TelemetryHealthState
  readonly observedAt: number
  readonly traces: {
    readonly state: TelemetryHealthState
    /** The SDK does not expose BatchSpanProcessor queue depth. */
    readonly queuedBySdk: 'unknown'
    readonly successfulBatches: number
    readonly failedBatches: number
    readonly successfulSpans: number
    readonly failedSpans: number
    readonly consecutiveFailures: number
    readonly lastSuccessAt?: number
    readonly lastFailureAt?: number
    readonly lastError?: SanitizedTelemetryError
  }
  readonly scores: {
    readonly state: 'disabled' | 'healthy' | 'degraded' | 'stopped'
    /** Includes the item currently in flight. */
    readonly queued: number
    readonly delivered: number
    readonly dropped: number
    readonly skipped: number
    readonly failed: number
    readonly lastSuccessAt?: number
    readonly lastFailureAt?: number
    readonly lastError?: SanitizedTelemetryError
  }
}

export type ScoreDeliveryEvent =
  | { readonly kind: 'queued' }
  | { readonly kind: 'delivered' }
  | { readonly kind: 'dropped' | 'skipped' | 'failed'; readonly error?: unknown }

export interface TelemetryHealthTrackerOptions {
  readonly enabled: boolean
  readonly scoresEnabled: boolean
  readonly warningIntervalMillis?: number
  readonly maxErrorChars?: number
  readonly onWarning?: (message: string) => void
  readonly onInfo?: (message: string) => void
  readonly now?: () => number
}

interface TraceHealth {
  state: 'starting' | 'healthy' | 'degraded' | 'stopped'
  successfulBatches: number
  failedBatches: number
  successfulSpans: number
  failedSpans: number
  consecutiveFailures: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastError?: SanitizedTelemetryError
}

interface ScoreHealth {
  state: 'healthy' | 'degraded' | 'stopped'
  queued: number
  delivered: number
  dropped: number
  skipped: number
  failed: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastError?: SanitizedTelemetryError
}

/**
 * Synchronous, allocation-light health state. Export and Score paths notify it
 * after an outcome is known; status() returns a detached immutable snapshot.
 */
export class TelemetryHealthTracker {
  private readonly enabled: boolean
  private readonly scoresEnabled: boolean
  private readonly warningIntervalMillis: number
  private readonly maxErrorChars: number
  private readonly onWarning: ((message: string) => void) | undefined
  private readonly onInfo: ((message: string) => void) | undefined
  private readonly now: () => number
  private readonly traces: TraceHealth = {
    state: 'starting',
    successfulBatches: 0,
    failedBatches: 0,
    successfulSpans: 0,
    failedSpans: 0,
    consecutiveFailures: 0,
  }
  private readonly scores: ScoreHealth = {
    state: 'healthy',
    queued: 0,
    delivered: 0,
    dropped: 0,
    skipped: 0,
    failed: 0,
  }
  private stopped = false
  private lastTraceWarningAt: number | undefined
  private traceOutageStartedAt: number | undefined

  constructor(options: TelemetryHealthTrackerOptions) {
    this.enabled = options.enabled
    this.scoresEnabled = options.scoresEnabled
    this.warningIntervalMillis = options.warningIntervalMillis ?? DEFAULT_HEALTH_WARNING_INTERVAL_MILLIS
    this.maxErrorChars = options.maxErrorChars ?? DEFAULT_HEALTH_MAX_ERROR_CHARS
    this.onWarning = options.onWarning
    this.onInfo = options.onInfo
    this.now = options.now ?? Date.now
  }

  observeTraceExport(success: boolean, spanCount: number, error?: unknown): void {
    if (!this.enabled || this.stopped) return
    const now = this.now()
    if (success) {
      const priorState = this.traces.state
      const priorFailures = this.traces.consecutiveFailures
      const outageStartedAt = this.traceOutageStartedAt
      this.traces.state = 'healthy'
      this.traces.successfulBatches += 1
      this.traces.successfulSpans += spanCount
      this.traces.consecutiveFailures = 0
      this.traces.lastSuccessAt = now
      this.traceOutageStartedAt = undefined
      if (priorState === 'degraded') {
        const outageMillis = outageStartedAt === undefined ? undefined : Math.max(0, now - outageStartedAt)
        this.safeLog(this.onInfo, `dsh-plugin-langfuse: OTLP trace export recovered after ${priorFailures} consecutive failure(s)${outageMillis === undefined ? '' : ` (${outageMillis}ms outage)`}`)
      }
      return
    }

    if (this.traces.state !== 'degraded') this.traceOutageStartedAt = now
    this.traces.state = 'degraded'
    this.traces.failedBatches += 1
    this.traces.failedSpans += spanCount
    this.traces.consecutiveFailures += 1
    this.traces.lastFailureAt = now
    this.traces.lastError = sanitizeTelemetryError(
      error ?? new Error('OTLP exporter reported failure without an error'),
      this.maxErrorChars,
    )
    if (this.lastTraceWarningAt === undefined
      || (this.warningIntervalMillis > 0 && now - this.lastTraceWarningAt >= this.warningIntervalMillis)) {
      this.lastTraceWarningAt = now
      const detail = this.traces.lastError
      this.safeLog(this.onWarning, `dsh-plugin-langfuse: OTLP trace export failed; telemetry is degraded: ${detail.name}${detail.code === undefined ? '' : ` (${detail.code})`}: ${detail.message}`)
    }
  }

  observeScore(event: ScoreDeliveryEvent): void {
    if (!this.enabled || !this.scoresEnabled || this.stopped) return
    const now = this.now()
    switch (event.kind) {
      case 'queued':
        this.scores.queued += 1
        return
      case 'delivered':
        this.scores.queued = Math.max(0, this.scores.queued - 1)
        this.scores.delivered += 1
        this.scores.lastSuccessAt = now
        this.scores.state = 'healthy'
        return
      case 'dropped':
        this.scores.dropped += 1
        break
      case 'skipped':
        this.scores.skipped += 1
        break
      case 'failed':
        this.scores.queued = Math.max(0, this.scores.queued - 1)
        this.scores.failed += 1
        break
    }
    this.scores.state = 'degraded'
    this.scores.lastFailureAt = now
    this.scores.lastError = sanitizeTelemetryError(
      event.error ?? new Error(`feedback Score ${event.kind}`),
      this.maxErrorChars,
    )
  }

  markStopped(): void {
    if (!this.enabled || this.stopped) return
    this.stopped = true
    this.traces.state = 'stopped'
    this.scores.state = 'stopped'
  }

  status(): LangfuseTelemetryStatus {
    const observedAt = this.now()
    if (!this.enabled) {
      return {
        state: 'disabled',
        observedAt,
        traces: {
          state: 'disabled',
          queuedBySdk: 'unknown',
          successfulBatches: 0,
          failedBatches: 0,
          successfulSpans: 0,
          failedSpans: 0,
          consecutiveFailures: 0,
        },
        scores: {
          state: 'disabled',
          queued: 0,
          delivered: 0,
          dropped: 0,
          skipped: 0,
          failed: 0,
        },
      }
    }

    const traceState = this.traces.state
    const scoreState = !this.scoresEnabled ? 'disabled' : this.scores.state
    const state: TelemetryHealthState = this.stopped
      ? 'stopped'
      : traceState === 'degraded' || scoreState === 'degraded'
        ? 'degraded'
        : traceState === 'starting'
          ? 'starting'
          : 'healthy'
    return {
      state,
      observedAt,
      traces: {
        state: traceState,
        queuedBySdk: 'unknown',
        successfulBatches: this.traces.successfulBatches,
        failedBatches: this.traces.failedBatches,
        successfulSpans: this.traces.successfulSpans,
        failedSpans: this.traces.failedSpans,
        consecutiveFailures: this.traces.consecutiveFailures,
        ...this.traces.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.traces.lastSuccessAt },
        ...this.traces.lastFailureAt === undefined ? {} : { lastFailureAt: this.traces.lastFailureAt },
        ...this.traces.lastError === undefined ? {} : { lastError: { ...this.traces.lastError } },
      },
      scores: {
        state: scoreState,
        queued: this.scores.queued,
        delivered: this.scores.delivered,
        dropped: this.scores.dropped,
        skipped: this.scores.skipped,
        failed: this.scores.failed,
        ...this.scores.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.scores.lastSuccessAt },
        ...this.scores.lastFailureAt === undefined ? {} : { lastFailureAt: this.scores.lastFailureAt },
        ...this.scores.lastError === undefined ? {} : { lastError: { ...this.scores.lastError } },
      },
    }
  }

  private safeLog(logger: ((message: string) => void) | undefined, message: string): void {
    try {
      logger?.(message)
    } catch {
      // Host logging must never change telemetry delivery.
    }
  }
}

/** Reduce arbitrary transport failures to a bounded, credential-free shape. */
export function sanitizeTelemetryError(error: unknown, maxChars = DEFAULT_HEALTH_MAX_ERROR_CHARS): SanitizedTelemetryError {
  const source = isObject(error) ? error : undefined
  const rawName = typeof source?.['name'] === 'string' && source['name'].length > 0 ? source['name'] : 'Error'
  const rawCode = source?.['code']
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined
  const rawMessage = typeof source?.['message'] === 'string' ? source['message'] : String(error)
  const message = clip(sanitizeSecrets(rawMessage), maxChars)
  const name = clip(sanitizeSecrets(rawName), 100)
  return {
    name,
    ...code === undefined ? {} : { code: clip(sanitizeSecrets(code), 100) },
    message,
  }
}

function sanitizeSecrets(value: string): string {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/giu, 'Basic [redacted]')
    .replace(/\b(?:pk|sk)-lf-[A-Za-z0-9_-]+\b/giu, '[redacted-key]')
    .replace(/\b(authorization|public[_-]?key|secret[_-]?key)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 10))}…[clipped]`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
