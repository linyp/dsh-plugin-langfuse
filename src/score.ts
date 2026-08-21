/**
 * Post-waterfall feedback mapping and a failure-isolated Langfuse Scores API
 * delivery channel. The canonical DSH event log remains the source of truth;
 * this module only sees SessionTelemetryRecord values handed to the backend.
 *
 * @module dsh-plugin-langfuse/score
 */

import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import type { ScoreDeliveryEvent } from './health.ts'
import { createDshFeedbackScoreId } from './identity.ts'
import type { TelemetryIdentityRegistry } from './identity-registry.ts'

export const FEEDBACK_SCORE_NAME = 'dsh_user_feedback'
export const MAX_TEXT_SCORE_CHARS = 500
export const DEFAULT_SCORE_QUEUE_SIZE = 256
export const DEFAULT_SCORE_REQUEST_TIMEOUT_MILLIS = 3_000
export const MAX_SCORE_ATTEMPTS = 3

const CLIPPED_MARKER = '…[clipped]'
const RETRY_DELAYS_MILLIS = [250, 1_000] as const
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

export type FeedbackScoreMode = 'FULL' | 'FEEDBACK_ONLY'
export type ScoreAuthHeaders = OTLPExporterNodeConfigBase['headers']

/** Langfuse session-level TEXT Score request body. */
export interface SessionTextScore {
  id: string
  sessionId: string
  name: typeof FEEDBACK_SCORE_NAME
  value: string
  dataType: 'TEXT'
  metadata: {
    dshSessionId: string
    dshEventSeq: number
    dshEventTime: string
    dshTelemetryMode: FeedbackScoreMode
    truncated: boolean
  }
}

export interface FeedbackScoreMapperOptions {
  identityRegistry: TelemetryIdentityRegistry
  mode: FeedbackScoreMode
  staticSessionId?: string
  onAmbiguousSubject?: () => void
}

/** HTTP abstraction kept intentionally smaller than a second Langfuse SDK. */
export interface ScoreTransport {
  send(score: SessionTextScore): Promise<void>
  shutdown(): Promise<void>
}

export interface FeedbackScoreSinkOptions extends FeedbackScoreMapperOptions {
  transport: ScoreTransport
  maxQueueSize?: number
  onWarning?: (message: string) => void
  onEvent?: (event: ScoreDeliveryEvent) => void
  /** Test seam; production uses the bounded retry schedule above. */
  sleep?: (milliseconds: number) => Promise<void>
}

export interface LangfuseScoreHttpTransportOptions {
  url: string
  headers: ScoreAuthHeaders
  requestTimeoutMillis?: number
  /** Test seam; production uses globalThis.fetch. */
  fetch?: typeof globalThis.fetch
}

/** Error classification used by the queue's bounded retry policy. */
export class ScoreTransportError extends Error {
  constructor(message: string, readonly retriable: boolean, readonly status?: number) {
    super(message)
    this.name = 'ScoreTransportError'
  }
}

/**
 * Map exactly one canonical, post-waterfall feedback record to a Langfuse
 * Score. Invalid or fully redacted values are deliberately not synthesized.
 */
export function mapFeedbackRecord(
  record: SessionTelemetryRecord,
  options: FeedbackScoreMapperOptions,
): SessionTextScore | undefined {
  if (record.channel !== 'ledger' || record.attributes['event.type'] !== 'feedback/record') return undefined

  const dshSessionId = nonEmptyString(record.attributes['session.id'])
  const eventSeq = record.attributes['event.seq']
  const feedbackBody = isObject(record.body) ? record.body : undefined
  const text = feedbackBody === undefined ? undefined : feedbackBody.text
  if (
    dshSessionId === undefined
    || typeof eventSeq !== 'number'
    || !Number.isSafeInteger(eventSeq)
    || eventSeq < 0
    || typeof text !== 'string'
    || text.trim().length === 0
    || !Number.isFinite(record.time)
  ) return undefined
  const eventTime = new Date(record.time)
  if (Number.isNaN(eventTime.getTime())) return undefined

  const explicitSessionId = nonEmptyString(record.attributes['langfuse.session.id'])
  const retained = options.identityRegistry.resolveScoreSession(dshSessionId)
  if (explicitSessionId === undefined && retained.ambiguous) options.onAmbiguousSubject?.()
  const sessionId = explicitSessionId
    ?? retained.langfuseSessionId
    ?? nonEmptyString(options.staticSessionId)
    ?? dshSessionId
  const clipped = clipTextScore(text)

  return {
    id: createDshFeedbackScoreId(dshSessionId, eventSeq),
    sessionId,
    name: FEEDBACK_SCORE_NAME,
    value: clipped.value,
    dataType: 'TEXT',
    metadata: {
      dshSessionId,
      dshEventSeq: eventSeq,
      dshEventTime: eventTime.toISOString(),
      dshTelemetryMode: options.mode,
      truncated: clipped.truncated,
    },
  }
}

