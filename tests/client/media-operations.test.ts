import { describe, expect, it, vi } from 'vitest'
import { createMediaOperations, mediaCommandLine } from '../../src/client/media-operations.js'
import type { MediaDirectoryState, MediaServices } from '../../src/client/media-operations.js'

function setup() {
  let generation = 0
  let state: MediaDirectoryState = { current: { provider: 'volcengine-user-route', model: 'unlisted-model' }, routable: true }
  const selectionListeners = new Set<() => void>()
  const generationListeners = new Set<() => void>()
  const services: MediaServices = {
    upload: { available: true, upload: vi.fn<MediaServices['upload']['upload']>(async (_session, file) => ({ ok: true, value: { receiptId: `receipt-${file.size}` } })) },
    commands: {
      list: vi.fn<MediaServices['commands']['list']>(async () => ({ ok: true, value: [{ name: 'ark-media', input: { attachments: true } }] })),
      execute: vi.fn<MediaServices['commands']['execute']>(async () => ({ ok: true, value: { result: { kind: 'success' } } })),
    },
    directory: { store: {
      getSnapshot: () => state,
      subscribe: listener => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } },
    }, load: vi.fn(async () => {}) },
    canAddress: () => true,
    generation: {
      getSnapshot: () => generation,
      subscribe: listener => { generationListeners.add(listener); return () => { generationListeners.delete(listener) } },
    },
  }
  return { services, operations: createMediaOperations('session-a', services), reset: () => {
    generation += 1
    for (const listener of [...generationListeners]) listener()
  }, select: (provider: string, model = 'new-model') => {
    state = { ...state, current: { provider, model } }
    for (const listener of [...selectionListeners]) listener()
  } }
}
const drafts = () => [
  { file: new File([new Uint8Array([137, 80, 78, 71])], 'do-not-decode.png', { type: 'image/png' }), mediaType: 'image/png' },
  { file: new File([new Uint8Array([0, 255, 0, 255, 42])], 'not-a-format.wav'), mediaType: 'audio/x-vendor', format: 'vendor_format' },
]

