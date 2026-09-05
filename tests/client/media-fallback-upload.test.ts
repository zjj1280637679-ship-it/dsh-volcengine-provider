import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  createLoopbackVideoOperations, type LoopbackVideoServices,
} from '../../src/client/media-fallback-upload.js'
import type { MediaDirectoryState } from '../../src/client/media-operations.js'

function setup() {
  let generation = 0
  let state: MediaDirectoryState = {
    current: { provider: 'volcengine-coding-plan', model: 'doubao-seed-2.0-lite' }, routable: true,
  }
  const selectionListeners = new Set<() => void>()
  const generationListeners = new Set<() => void>()
  const rpc = vi.fn<LoopbackVideoServices['connection']['rpc']['call']>(async (_channel, endpoint) => {
    if (endpoint === 'capabilities') return { ok: true, value: { version: 2, chunkBytes: 4 } }
    if (endpoint === 'begin') return { ok: true, value: { token: 'a'.repeat(64) } }
    if (endpoint === 'append') return { ok: true, value: { appended: true } }
    if (endpoint === 'commit') return { ok: true, value: { token: 'a'.repeat(64), sha256: lastSha } }
    if (endpoint === 'discard') return { ok: true, value: { discarded: true } }
    return { ok: false, error: { message: 'unknown endpoint' } }
  })
  let lastSha = ''
  const services: LoopbackVideoServices = {
    connection: { isLoopback: true, rpc: { call: rpc } },
    commands: {
      list: vi.fn<LoopbackVideoServices['commands']['list']>(async () => ({ ok: true, value: [{ name: 'ark-media-local' }] })),
      execute: vi.fn<LoopbackVideoServices['commands']['execute']>(async () => ({ ok: true, value: { result: { kind: 'success' } } })),
    },
    directory: {
      store: {
        getSnapshot: () => state,
        subscribe: listener => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } },
      },
      load: vi.fn(async () => {}),
    },
    canAddress: () => true,
    generation: {
      getSnapshot: () => generation,
      subscribe: listener => { generationListeners.add(listener); return () => { generationListeners.delete(listener) } },
    },
  }
  return {
    services,
    rpc,
    operations: createLoopbackVideoOperations('session-seed', services),
    setSha(value: string) { lastSha = value },
    select(model: string) {
      state = { ...state, current: { provider: 'volcengine-coding-plan', model } }
      for (const listener of selectionListeners) listener()
    },
    reset() { generation += 1; for (const listener of generationListeners) listener() },
  }
}

