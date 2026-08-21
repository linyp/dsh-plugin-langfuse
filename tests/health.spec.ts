import { describe, expect, it, vi } from 'vitest'
import {
  TelemetryHealthTracker,
  sanitizeTelemetryError,
} from '../src/health.ts'

describe('TelemetryHealthTracker', () => {
  it('reports disabled without constructing transport state', () => {
    const tracker = new TelemetryHealthTracker({ enabled: false, scoresEnabled: false, now: () => 10 })
    expect(tracker.status()).toEqual({
      state: 'disabled',
      observedAt: 10,
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
    })
  })

  it('transitions trace health through failure, rate-limited warning, and recovery', () => {
    let now = 1_000
    const warning = vi.fn()
    const info = vi.fn()
    const tracker = new TelemetryHealthTracker({
      enabled: true,
      scoresEnabled: false,
      warningIntervalMillis: 100,
      onWarning: warning,
      onInfo: info,
      now: () => now,
    })

    expect(tracker.status().state).toBe('starting')
    tracker.observeTraceExport(false, 3, Object.assign(new Error('HTTP 500'), { code: 'ECONNRESET' }))
    expect(tracker.status()).toMatchObject({
      state: 'degraded',
      traces: {
        failedBatches: 1,
        failedSpans: 3,
        consecutiveFailures: 1,
        lastFailureAt: 1_000,
        lastError: { name: 'Error', code: 'ECONNRESET', message: 'HTTP 500' },
      },
    })
    tracker.observeTraceExport(false, 2, new Error('HTTP 500 again'))
    expect(warning).toHaveBeenCalledOnce()

    now = 1_101
    tracker.observeTraceExport(false, 1, new Error('HTTP 500 later'))
    expect(warning).toHaveBeenCalledTimes(2)
    tracker.observeTraceExport(true, 4)

    expect(tracker.status()).toMatchObject({
      state: 'healthy',
      traces: {
        successfulBatches: 1,
        failedBatches: 3,
        successfulSpans: 4,
        failedSpans: 6,
        consecutiveFailures: 0,
        lastSuccessAt: 1_101,
      },
    })
    expect(info).toHaveBeenCalledOnce()
    expect(info.mock.calls[0]?.[0]).toContain('101ms outage')
  })

  it('suppresses repeated warnings when the warning interval is zero', () => {
    const warning = vi.fn()
    const tracker = new TelemetryHealthTracker({
      enabled: true,
      scoresEnabled: false,
      warningIntervalMillis: 0,
      onWarning: warning,
    })
    tracker.observeTraceExport(false, 1, new Error('first'))
    tracker.observeTraceExport(false, 1, new Error('second'))
    expect(warning).toHaveBeenCalledOnce()
  })

  it('summarizes Score queue outcomes independently and recovers on delivery', () => {
    let now = 5
    const tracker = new TelemetryHealthTracker({ enabled: true, scoresEnabled: true, now: () => now })
    tracker.observeScore({ kind: 'queued' })
    tracker.observeScore({ kind: 'dropped', error: new Error('queue full') })
    expect(tracker.status()).toMatchObject({
      state: 'degraded',
      scores: { state: 'degraded', queued: 1, dropped: 1, lastFailureAt: 5 },
    })

    now = 6
    tracker.observeScore({ kind: 'delivered' })
    expect(tracker.status()).toMatchObject({
      state: 'starting',
      scores: { state: 'healthy', queued: 0, delivered: 1, dropped: 1, lastSuccessAt: 6 },
    })
    tracker.observeTraceExport(true, 1)
    expect(tracker.status().state).toBe('healthy')
    tracker.markStopped()
    expect(tracker.status()).toMatchObject({ state: 'stopped', traces: { state: 'stopped' }, scores: { state: 'stopped' } })
  })

  it('returns detached error snapshots', () => {
    const tracker = new TelemetryHealthTracker({ enabled: true, scoresEnabled: false })
    tracker.observeTraceExport(false, 1, new Error('failed'))
    const first = tracker.status()
    const second = tracker.status()
    expect(first).not.toBe(second)
    expect(first.traces).not.toBe(second.traces)
    expect(first.traces.lastError).not.toBe(second.traces.lastError)
  })
})

describe('sanitizeTelemetryError', () => {
  it('redacts credentials, URL userinfo, and clips messages', () => {
    const error = Object.assign(new Error(
      'authorization=Basic abc123 https://pk-lf-public:sk-lf-secret@example.test/path secretKey=top-secret trailing-data',
    ), { name: 'sk-lf-name', code: 'pk-lf-code' })
    const sanitized = sanitizeTelemetryError(error, 90)
    expect(sanitized.name).toBe('[redacted-key]')
    expect(sanitized.code).toBe('[redacted-key]')
    expect(sanitized.message).not.toContain('abc123')
    expect(sanitized.message).not.toContain('pk-lf-public')
    expect(sanitized.message).not.toContain('sk-lf-secret')
    expect(sanitized.message).not.toContain('top-secret')
    expect(sanitized.message.length).toBeLessThanOrEqual(90)
  })
})
