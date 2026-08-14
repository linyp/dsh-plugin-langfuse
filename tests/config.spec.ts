/**
 * Config fail-loud tier: every acceptance path proves it rejects an invalid
 * case at plugin load, before any SDK transport is constructed, plus the
 * DISABLED short-circuit and the Basic-auth header builder.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildBasicAuthHeader } from '../src/otel.ts'
import {
  DEFAULT_TELEMETRY_MODE,
  LangfuseSessionTelemetryBackend,
  LangfuseTelemetryMode,
  type Config,
} from '../src/index.ts'

const AUTH = { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test' }
const URL_OK = 'https://cloud.langfuse.com/api/public/otel/v1/traces'

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

  it('rejects a non-positive shutdownTimeoutMillis', () => {
    expect(() => construct({
      mode: LangfuseTelemetryMode.FULL,
      auth: AUTH,
      exporter: { url: URL_OK },
      shutdownTimeoutMillis: 0,
    })).toThrow(/shutdownTimeoutMillis/)
  })

  it('rejects an unknown mode smuggled past the schema by direct construction', () => {
    expect(() => construct({ mode: 'EVERYTHING' as LangfuseTelemetryMode }))
      .toThrow(/unsupported mode/)
  })
})