describe('loopback original MP4 client path', () => {
  it('streams canonical original chunks, receives the server SHA-256, executes once without attachments, then discards', async () => {
    const fixture = setup()
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    fixture.setSha(sha256)
    const file = new File([bytes], 'chosen-from-desktop.mp4', { type: 'application/octet-stream' })
    const progress = vi.fn()
    await fixture.operations.send([{ file, mediaType: 'video/mp4' }], 'Describe motion in temporal order.', new AbortController().signal, progress)

    const begin = fixture.rpc.mock.calls.find(call => call[1] === 'begin')!
    expect(begin[0]).toBe('/volcengine-media')
    expect(begin[2]).toMatchObject({
      sessionId: 'session-seed', name: 'chosen-from-desktop.mp4', mediaType: 'video/mp4',
      bytes: bytes.byteLength, prompt: 'Describe motion in temporal order.',
      clientSubmissionId: expect.any(String),
      expectedProvider: 'volcengine-coding-plan', expectedModel: 'doubao-seed-2.0-lite',
    })
    expect(begin[2]).not.toHaveProperty('data')
    expect(begin[2]).not.toHaveProperty('sha256')
    const appends = fixture.rpc.mock.calls.filter(call => call[1] === 'append')
    expect(appends.map(call => call[2])).toEqual([0, 4, 8].map(offset => ({
      sessionId: 'session-seed', token: 'a'.repeat(64), offset,
      data: Buffer.from(bytes.subarray(offset, offset + 4)).toString('base64'),
    })))
    expect(fixture.rpc.mock.calls.some(call => call[1] === 'commit')).toBe(true)
    expect(fixture.services.commands.execute).toHaveBeenCalledWith(
      'session-seed', `/ark-media-local ${'a'.repeat(64)}`, [], expect.any(AbortSignal),
    )
    expect(fixture.rpc.mock.calls.at(-1)?.[1]).toBe('discard')
    expect(progress).toHaveBeenLastCalledWith({ name: 'chosen-from-desktop.mp4', loaded: bytes.byteLength, total: bytes.byteLength })
  })

  it('rejects anything except one explicit non-empty video/mp4 but adds no plugin file-size ceiling', async () => {
    const fixture = setup()
    const small = new File([new Uint8Array([1])], 'opaque.bin')
    expect(() => fixture.operations.validate!([], '')).toThrow(/exactly one/)
    expect(() => fixture.operations.validate!([
      { file: small, mediaType: 'video/mp4' }, { file: small, mediaType: 'video/mp4' },
    ], '')).toThrow(/exactly one/)
    expect(() => fixture.operations.validate!([{ file: small, mediaType: 'video/webm' }], '')).toThrow(/video\/mp4/)
    expect(() => fixture.operations.validate!([{ file: new File([], 'empty.mp4'), mediaType: 'video/mp4' }], '')).toThrow(/1 byte/)
    const aboveOldCeiling = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.mp4')
    expect(() => fixture.operations.validate!([{ file: aboveOldCeiling, mediaType: 'video/mp4' }], '')).not.toThrow()
    expect(fixture.rpc).not.toHaveBeenCalled()
  })

  it('does not execute if the selection changes after staging, and still discards the token', async () => {
    const fixture = setup()
    const bytes = new Uint8Array([1, 2, 3])
    fixture.setSha(createHash('sha256').update(bytes).digest('hex'))
    fixture.rpc.mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'capabilities') return { ok: true, value: { version: 2, chunkBytes: 4 } }
      if (endpoint === 'begin') return { ok: true, value: { token: 'b'.repeat(64) } }
      if (endpoint === 'append') {
        fixture.select('different-model')
        return { ok: true, value: { appended: true } }
      }
      if (endpoint === 'commit') return { ok: true, value: { token: 'b'.repeat(64), sha256: createHash('sha256').update(bytes).digest('hex') } }
      return { ok: true, value: { discarded: true } }
    })
    await expect(fixture.operations.send(
      [{ file: new File([bytes], 'clip.mp4'), mediaType: 'video/mp4' }], '', new AbortController().signal, () => {},
    )).rejects.toThrow(/model changed/i)
    expect(fixture.services.commands.execute).not.toHaveBeenCalled()
    expect(fixture.rpc.mock.calls.at(-1)?.[1]).toBe('discard')
  })

  it('never retries an ambiguous command delivery', async () => {
    const fixture = setup()
    const bytes = new Uint8Array([4, 5, 6])
    fixture.setSha(createHash('sha256').update(bytes).digest('hex'))
    vi.mocked(fixture.services.commands.execute).mockRejectedValueOnce(new Error('connection lost'))
    await expect(fixture.operations.send(
      [{ file: new File([bytes], 'clip.mp4'), mediaType: 'video/mp4' }], '', new AbortController().signal, () => {},
    )).rejects.toThrow(/unknown/)
    expect(fixture.services.commands.execute).toHaveBeenCalledOnce()
  })

  it('does not keep send or cancellation busy while best-effort discard is stalled', async () => {
    const fixture = setup()
    const bytes = new Uint8Array([7, 8, 9])
    fixture.setSha(createHash('sha256').update(bytes).digest('hex'))
    fixture.rpc.mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'capabilities') return { ok: true, value: { version: 2, chunkBytes: 4 } }
      if (endpoint === 'begin') return { ok: true, value: { token: 'c'.repeat(64) } }
      if (endpoint === 'append') return { ok: true, value: { appended: true } }
      if (endpoint === 'commit') {
        return { ok: true, value: { token: 'c'.repeat(64), sha256: createHash('sha256').update(bytes).digest('hex') } }
      }
      if (endpoint === 'discard') return new Promise(() => {})
      return { ok: false, error: { message: 'unknown endpoint' } }
    })
    await expect(fixture.operations.send(
      [{ file: new File([bytes], 'clip.mp4'), mediaType: 'video/mp4' }], '', new AbortController().signal, () => {},
    )).resolves.toBeUndefined()
    expect(fixture.rpc.mock.calls.at(-1)?.[1]).toBe('discard')
  })
})
