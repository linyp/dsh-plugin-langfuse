import { describe, expect, it, vi } from 'vitest'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import { LangfuseTelemetryPipeline } from '../src/pipeline.ts'
import type { SessionSpanFolder } from '../src/projection.ts'
import type { FeedbackScoreSink } from '../src/score.ts'

const RECORD = {
  channel: 'ledger',
  time: 1,
  severity: 'info',
  attributes: { 'session.id': 'session', 'event.type': 'feedback/record', 'event.seq': 1 },
  body: { text: 'feedback' },
} satisfies SessionTelemetryRecord

describe('LangfuseTelemetryPipeline', () => {
  it('projects before offering the same record to the Score sink', () => {
    const calls: string[] = []
    const folder = {
      fold: vi.fn(() => calls.push('trace')),
      endAll: vi.fn(),
    } as unknown as SessionSpanFolder
    const scoreSink = {
      accept: vi.fn(() => calls.push('score')),
      shutdown: vi.fn(async () => {}),
    } as unknown as FeedbackScoreSink
    const pipeline = new LangfuseTelemetryPipeline({
      folder,
      scoreSink,
      shutdownTraces: async () => {},
    })

    pipeline.emit(RECORD)

    expect(calls).toEqual(['trace', 'score'])
    expect(folder.fold).toHaveBeenCalledWith(RECORD)
    expect(scoreSink.accept).toHaveBeenCalledWith(RECORD)
  })

  it('still offers the record to Scores before rethrowing a projection error', () => {
    const projectionError = new Error('projection failed')
    const folder = {
      fold: vi.fn(() => { throw projectionError }),
      endAll: vi.fn(),
    } as unknown as SessionSpanFolder
    const scoreSink = {
      accept: vi.fn(),
      shutdown: vi.fn(async () => {}),
    } as unknown as FeedbackScoreSink
    const pipeline = new LangfuseTelemetryPipeline({
      folder,
      scoreSink,
      shutdownTraces: async () => {},
    })

    expect(() => pipeline.emit(RECORD)).toThrow(projectionError)
    expect(scoreSink.accept).toHaveBeenCalledWith(RECORD)
  })

  it('preserves an undefined projection throw after still offering the Score', () => {
    const folder = {
      fold: vi.fn(() => { throw undefined }),
      endAll: vi.fn(),
    } as unknown as SessionSpanFolder
    const scoreSink = {
      accept: vi.fn(),
      shutdown: vi.fn(async () => {}),
    } as unknown as FeedbackScoreSink
    const pipeline = new LangfuseTelemetryPipeline({
      folder,
      scoreSink,
      shutdownTraces: async () => {},
    })

    let didThrow = false
    try {
      pipeline.emit(RECORD)
    } catch {
      didThrow = true
    }
    expect(didThrow).toBe(true)
    expect(scoreSink.accept).toHaveBeenCalledWith(RECORD)
  })

  it('attempts both shutdown channels even when trace shutdown rejects', async () => {
    const traceError = new Error('trace shutdown failed')
    const folder = {
      fold: vi.fn(),
      endAll: vi.fn(),
    } as unknown as SessionSpanFolder
    const scoreSink = {
      accept: vi.fn(),
      shutdown: vi.fn(async () => {}),
    } as unknown as FeedbackScoreSink
    const shutdownTraces = vi.fn(async () => { throw traceError })
    const pipeline = new LangfuseTelemetryPipeline({ folder, scoreSink, shutdownTraces })

    await expect(pipeline.shutdown()).rejects.toBe(traceError)
    expect(folder.endAll).toHaveBeenCalledOnce()
    expect(scoreSink.shutdown).toHaveBeenCalledOnce()
    expect(shutdownTraces).toHaveBeenCalledOnce()
  })

  it('attempts both shutdown channels even when closing open spans throws', async () => {
    const closeError = new Error('span close failed')
    const folder = {
      fold: vi.fn(),
      endAll: vi.fn(() => { throw closeError }),
    } as unknown as SessionSpanFolder
    const scoreSink = {
      accept: vi.fn(),
      shutdown: vi.fn(async () => {}),
    } as unknown as FeedbackScoreSink
    const shutdownTraces = vi.fn(async () => {})
    const pipeline = new LangfuseTelemetryPipeline({ folder, scoreSink, shutdownTraces })

    await expect(pipeline.shutdown()).rejects.toBe(closeError)
    expect(scoreSink.shutdown).toHaveBeenCalledOnce()
    expect(shutdownTraces).toHaveBeenCalledOnce()
  })
})
