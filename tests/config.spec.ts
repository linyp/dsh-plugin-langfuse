/**
 * Config fail-loud tier: every acceptance path proves it rejects an invalid
 * case at plugin load, before any SDK transport is constructed, plus the
 * DISABLED short-circuit, the Basic-auth header builder, and the HMR-safety
 * proof that the service registration disposes with its fiber.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { buildBasicAuthHeader } from '../src/otel.ts'
import {
  DEFAULT_TELEMETRY_MODE,
  LangfuseSessionTelemetryBackend,
  LangfuseTelemetryMode,
  withDefaultIngestionVersion,
  type Config,
} from '../src/index.ts'

const AUTH = { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test' }
const URL_OK = 'https://cloud.langfuse.com/api/public/otel/v1/traces'
const SCORE_URL_OK = 'https://cloud.langfuse.com/api/public/scores'

function construct(config: Config): LangfuseSessionTelemetryBackend {
  return new LangfuseSessionTelemetryBackend(new Context(), config)
}

describe('buildBasicAuthHeader', () => {
  it('encodes pk:sk as the Basic header Langfuse expects', () => {
    expect(buildBasicAuthHeader('pk', 'sk')).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`)
  })
})

describe('config validation', () => {
  it('defaults to DISABLED and discloses it without reading transport config', () => {
    expect(DEFAULT_TELEMETRY_MODE).toBe(LangfuseTelemetryMode.DISABLED)
    const backend = construct({})
    expect(backend.sharing).toBe('disabled')
    expect(backend.status()).toMatchObject({ state: 'disabled', traces: { state: 'disabled' }, scores: { state: 'disabled' } })
  })

  it('does not inspect Score transport config when the entire plugin is DISABLED', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.DISABLED,
      feedbackScores: {
        enabled: true,
        url: 'not a url',
        maxQueueSize: 0,
        requestTimeoutMillis: 0,
      },
    })).not.toThrow()
  })

  it('requires exporter.url in uploading modes', () => {
    expect(() => construct({ mode: LangfuseTelemetryMode.FULL, auth: AUTH }))
      .toThrow(/exporter\.url is required/)
  })

  it('rejects a malformed exporter.url', () => {
    expect(() => construct({ mode: LangfuseTelemetryMode.FULL, auth: AUTH, exporter: { url: 'not a url' } }))
      .toThrow(/not a valid URL/)
  })

  it('rejects a non-http(s) exporter.url', () => {
    expect(() => construct({ mode: LangfuseTelemetryMode.FULL, auth: AUTH, exporter: { url: 'grpc://cloud.langfuse.com' } }))
      .toThrow(/must be http\(s\)/)
  })

  it('requires credentials in uploading modes', () => {
    expect(() => construct({ mode: LangfuseTelemetryMode.FULL, exporter: { url: URL_OK } }))
      .toThrow(/require auth\.publicKey and auth\.secretKey/)
  })

  it('rejects the ambiguous overlap of auth pair and explicit authorization header', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK, headers: { authorization: 'Basic abc' } },
    })).toThrow(/not both/)
  })

  it('rejects a non-positive processor.maxExportBatchSize before the SDK can hang on it', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      processor: { maxExportBatchSize: 0 },
    })).toThrow(/maxExportBatchSize/)
  })

  it('rejects a non-positive maxAttributeChars', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      maxAttributeChars: 0,
    })).toThrow(/maxAttributeChars/)
  })

  it('rejects a non-positive shutdownTimeoutMillis', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      shutdownTimeoutMillis: 0,
    })).toThrow(/shutdownTimeoutMillis/)
  })

  it('requires a Score URL only when feedback Scores are enabled', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      feedbackScores: { enabled: true },
    })).toThrow(/feedbackScores\.url is required/)
  })

  it.each([
    ['not a url', /not a valid URL/],
    ['grpc://cloud.langfuse.com/api/public/scores', /must be http\(s\)/],
  ])('rejects invalid enabled Score URL %j', (url, expected) => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      feedbackScores: { enabled: true, url },
    })).toThrow(expected)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid Score maxQueueSize %j', (maxQueueSize) => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      feedbackScores: { enabled: true, url: SCORE_URL_OK, maxQueueSize },
    })).toThrow(/feedbackScores\.maxQueueSize/)
  })

  it.each([0, -1, Number.POSITIVE_INFINITY])('rejects invalid Score requestTimeoutMillis %j', (requestTimeoutMillis) => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      feedbackScores: { enabled: true, url: SCORE_URL_OK, requestTimeoutMillis },
    })).toThrow(/feedbackScores\.requestTimeoutMillis/)
  })

  it('rejects an unknown mode smuggled past the schema by direct construction', () => {
    expect(() => construct({ mode: 'EVERYTHING' as LangfuseTelemetryMode }))
      .toThrow(/unsupported mode/)
  })

  it('rejects an empty correlation.userId', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      correlation: { userId: '' },
    })).toThrow(/correlation\.userId/)
  })

  it('rejects a non-string correlation.sessionId', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      correlation: { sessionId: 42 as unknown as string },
    })).toThrow(/correlation\.sessionId/)
  })

  it.each([null, 'host-user', 42, []])('rejects a non-object correlation shape: %j', (correlation) => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      correlation: correlation as unknown as Config['correlation'],
    })).toThrow(/correlation must be an object/)
  })

  it.each([-1, Number.POSITIVE_INFINITY])('rejects invalid health.warningIntervalMillis %j', (warningIntervalMillis) => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.DISABLED,
      health: { warningIntervalMillis },
    })).toThrow(/health\.warningIntervalMillis/)
  })

  it.each([0, 31, 1.5])('rejects invalid health.maxErrorChars %j', (maxErrorChars) => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.DISABLED,
      health: { maxErrorChars },
    })).toThrow(/health\.maxErrorChars/)
  })

  it('rejects unknown content modes and unsafe tool metadata allowlists', () => {
    const base = { mode: LangfuseTelemetryMode.FULL, auth: AUTH, exporter: { url: URL_OK } } as const
    expect(() => construct({ ...base, content: { turnInputMode: 'everything' as never } }))
      .toThrow(/content\.turnInputMode/)
    expect(() => construct({ ...base, content: { cwdMode: 'relative' as never } }))
      .toThrow(/content\.cwdMode/)
    expect(() => construct({ ...base, content: { toolMetaAllowlist: [''] } }))
      .toThrow(/toolMetaAllowlist/)
  })

  it('enforces Langfuse environment and tag bounds', () => {
    const base = { mode: LangfuseTelemetryMode.FULL, auth: AUTH, exporter: { url: URL_OK } } as const
    expect(() => construct({ ...base, metadata: { environment: 'Production' } }))
      .toThrow(/metadata\.environment/)
    expect(() => construct({ ...base, metadata: { environment: 'langfuse-test' } }))
      .toThrow(/metadata\.environment/)
    expect(() => construct({ ...base, metadata: { tags: ['x'.repeat(201)] } }))
      .toThrow(/metadata\.tags/)
  })
})

describe('withDefaultIngestionVersion', () => {
  it('defaults the v4 ingestion header so new spans land on the v4 data model', () => {
    expect(withDefaultIngestionVersion({ authorization: 'Basic abc' }))
      .toEqual({ 'x-langfuse-ingestion-version': '4', authorization: 'Basic abc' })
  })

  it('yields to an explicit entry regardless of casing', () => {
    const explicit = { 'X-Langfuse-Ingestion-Version': '3', authorization: 'Basic abc' }
    expect(withDefaultIngestionVersion(explicit)).toBe(explicit)
  })

  it('wraps a HeadersFactory and defaults the resolved headers', async () => {
    const factory = async () => ({ authorization: 'Basic abc' })
    const wrapped = withDefaultIngestionVersion(factory)
    expect(wrapped).not.toBe(factory)
    expect(typeof wrapped).toBe('function')
    await expect((wrapped as typeof factory)()).resolves.toEqual({
      'x-langfuse-ingestion-version': '4',
      authorization: 'Basic abc',
    })
  })

  it('preserves an explicit ingestion version resolved by a HeadersFactory', async () => {
    const factory = async () => ({
      authorization: 'Basic abc',
      'X-Langfuse-Ingestion-Version': '3',
    })
    const wrapped = withDefaultIngestionVersion(factory)
    await expect((wrapped as typeof factory)()).resolves.toEqual(await factory())
  })
})

describe('service lifecycle', () => {
  it('disposes its service registration with the fiber and mounts again cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    const fiber = await ctx.plugin(LangfuseSessionTelemetryBackend, { mode: LangfuseTelemetryMode.DISABLED })
    expect(ctx.get('sessionTelemetry')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('sessionTelemetry')).toBeUndefined()

    // A leaked registration would throw the seam's duplicate-service error here.
    await ctx.plugin(LangfuseSessionTelemetryBackend, { mode: LangfuseTelemetryMode.DISABLED })
    expect(ctx.get('sessionTelemetry')).toBeDefined()
  })
})
