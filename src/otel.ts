/**
 * OTel traces pipeline wiring: a `BasicTracerProvider` with a
 * `BatchSpanProcessor` and the OTLP/HTTP trace exporter, composed verbatim
 * from config. Batching, retry, queueing, and loss policy are the SDK's
 * documented behavior; this module only assembles the pipeline and builds
 * Langfuse's Basic-auth header.
 *
 * @module dsh-plugin-langfuse/otel
 */

import { Buffer } from 'node:buffer'
import type { Tracer } from '@opentelemetry/api'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, BatchSpanProcessor, type BufferConfig } from '@opentelemetry/sdk-trace-base'
import { ObservedSpanExporter, type SpanExportObserver } from './observed-exporter.ts'

/**
 * Build Langfuse's `Authorization` header value from a project key pair.
 * @param publicKey - the Langfuse project public key (`pk-lf-…`).
 * @param secretKey - the Langfuse project secret key (`sk-lf-…`).
 * @returns the `Basic <base64(pk:sk)>` header value Langfuse's OTLP endpoint expects.
 */
export function buildBasicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
}

/** The constructed SDK pipeline: the provider owns shutdown, the tracer creates spans. */
export interface TracerPipeline {
  provider: BasicTracerProvider
  tracer: Tracer
}

/**
 * Assemble the export pipeline. The complete validated `exporter` object is
 * passed verbatim so every SDK option (`headers`, `timeoutMillis`,
 * `compression`, `keepAlive`, …) reaches the exporter.
 * @param options - exporter/processor SDK passthroughs plus resource identity and instrumentation scope.
 * @returns the provider (for shutdown) and its tracer (for span creation).
 */
export function buildTracerPipeline(options: {
  exporter: OTLPExporterNodeConfigBase & { url: string }
  processor?: BufferConfig
  resourceAttributes: Record<string, string>
  scopeName: string
  scopeVersion: string
  onExportResult?: SpanExportObserver
}): TracerPipeline {
  const exporter = new OTLPTraceExporter(options.exporter)
  const observedExporter = options.onExportResult === undefined
    ? exporter
    : new ObservedSpanExporter(exporter, options.onExportResult)
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(options.resourceAttributes),
    spanProcessors: [
      new BatchSpanProcessor(observedExporter, options.processor),
    ],
  })
  return { provider, tracer: provider.getTracer(options.scopeName, options.scopeVersion) }
}