/** Native fetch transport for POST /api/public/scores. */
export class LangfuseScoreHttpTransport implements ScoreTransport {
  private readonly url: string
  private readonly headers: ScoreAuthHeaders
  private readonly requestTimeoutMillis: number
  private readonly fetcher: typeof globalThis.fetch

  constructor(options: LangfuseScoreHttpTransportOptions) {
    const requestTimeoutMillis = options.requestTimeoutMillis ?? DEFAULT_SCORE_REQUEST_TIMEOUT_MILLIS
    if (!Number.isFinite(requestTimeoutMillis)
      || requestTimeoutMillis <= 0
      || requestTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
      throw new Error(`dsh-plugin-langfuse: Score request timeout must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}`)
    }
    this.url = options.url
    this.headers = options.headers
    this.requestTimeoutMillis = requestTimeoutMillis
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async send(score: SessionTextScore): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMillis)
    try {
      const resolvedHeaders = typeof this.headers === 'function'
        ? await this.headers()
        : this.headers
      const headers = withJsonContentType(resolvedHeaders)
      let response: Response
      try {
        response = await this.fetcher(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(score),
          signal: controller.signal,
        })
      } catch (error) {
        const reason = controller.signal.aborted ? 'request timed out' : errorMessage(error)
        throw new ScoreTransportError(`dsh-plugin-langfuse: Score delivery failed: ${reason}`, true)
      }
      try {
        await response.body?.cancel()
      } catch {
        // Response-body cleanup must not alter delivery classification.
      }
      if (response.ok) return
      const retriable = response.status === 429 || response.status >= 500
      throw new ScoreTransportError(
        `dsh-plugin-langfuse: Score endpoint returned HTTP ${response.status}`,
        retriable,
        response.status,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async shutdown(): Promise<void> {}
}

/**
 * Single-worker, bounded, best-effort Score queue. accept() never waits for
 * I/O and never throws into the trace/coordinator path.
 */
export class FeedbackScoreSink {
  private readonly queue: SessionTextScore[] = []
  private readonly transport: ScoreTransport
  private readonly mapperOptions: FeedbackScoreMapperOptions
  private readonly maxQueueSize: number
  private readonly onWarning: ((message: string) => void) | undefined
  private readonly onEvent: ((event: ScoreDeliveryEvent) => void) | undefined
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly warned = new Set<string>()
  private worker: Promise<void> | undefined
  private inFlight = false
  private closing = false
  private _droppedCount = 0
  private _skippedCount = 0
  private _failedCount = 0
  private _deliveredCount = 0

  constructor(options: FeedbackScoreSinkOptions) {
    const maxQueueSize = options.maxQueueSize ?? DEFAULT_SCORE_QUEUE_SIZE
    if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1) {
      throw new Error('dsh-plugin-langfuse: Score maxQueueSize must be a positive safe integer')
    }
    this.transport = options.transport
    this.mapperOptions = {
      identityRegistry: options.identityRegistry,
      mode: options.mode,
      staticSessionId: options.staticSessionId,
      onAmbiguousSubject: () => this.warnOnce(
        'ambiguous-subject',
        'dsh-plugin-langfuse: feedback Score used the latest per-turn Langfuse session id after dynamic session correlation changed; inject langfuse.session.id on feedback for strict attribution',
      ),
    }
    this.maxQueueSize = maxQueueSize
    this.onWarning = options.onWarning
    this.onEvent = options.onEvent
    this.sleep = options.sleep ?? delay
  }

