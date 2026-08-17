/**
 * Langfuse Service Provider for the DeepSeek Harness telemetry capability.
 *
 * Registers as the telemetry seam's backend and exports each session as an
 * OpenTelemetry trace tree — GenAI semantic conventions plus `langfuse.*`
 * attributes — through the OTLP/HTTP trace exporter, pointed at Langfuse's
 * OTLP endpoint (`/api/public/otel/v1/traces`; the endpoint accepts traces
 * only, which is why the official OTLP-*logs* backend cannot feed Langfuse).
 * Everything downstream of span creation — batching, retry, queueing, loss
 * policy — is the OTel SDK's documented behavior, configured verbatim through
 * the `exporter`/`processor` passthroughs. Architecture decisions: README.
 *
 * @module dsh-plugin-langfuse
 */

import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-command-feedback'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetryRecord,
  type SessionTelemetrySharingStatus,
  type SessionTelemetrySink,
} from '@deepseek-ai/dsh-session-telemetry'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import type { BufferConfig } from '@opentelemetry/sdk-trace-base'
import { TelemetryIdentityRegistry } from './identity-registry.ts'
import { buildBasicAuthHeader, buildTracerPipeline, type TracerPipeline } from './otel.ts'
import { LangfuseTelemetryPipeline } from './pipeline.ts'
import { DEFAULT_MAX_ATTRIBUTE_CHARS, SessionSpanFolder, type CorrelationConfig } from './projection.ts'
import {
  DEFAULT_SCORE_QUEUE_SIZE,
  DEFAULT_SCORE_REQUEST_TIMEOUT_MILLIS,
  FeedbackScoreSink,
  LangfuseScoreHttpTransport,
} from './score.ts'

