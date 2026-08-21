import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { TelemetryHealthTracker } from '../src/health.ts'
import { buildTracerPipeline } from '../src/otel.ts'

describe('real OTLP export health', () => {
  it('reports a real HTTP failure and recovers after the next successful batch', async () => {
    let acceptExports = false
    let failedResponses = 0
    let successfulResponses = 0
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        if (acceptExports) {
          successfulResponses += 1
          response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        } else {
          failedResponses += 1
          response.writeHead(503, { 'content-type': 'application/json' })
            .end('{"error":"synthetic unavailable"}')
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('health collector has no port')

    const warning = vi.fn()
    const info = vi.fn()
    const tracker = new TelemetryHealthTracker({
      enabled: true,
      scoresEnabled: false,
      warningIntervalMillis: 0,
      onWarning: warning,
      onInfo: info,
    })
    const pipeline = buildTracerPipeline({
      exporter: { url: `http://127.0.0.1:${address.port}/api/public/otel/v1/traces` },
      processor: { scheduledDelayMillis: 60_000 },
      resourceAttributes: { 'service.name': 'dsh-plugin-langfuse-health-e2e' },
      scopeName: 'dsh-plugin-langfuse-health-e2e',
      scopeVersion: '0.5.0',
      onExportResult: (success, spanCount, error) => tracker.observeTraceExport(success, spanCount, error),
    })

    try {
      pipeline.tracer.startSpan('failed export').end()
      await expect(pipeline.provider.forceFlush()).rejects.toThrow()
      expect(failedResponses).toBeGreaterThan(0)
      expect(tracker.status()).toMatchObject({
        state: 'degraded',
        traces: {
          state: 'degraded',
          failedBatches: 1,
          failedSpans: 1,
          consecutiveFailures: 1,
          lastFailureAt: expect.any(Number),
          lastError: { message: expect.any(String) },
        },
      })
      expect(warning).toHaveBeenCalledOnce()

      acceptExports = true
      pipeline.tracer.startSpan('recovered export').end()
      await expect(pipeline.provider.forceFlush()).resolves.toBeUndefined()
      expect(successfulResponses).toBeGreaterThan(0)
      expect(tracker.status()).toMatchObject({
        state: 'healthy',
        traces: {
          state: 'healthy',
          successfulBatches: 1,
          successfulSpans: 1,
          failedBatches: 1,
          failedSpans: 1,
          consecutiveFailures: 0,
          lastSuccessAt: expect.any(Number),
        },
      })
      expect(info).toHaveBeenCalledOnce()
      expect(info.mock.calls[0]?.[0]).toContain('recovered')
    } finally {
      await pipeline.provider.shutdown().catch(() => {})
      server.close()
      server.closeAllConnections()
    }
  })
})