  accept(record: SessionTelemetryRecord): void {
    try {
      const score = mapFeedbackRecord(record, this.mapperOptions)
      if (score === undefined) {
        if (record.channel === 'ledger' && record.attributes['event.type'] === 'feedback/record') {
          this._skippedCount += 1
          this.notify({ kind: 'skipped', error: new Error('post-waterfall feedback record was empty or invalid') })
          this.warnOnce('invalid-record', 'dsh-plugin-langfuse: skipped a feedback Score because the post-waterfall record was empty or invalid')
        }
        return
      }
      if (this.closing || this.queue.length + (this.inFlight ? 1 : 0) >= this.maxQueueSize) {
        this._droppedCount += 1
        this.notify({ kind: 'dropped', error: new Error('feedback Score queue is full') })
        this.warnOnce('queue-full', 'dsh-plugin-langfuse: feedback Score queue is full; dropping new Scores')
        return
      }
      this.queue.push(score)
      this.notify({ kind: 'queued' })
      this.startWorker()
    } catch (error) {
      this._skippedCount += 1
      this.notify({ kind: 'skipped', error })
      this.warnOnce('mapping-error', `dsh-plugin-langfuse: skipped a feedback Score after a mapping error: ${errorMessage(error)}`)
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    while (this.worker !== undefined) await this.worker
    await this.transport.shutdown()
  }

  get queuedCount(): number {
    return this.queue.length + (this.inFlight ? 1 : 0)
  }

  get droppedCount(): number {
    return this._droppedCount
  }

  get skippedCount(): number {
    return this._skippedCount
  }

  get failedCount(): number {
    return this._failedCount
  }

  get deliveredCount(): number {
    return this._deliveredCount
  }

  private startWorker(): void {
    if (this.worker !== undefined) return
    // Defer the worker one microtask so accept() remains a pure validation +
    // queue-push hot path and cannot initiate fetch inside coordinator.emit().
    const worker = Promise.resolve().then(() => this.drain()).finally(() => {
      if (this.worker === worker) this.worker = undefined
      if (!this.closing && this.queue.length > 0) this.startWorker()
    })
    this.worker = worker
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const score = this.queue.shift()
      if (score === undefined) continue
      this.inFlight = true
      try {
        await this.deliver(score)
      } finally {
        this.inFlight = false
      }
    }
  }

  private async deliver(score: SessionTextScore): Promise<void> {
    for (let attempt = 1; attempt <= MAX_SCORE_ATTEMPTS; attempt += 1) {
      try {
        await this.transport.send(score)
        this._deliveredCount += 1
        this.notify({ kind: 'delivered' })
        return
      } catch (error) {
        const retriable = !(error instanceof ScoreTransportError) || error.retriable
        if (!retriable || attempt === MAX_SCORE_ATTEMPTS) {
          this._failedCount += 1
          this.notify({ kind: 'failed', error })
          this.warnOnce('delivery-error', `dsh-plugin-langfuse: feedback Score delivery failed and was dropped: ${errorMessage(error)}`)
          return
        }
        await this.sleep(RETRY_DELAYS_MILLIS[attempt - 1] ?? RETRY_DELAYS_MILLIS.at(-1)!)
      }
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    try {
      this.onWarning?.(message)
    } catch {
      // Host logging cannot be allowed to break telemetry delivery.
    }
  }

  private notify(event: ScoreDeliveryEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      // Diagnostics cannot be allowed to break Score delivery.
    }
  }
}

function clipTextScore(text: string): { value: string; truncated: boolean } {
  const points = Array.from(text)
  if (points.length <= MAX_TEXT_SCORE_CHARS) return { value: text, truncated: false }
  const marker = Array.from(CLIPPED_MARKER)
  return {
    value: `${points.slice(0, MAX_TEXT_SCORE_CHARS - marker.length).join('')}${CLIPPED_MARKER}`,
    truncated: true,
  }
}

function withJsonContentType(headers: Record<string, string> | undefined): Record<string, string> {
  const safeHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'content-type'),
  )
  return { ...safeHeaders, 'content-type': 'application/json' }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