export { DEFAULT_MAX_ATTRIBUTE_CHARS, type CorrelationConfig }
export {
  createCompactionParentContext,
  createDshCompactionTraceId,
  createDshFeedbackScoreId,
  createDshTurnTraceId,
  TRACEPARENT_ATTRIBUTE,
  TRACESTATE_ATTRIBUTE,
} from './identity.ts'
export {
  DEFAULT_SCORE_QUEUE_SIZE,
  DEFAULT_SCORE_REQUEST_TIMEOUT_MILLIS,
  FEEDBACK_SCORE_NAME,
  FeedbackScoreSink,
  LangfuseScoreHttpTransport,
  MAX_TEXT_SCORE_CHARS,
  ScoreTransportError,
  mapFeedbackRecord,
  type ScoreTransport,
  type SessionTextScore,
} from './score.ts'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Session-sharing policy selected by {@link Config.mode}; mirrors the official OTel backend's vocabulary. */
export enum LangfuseTelemetryMode {
  FULL = 'FULL',
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** Default sharing policy for schema and direct construction: local-only. */
export const DEFAULT_TELEMETRY_MODE = LangfuseTelemetryMode.DISABLED

const DISABLED_FEEDBACK_WARNING = 'dsh-plugin-langfuse is DISABLED; nothing will be shared and this feedback remains local'
const NON_CANONICAL_FEEDBACK_WARNING = 'dsh-plugin-langfuse ignored a feedback event absent from the canonical session log'
const DROP_RECORD: SessionTelemetrySink['emit'] = () => {}

/** Resolve the default and reject unknown runtime values before transport setup. */
function resolveMode(mode: LangfuseTelemetryMode | undefined): LangfuseTelemetryMode {
  const resolved = mode ?? DEFAULT_TELEMETRY_MODE
  switch (resolved) {
    case LangfuseTelemetryMode.FULL:
    case LangfuseTelemetryMode.FEEDBACK_ONLY:
    case LangfuseTelemetryMode.DISABLED:
      return resolved
    default:
      return assertNever(resolved)
  }
}

/** Fail closed when direct construction bypasses the runtime config schema. */
function assertNever(value: never): never {
  throw new Error(`dsh-plugin-langfuse: unsupported mode ${JSON.stringify(value)}`)
}

/** Map the serialized mode onto the seam's backend-independent sharing vocabulary. */
function sharingStatusFor(mode: LangfuseTelemetryMode): SessionTelemetrySharingStatus {
  switch (mode) {
    case LangfuseTelemetryMode.FULL: return 'full'
    case LangfuseTelemetryMode.FEEDBACK_ONLY: return 'feedback-only'
    case LangfuseTelemetryMode.DISABLED: return 'disabled'
    /* v8 ignore next 2 -- resolveMode already rejected unknown values before this switch. */
    default: return assertNever(mode)
  }
}

/**
 * Plugin configuration: one sharing policy, the Langfuse credentials, two
 * SDK option objects, and one plugin-owned shutdown bound.
 * Uploading modes validate endpoint and credentials at plugin load;
 * `DISABLED` reads neither.
 */
export interface Config {
  /** Sharing policy; defaults to local-only `DISABLED` behavior. */
  mode?: LangfuseTelemetryMode
  /**
   * The complete SDK-owned `OTLPExporterNodeConfigBase` shape. The package
   * validates `url` and defaults/wraps `headers` for Langfuse v4 ingestion;
   * every other option passes through unchanged.
   */
  exporter?: OTLPExporterNodeConfigBase & {
    /** Full traces endpoint, e.g. `https://cloud.langfuse.com/api/public/otel/v1/traces`. Required outside `DISABLED`. */
    url?: string
  }
  /**
   * Langfuse project key pair, turned into the endpoint's Basic-auth header.
   * Mutually exclusive with an explicit `exporter.headers.authorization`;
   * uploading modes require exactly one of the two.
   */
  auth?: {
    publicKey?: string
    secretKey?: string
  }
  /**
   * Host-identity correlation for embedding hosts: `userId`/`sessionId` are
   * stamped as `langfuse.user.id`/`langfuse.session.id` on every exported
   * span so the host's own traces and this plugin's group under one Langfuse
   * user/session. `sessionId` defaults to the dsh session id, which always
   * stays on the turn root as `dsh.session.id`. A `turn/start` record
   * carrying either attribute key (a deployment's `session-telemetry/record`
   * waterfall listener injects them) overrides per turn; the resolved
   * snapshot is locked at `turn/start`. NOTE: these static values bypass the
   * redaction waterfall — it transforms records, and these never transit one.
   */
  correlation?: CorrelationConfig
  /**
   * Optional delivery of canonical `feedback/record` values as Langfuse
   * session-level TEXT Scores. Disabled by default and failure-isolated from
   * trace export. `url` is the full `/api/public/scores` endpoint.
   */
  feedbackScores?: {
    enabled?: boolean
    url?: string
    maxQueueSize?: number
    requestTimeoutMillis?: number
  }
  /** Passed verbatim to `BatchSpanProcessor`; the SDK owns and documents these knobs. */
  processor?: BufferConfig
  /**
   * Serialized-payload ceiling per span attribute (characters); longer
   * payloads are clipped with an `…[clipped]` marker. The canonical session
   * log keeps the full bytes. Defaults to
   * {@link DEFAULT_MAX_ATTRIBUTE_CHARS}.
   */
  maxAttributeChars?: number
  /** Maximum time spent awaiting the SDK provider's complete shutdown path. */
  shutdownTimeoutMillis?: number
}

/**
 * Schemastery validator for {@link Config}; cordis runs it before the plugin
 * starts. It declares the small correlation object but leaves the SDK option
 * objects open so unlisted upstream fields are not silently dropped. Runtime
 * value checks remain in the constructor so direct construction fails with
 * the same field-specific errors.
 */
export const Config: z<Config> = z.object({
  mode: z.union(Object.values(LangfuseTelemetryMode)).default(DEFAULT_TELEMETRY_MODE),
  exporter: z.any(),
  auth: z.any(),
  correlation: z.object({
    userId: z.string(),
    sessionId: z.string(),
  }),
  feedbackScores: z.object({
    enabled: z.boolean(),
    url: z.string(),
    maxQueueSize: z.number(),
    requestTimeoutMillis: z.number(),
  }),
  processor: z.any(),
  maxAttributeChars: z.number(),
  shutdownTimeoutMillis: z.number(),
})

/** Default outer allowance for the SDK's complete shutdown sequence. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000

// Node clamps larger timer delays to one millisecond. Runtime protocol
// limit, not a deployment default.
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

/**
 * The backend plugin — the only entry a deployment loads. It always registers
 * the `sessionTelemetry` service (a duplicate backend load throws — see the
 * bundled `cordis.patch.yml`, which disables the base profile's OTLP-logs
 * row). Uploading modes wire the SDK pipeline and compose
 * {@link SessionTelemetryCoordinator}; `DISABLED` constructs no SDK state and
 * listens only to warn when recorded feedback stays local.
 */
export class LangfuseSessionTelemetryBackend extends SessionTelemetryBackend {
  static inject = ['sessions']
  static Config = Config

