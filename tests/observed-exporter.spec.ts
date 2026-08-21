import { describe, expect, it, vi } from 'vitest'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ObservedSpanExporter } from '../src/observed-exporter.ts'

const spans = [{}, {}] as ReadableSpan[]

describe('ObservedSpanExporter', () => {
  it('reports success and delegates shutdown/forceFlush', async () => {
    const shutdown = vi.fn(async () => {})
    const forceFlush = vi.fn(async () => {})
    const delegate: SpanExporter = {
      export: (_spans, callback) => callback({ code: 0 }),
      shutdown,
      forceFlush,
    }
    const observer = vi.fn()
    const callback = vi.fn()
    const exporter = new ObservedSpanExporter(delegate, observer)

    exporter.export(spans, callback)
    await exporter.forceFlush()
    await exporter.shutdown()

    expect(observer).toHaveBeenCalledWith(true, 2, undefined)
    expect(callback).toHaveBeenCalledWith({ code: 0 })
    expect(forceFlush).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('reports delegate failures and suppresses duplicate callbacks', () => {
    const failure = new Error('failed')
    const delegate: SpanExporter = {
      export: (_spans, callback) => {
        callback({ code: 1, error: failure })
        callback({ code: 0 })
      },
      shutdown: async () => {},
    }
    const observer = vi.fn()
    const callback = vi.fn()
    new ObservedSpanExporter(delegate, observer).export(spans, callback)

    expect(observer).toHaveBeenCalledOnce()
    expect(observer).toHaveBeenCalledWith(false, 2, failure)
    expect(callback).toHaveBeenCalledOnce()
  })

  it('converts synchronous delegate throws into a failed callback', () => {
    const delegate: SpanExporter = {
      export: () => { throw 'socket failed' },
      shutdown: async () => {},
    }
    const observer = vi.fn()
    const callback = vi.fn()
    new ObservedSpanExporter(delegate, observer).export(spans, callback)

    expect(observer).toHaveBeenCalledWith(false, 2, expect.objectContaining({ message: 'socket failed' }))
    expect(callback).toHaveBeenCalledWith({ code: 1, error: expect.objectContaining({ message: 'socket failed' }) })
  })

  it('tolerates diagnostics failures and an absent forceFlush', async () => {
    const callback = vi.fn()
    const delegate: SpanExporter = {
      export: (_spans, complete) => complete({ code: 0 }),
      shutdown: async () => {},
    }
    const exporter = new ObservedSpanExporter(delegate, () => { throw new Error('diagnostics failed') })
    expect(() => exporter.export(spans, callback)).not.toThrow()
    await expect(exporter.forceFlush()).resolves.toBeUndefined()
    expect(callback).toHaveBeenCalledOnce()
  })
})