describe('original media public-service bridge', () => {
  it('uploads exact File objects in order and delivers explicit declarations to an unlisted model on an owned route', async () => {
    const fixture = setup()
    const files = drafts()
    const signal = new AbortController().signal
    await fixture.operations.send(files, 'Question -- still plain text', signal, () => {})
    // Generated Remotes enforce arity; only execute declares a cancellation parameter.
    expect(fixture.services.commands.list).toHaveBeenCalledWith('session-a')
    const calls = vi.mocked(fixture.services.upload.upload).mock.calls
    expect(calls.map(call => call[1])).toEqual(files.map(item => item.file))
    expect(calls[0]![1]).toBe(files[0]!.file)
    expect(new Uint8Array(await calls[1]![1].arrayBuffer())).toEqual(new Uint8Array([0, 255, 0, 255, 42]))
    expect(fixture.services.commands.execute).toHaveBeenCalledWith('session-a',
      '/ark-media image/png,audio/x-vendor=vendor_format -- Question -- still plain text',
      [{ type: 'file', receiptId: 'receipt-4' }, { type: 'file', receiptId: 'receipt-5' }],
      expect.any(AbortSignal))
  })

  it('keeps completed receipts across a later upload failure and command rejection', async () => {
    const fixture = setup()
    const files = drafts()
    const upload = vi.mocked(fixture.services.upload.upload)
    upload.mockResolvedValueOnce({ ok: true, value: { receiptId: 'first' } })
      .mockResolvedValueOnce({ ok: false, error: { message: 'upload refused' } })
    const send = () => fixture.operations.send(files, '', new AbortController().signal, () => {})
    await expect(send()).rejects.toThrow('upload refused')
    expect(fixture.services.commands.execute).not.toHaveBeenCalled()
    vi.mocked(fixture.services.commands.execute).mockResolvedValueOnce({ ok: true, value: { result: { kind: 'error', text: 'disabled modality' } } })
    await expect(send()).rejects.toThrow('disabled modality')
    expect(upload).toHaveBeenCalledTimes(3)
    await send()
    expect(upload).toHaveBeenCalledTimes(3)
    expect(fixture.services.commands.execute).toHaveBeenCalledTimes(2)
  })

  it('does not execute after cancellation during upload and reuses the completed receipt on deliberate retry', async () => {
    const fixture = setup()
    const controller = new AbortController()
    const files = drafts().slice(0, 1)
    vi.mocked(fixture.services.upload.upload).mockImplementationOnce(async () => {
      controller.abort()
      return { ok: true, value: { receiptId: 'complete-before-cancel' } }
    })
    await expect(fixture.operations.send(files, '', controller.signal, () => {})).rejects.toThrow()
    expect(fixture.services.commands.execute).not.toHaveBeenCalled()
    await fixture.operations.send(files, '', new AbortController().signal, () => {})
    expect(fixture.services.upload.upload).toHaveBeenCalledOnce()
  })

  it('refuses a model change during upload and invalidates receipts on connection reset', async () => {
    const fixture = setup()
    const files = drafts().slice(0, 1)
    vi.mocked(fixture.services.upload.upload).mockImplementationOnce(async () => {
      fixture.select('volcengine-user-route')
      return { ok: true, value: { receiptId: 'old-generation' } }
    })
    const send = () => fixture.operations.send(files, '', new AbortController().signal, () => {})
    await expect(send()).rejects.toThrow('模型已切换')
    expect(fixture.services.commands.execute).not.toHaveBeenCalled()
    fixture.reset()
    await send()
    expect(fixture.services.upload.upload).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fixture.services.commands.execute).mock.calls[0]![2]).toEqual([{ type: 'file', receiptId: 'receipt-4' }])
  })

  it('reports an unknown submission state when the selected model changes during command execution', async () => {
    const fixture = setup()
    let started!: () => void
    const executing = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    let delivered = false
    let executeSignal: AbortSignal | undefined
    vi.mocked(fixture.services.commands.execute).mockImplementationOnce(async (_session, _line, _attachments, signal) => {
      executeSignal = signal
      started()
      await new Promise<void>((resolve, reject) => {
        release = resolve
        const abort = (): void => { reject(signal?.reason) }
        if (signal?.aborted === true) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
      delivered = true
      return { ok: true, value: { result: { kind: 'success' } } }
    })
    const sending = fixture.operations.send(drafts().slice(0, 1), '', new AbortController().signal, () => {})
    await executing
    fixture.select('volcengine-user-route', 'switched-model')
    await expect(sending).rejects.toThrow('提交状态未确认')
    release()
    expect(executeSignal?.aborted).toBe(true)
    expect(delivered).toBe(false)
    expect(fixture.services.commands.execute).toHaveBeenCalledOnce()
  })

  it('accepts an authoritative success returned after a model switch during command execution', async () => {
    const fixture = setup()
    let started!: () => void
    const executing = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    let executeSignal: AbortSignal | undefined
    vi.mocked(fixture.services.commands.execute).mockImplementationOnce(async (_session, _line, _attachments, signal) => {
      executeSignal = signal
      started()
      await new Promise<void>(resolve => { release = resolve })
      return { ok: true, value: { result: { kind: 'success' } } }
    })
    const sending = fixture.operations.send(drafts().slice(0, 1), '', new AbortController().signal, () => {})
    await executing
    fixture.select('volcengine-user-route', 'switched-model')
    release()
    await expect(sending).resolves.toBeUndefined()
    expect(executeSignal?.aborted).toBe(true)
    expect(fixture.services.commands.execute).toHaveBeenCalledOnce()
  })

  it('reports an unknown submission state for an error envelope returned after cancellation', async () => {
    const fixture = setup()
    let started!: () => void
    const executing = new Promise<void>(resolve => { started = resolve })
    vi.mocked(fixture.services.commands.execute).mockImplementationOnce(async (_session, _line, _attachments, signal) => {
      started()
      return await new Promise(resolve => {
        const cancelled = (): void => resolve({ ok: false, error: { message: 'RPC response was cancelled' } })
        if (signal?.aborted === true) cancelled()
        else signal?.addEventListener('abort', cancelled, { once: true })
      })
    })
    const sending = fixture.operations.send(drafts().slice(0, 1), '', new AbortController().signal, () => {})
    await executing
    fixture.select('volcengine-user-route', 'switched-model')
    await expect(sending).rejects.toThrow('提交状态未确认')
    expect(fixture.services.commands.execute).toHaveBeenCalledOnce()
  })

  it('makes no upload or execution for invalid declarations or a non-owned provider; subagents make no directory RPC', async () => {
    const fixture = setup()
    const signal = new AbortController().signal
    await expect(fixture.operations.send([{ ...drafts()[0]!, mediaType: 'image/png,video/mp4' }], '', signal, () => {})).rejects.toThrow('Invalid media')
    expect(fixture.services.directory.load).not.toHaveBeenCalled()
    fixture.select('someone-else')
    await expect(fixture.operations.send(drafts(), '', signal, () => {})).rejects.toThrow('火山方舟')
    expect(fixture.services.upload.upload).not.toHaveBeenCalled()
    expect(fixture.services.commands.execute).not.toHaveBeenCalled()
    vi.mocked(fixture.services.commands.list).mockClear()
    fixture.services.canAddress = () => false
    await expect(fixture.operations.check()).rejects.toThrow('当前会话')
    expect(fixture.services.commands.list).not.toHaveBeenCalled()
    expect(() => mediaCommandLine([{ ...drafts()[0]!, format: 'mp3' }], '')).toThrow('only for audio')
  })

  it('reports ambiguous command delivery without automatic retry', async () => {
    const fixture = setup()
    vi.mocked(fixture.services.commands.execute).mockRejectedValueOnce(new Error('connection lost'))
    await expect(fixture.operations.send(drafts(), '', new AbortController().signal, () => {})).rejects.toThrow('提交状态未确认')
    expect(fixture.services.commands.execute).toHaveBeenCalledOnce()
  })
})