  private readonly directEmit: SessionTelemetrySink['emit']
  private readonly telemetryPipeline: LangfuseTelemetryPipeline | undefined
  private readonly shutdownTimeoutMillis: number
  override readonly sharing: SessionTelemetrySharingStatus

  constructor(ctx: Context, config: Config) {
    const mode = resolveMode(config.mode)
    super(ctx)
    this.sharing = sharingStatusFor(mode)
    if (mode === LangfuseTelemetryMode.DISABLED) {
      this.directEmit = DROP_RECORD
      this.telemetryPipeline = undefined
      this.shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'feedback/record') ctx.logger.warn(DISABLED_FEEDBACK_WARNING)
      })
      return
    }

    const url = config.exporter?.url
    if (url === undefined || url.length === 0) {
      throw new Error('dsh-plugin-langfuse: exporter.url is required (the full OTLP traces endpoint, e.g. https://cloud.langfuse.com/api/public/otel/v1/traces)')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Re-thrown as a config error: the only way here is a malformed url string.
      throw new Error(`dsh-plugin-langfuse: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`dsh-plugin-langfuse: exporter.url must be http(s), got ${parsed.protocol}`)
    }
    const authHeaders = resolveAuthHeaders(config)
    const headers = withDefaultIngestionVersion(authHeaders)
    const correlation = validateCorrelation(config)
    const feedbackScores = validateFeedbackScores(config)
    const batchSize = config.processor?.maxExportBatchSize
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
      throw new Error(`dsh-plugin-langfuse: processor.maxExportBatchSize must be a positive integer, got ${String(batchSize)}`)
    }
    const maxAttributeChars = config.maxAttributeChars
    if (maxAttributeChars !== undefined && (!Number.isInteger(maxAttributeChars) || maxAttributeChars < 1)) {
      throw new Error(`dsh-plugin-langfuse: maxAttributeChars must be a positive integer, got ${String(maxAttributeChars)}`)
    }
    const shutdownTimeoutMillis = config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
    if (!Number.isFinite(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0 || shutdownTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
      throw new Error(`dsh-plugin-langfuse: shutdownTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(shutdownTimeoutMillis)}`)
    }
    this.shutdownTimeoutMillis = shutdownTimeoutMillis
    const identityRegistry = new TelemetryIdentityRegistry({
      onWarning: message => ctx.logger.warn(message),
    })
    const otelPipeline: TracerPipeline = buildTracerPipeline({
      exporter: { ...config.exporter, url, headers },
      processor: config.processor,
      resourceAttributes: {
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
      },
      scopeName: 'dsh-plugin-langfuse',
      scopeVersion: version,
    })
    const folder = new SessionSpanFolder(otelPipeline.tracer, {
      maxAttributeChars,
      correlation,
      identityRegistry,
    })
    const scoreSink = feedbackScores === undefined
      ? undefined
      : new FeedbackScoreSink({
          transport: new LangfuseScoreHttpTransport({
            url: feedbackScores.url,
            headers: authHeaders,
            requestTimeoutMillis: feedbackScores.requestTimeoutMillis,
          }),
          identityRegistry,
          mode,
          staticSessionId: correlation?.sessionId,
          maxQueueSize: feedbackScores.maxQueueSize,
          onWarning: message => ctx.logger.warn(message),
        })
    const telemetryPipeline = new LangfuseTelemetryPipeline({
      folder,
      scoreSink,
      shutdownTraces: () => otelPipeline.provider.shutdown(),
    })
    this.telemetryPipeline = telemetryPipeline
    const enqueue: SessionTelemetrySink['emit'] = record => telemetryPipeline.emit(record)
    const backend: SessionTelemetrySink = {
      emit: enqueue,
      shutdown: () => this.shutdown(),
    }
    if (mode === LangfuseTelemetryMode.FULL) {
      this.directEmit = enqueue
      new SessionTelemetryCoordinator(ctx, backend, 'live')
      return
    }
    this.directEmit = DROP_RECORD
    const coordinator = new SessionTelemetryCoordinator(ctx, backend, 'on-demand')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'feedback/record') return
      // Consent is the committed record, not an independently emitted bus value.
      if (session.events[event.seq] !== event) {
        ctx.logger.warn(NON_CANONICAL_FEEDBACK_WARNING)
        return
      }
      coordinator.captureSession(session, event.seq)
    })
  }

  /**
   * Hand a direct service record to the folder only in `FULL`. Direct calls
   * are no-ops in `FEEDBACK_ONLY` and `DISABLED`; feedback replay uses the
   * private backend capability created for the canonical feedback listener.
   * @param record - the logical record offered directly to the service.
   */
  emit(record: SessionTelemetryRecord): void {
    this.directEmit(record)
  }

  // The seam's optional flush() hint is deliberately NOT implemented, for the
  // same hazard the official OTel backend documents: the batch processor is
  // this pipeline's only flusher, and forwarding the hint would be the sole
  // source of concurrent flushes against shutdown's internal drain.

  /**
   * Sweep open spans closed, then concurrently drain the OTel provider and
   * Score queue under one plugin-owned deadline. The SDK's export timeout
   * does not bound its preceding `forceFlush()` wait, which can remain pending
   * when the transport never obtains a socket. Both promises remain observed
   * after the deadline so later rejections cannot become unhandled.
   * `DISABLED` has no pipeline and resolves immediately.
   * @returns resolves when both channels quiesce or are disabled, or rejects at the configured deadline.
   */
  async shutdown(): Promise<void> {
    if (this.telemetryPipeline === undefined) return
    const telemetryShutdown = this.telemetryPipeline.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`dsh-plugin-langfuse: telemetry shutdown exceeded ${this.shutdownTimeoutMillis}ms`))
      }, this.shutdownTimeoutMillis)
    })
    try {
      await Promise.race([telemetryShutdown, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

interface ResolvedFeedbackScoresConfig {
  url: string
  maxQueueSize: number
  requestTimeoutMillis: number
}

/** Validate the opt-in Score channel before constructing either transport. */
function validateFeedbackScores(config: Config): ResolvedFeedbackScoresConfig | undefined {
  const value = config.feedbackScores
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`dsh-plugin-langfuse: feedbackScores must be an object, got ${JSON.stringify(value)}`)
  }
  const enabled = value.enabled ?? false
  if (typeof enabled !== 'boolean') {
    throw new Error(`dsh-plugin-langfuse: feedbackScores.enabled must be a boolean, got ${JSON.stringify(enabled)}`)
  }
  if (!enabled) return undefined

  const url = value.url
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('dsh-plugin-langfuse: feedbackScores.url is required when feedbackScores.enabled is true (the full https://.../api/public/scores endpoint)')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`dsh-plugin-langfuse: feedbackScores.url is not a valid URL: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-plugin-langfuse: feedbackScores.url must be http(s), got ${parsed.protocol}`)
  }

  const maxQueueSize = value.maxQueueSize ?? DEFAULT_SCORE_QUEUE_SIZE
  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1) {
    throw new Error(`dsh-plugin-langfuse: feedbackScores.maxQueueSize must be a positive safe integer, got ${String(maxQueueSize)}`)
  }
  const requestTimeoutMillis = value.requestTimeoutMillis ?? DEFAULT_SCORE_REQUEST_TIMEOUT_MILLIS
  if (!Number.isFinite(requestTimeoutMillis) || requestTimeoutMillis <= 0 || requestTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
    throw new Error(`dsh-plugin-langfuse: feedbackScores.requestTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(requestTimeoutMillis)}`)
  }
  return { url, maxQueueSize, requestTimeoutMillis }
}

/** Header selecting Langfuse's ingestion pipeline version. */
const INGESTION_VERSION_HEADER = 'x-langfuse-ingestion-version'

/**
 * Default the `x-langfuse-ingestion-version: 4` header: without it, newly
 * exported spans do not appear in real time on Langfuse's v4 data model. An
 * explicit `exporter.headers` entry (any casing) wins. A `HeadersFactory`
 * is wrapped so the same rule applies to the headers it resolves at export
 * time, including rotating credentials.
 */
export function withDefaultIngestionVersion(headers: OTLPExporterNodeConfigBase['headers']): OTLPExporterNodeConfigBase['headers'] {
  if (typeof headers === 'function') {
    return async () => withDefaultIngestionVersionObject(await headers())
  }
  return withDefaultIngestionVersionObject(headers)
}

/** Apply the ingestion default to one resolved headers object. */
function withDefaultIngestionVersionObject(headers: Record<string, string> | undefined): Record<string, string> {
  const explicit = Object.keys(headers ?? {}).some(key => key.toLowerCase() === INGESTION_VERSION_HEADER)
  if (explicit && headers !== undefined) return headers
  return { [INGESTION_VERSION_HEADER]: '4', ...headers }
}

/**
 * Fail loud on unusable identity values before any span carries them. These
 * checks also protect direct construction that bypasses Cordis/Schemastery.
 */
function validateCorrelation(config: Config): CorrelationConfig | undefined {
  const correlation = config.correlation
  if (correlation === undefined) return undefined
  if (correlation === null || typeof correlation !== 'object' || Array.isArray(correlation)) {
    throw new Error(`dsh-plugin-langfuse: correlation must be an object with optional userId/sessionId strings, got ${JSON.stringify(correlation)}`)
  }
  for (const field of ['userId', 'sessionId'] as const) {
    const value = correlation[field]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`dsh-plugin-langfuse: correlation.${field} must be a non-empty string, got ${JSON.stringify(value)}`)
    }
  }
  return correlation
}

/**
 * Resolve the exporter's `headers`: the `auth` key pair becomes the Basic-auth
 * `authorization` header, or the deployment supplies its own — an explicit
 * `authorization` entry or the SDK's `HeadersFactory` function — never both,
 * never neither.
 */
function resolveAuthHeaders(config: Config): OTLPExporterNodeConfigBase['headers'] {
  const headers = config.exporter?.headers
  const explicit = typeof headers === 'function'
    ? headers
    : headers?.['authorization'] ?? headers?.['Authorization']
  const publicKey = config.auth?.publicKey
  const secretKey = config.auth?.secretKey
  const hasPair = publicKey !== undefined && publicKey.length > 0 && secretKey !== undefined && secretKey.length > 0
  if (explicit !== undefined && hasPair) {
    throw new Error('dsh-plugin-langfuse: set either auth.publicKey/secretKey or exporter.headers authorization, not both')
  }
  if (explicit !== undefined) return headers
  if (!hasPair) {
    throw new Error('dsh-plugin-langfuse: uploading modes require auth.publicKey and auth.secretKey (or an explicit exporter.headers authorization)')
  }
  return { ...headers, authorization: buildBasicAuthHeader(publicKey, secretKey) }
}

export default LangfuseSessionTelemetryBackend
