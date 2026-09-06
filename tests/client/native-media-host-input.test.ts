import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NativeMediaDraftBridge,
  NATIVE_MEDIA_REFERENCE_SOURCE,
  type NativeMediaClientServices,
} from '../../src/client/native-media-upload.js'
import { formatNativeMediaMarker } from '../../src/native-media-marker.js'
import { createHostInput } from '../support/host-input.js'

const SESSION = 'session-a'
const FIRST = '1'.repeat(32)
const SECOND = '2'.repeat(32)
const selection = { provider: 'volcengine-coding-plan', model: 'doubao-seed-2.0-lite' }
const question = '请保留完整问题。 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 然后比较两个附件。'

function summary(bundleId: string) {
  return { bundleId, label: 'clip.mp4', state: 'ready', expectedProvider: selection.provider, expectedModel: selection.model }
}

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose() })

function fixture(initial: string, ready = new Map<string, ReturnType<typeof summary>>()) {
  let source!: NativeMediaDraftBridge['source']
  const sent: { text: string; mode: 'queue' | 'steer' }[] = []
  const shell = createHostInput({
    defaultSink: async (text, _attachments, mode) => { sent.push({ text, mode }); return { kind: 'success' } },
    serialize: (_owner, ref, signal) => source.codec.serialize(ref, signal),
    adjudicate: (line, signal) => source.matchEnter({ sessionId: SESSION }, line, signal, { images: 0 }),
  })
  shell.setDraft(initial)
  const rpc = vi.fn<NativeMediaClientServices['connection']['rpc']['call']>(async (_channel, endpoint, payload) => {
    const request = payload as { bundleId: string; files: readonly unknown[]; offset: number; data: string }
    if (endpoint === 'native-capabilities') return { ok: true, value: { version: 3, nativeDrafts: true, chunkBytes: 2 } }
    if (endpoint === 'native-begin') return { ok: true, value: {
      bundleId: request.bundleId,
      files: request.files.map((_, index) => ({ fileId: String(index + 1).padStart(32, '0') })),
    } }
    if (endpoint === 'native-append') return { ok: true, value: { receivedBytes: request.offset + atob(request.data).length } }
    if (endpoint === 'native-commit') {
      ready.set(request.bundleId, summary(request.bundleId))
      return { ok: true, value: ready.get(request.bundleId) }
    }
    if (endpoint === 'native-status') return ready.has(request.bundleId)
      ? { ok: true, value: ready.get(request.bundleId) }
      : { ok: false, error: { message: 'Bundle unavailable.' } }
    if (endpoint === 'native-list') return { ok: true, value: { bundles: [...ready.values()] } }
    if (endpoint === 'native-discard') return { ok: true, value: { discarded: ready.delete(request.bundleId) } }
    return { ok: false, error: { message: `Unexpected endpoint: ${endpoint}` } }
  })
  const services: NativeMediaClientServices = {
    connection: { isLoopback: true, rpc: { call: rpc } },
    directories: { directoryFor: () => ({
      load: async () => {},
      store: { getSnapshot: () => ({ current: selection, routable: true }), subscribe: () => () => {} },
    }) },
    sessions: { scope: () => ({}), subagentAddress: () => undefined },
    conversation: { input: { for: () => shell } },
    inputTriggers: { registerSource(registered) { source = registered; return () => {} } },
    generation: { getSnapshot: () => 0, subscribe: () => () => {} },
  }
  const bridge = new NativeMediaDraftBridge(services)
  bridge.register()
  const dispose = (): void => { bridge.dispose(); shell.dispose() }
  disposers.push(dispose)
  return { shell, bridge, source, ready, rpc, sent, dispose }
}

describe('native media with the installed Harness composer', () => {
  it('keeps individual original file metadata inside one native attachment group', async () => {
    const current = fixture(question)
    const files = [
      new File([new Uint8Array([0, 1, 255])], 'photo.png', { type: 'image/png' }),
      new File([new Uint8Array([2, 3, 254, 255])], 'clip.mp4', { type: 'video/mp4' }),
    ]
    const operations = current.bridge.operations(SESSION)
    await operations.addFiles(files)
    await vi.waitFor(() => expect(operations.state.getSnapshot().uploads).toBe(0))
    expect(current.shell.state.getSnapshot().occurrences).toHaveLength(1)
    expect(current.shell.state.getSnapshot().draft.endsWith(question)).toBe(true)
    expect(operations.state.getSnapshot().bundles).toMatchObject([{
      label: 'photo.png +1', state: 'ready', files: [
        { name: 'photo.png', modality: 'image', mediaType: 'image/png', bytes: 3, uploadedBytes: 3 },
        { name: 'clip.mp4', modality: 'video', mediaType: 'video/mp4', bytes: 4, uploadedBytes: 4 },
      ],
    }])
    const chunks = current.rpc.mock.calls.filter(call => call[1] === 'native-append')
      .map(call => call[2] as { fileId: string; data: string })
    const uploaded = [...new Set(chunks.map(chunk => chunk.fileId))].map(fileId => chunks
      .filter(chunk => chunk.fileId === fileId).flatMap(chunk => [...atob(chunk.data)].map(char => char.charCodeAt(0))))
    expect(uploaded).toEqual([[0, 1, 255], [2, 3, 254, 255]])
  })

  it.each(['queue', 'steer'] as const)('preserves two separately added bundles and all text through refresh and %s', async mode => {
    const first = fixture(question)
    for (const name of ['first.mp4', 'second.mp4']) {
      await first.bridge.operations(SESSION).addFiles([new File(['original bytes'], name, { type: 'video/mp4' })])
      await vi.waitFor(() => expect(first.bridge.operations(SESSION).state.getSnapshot().uploads).toBe(0))
    }
    const before = first.shell.state.getSnapshot()
    expect(before.occurrences).toHaveLength(2)
    expect(first.ready.size).toBe(2)
    first.dispose()

    const resumed = fixture(before.draft, first.ready)
    resumed.source.warm({ sessionId: SESSION })
    await vi.waitFor(() => expect(resumed.shell.state.getSnapshot().occurrences).toHaveLength(2))
    const restored = resumed.shell.state.getSnapshot()
    expect(restored.draft).toBe(before.draft)
    expect(restored.draft.endsWith(question)).toBe(true)
    expect(restored.occurrences.map(row => [row.source, row.ref, row.offset, row.length]))
      .toEqual(before.occurrences.map(row => [row.source, row.ref, row.offset, row.length]))

    resumed.shell.submit(mode)
    await vi.waitFor(() => expect(resumed.sent).toEqual([{ text: before.draft.trim(), mode }]))
    expect(resumed.shell.state.getSnapshot().draft).toBe('')
    expect(resumed.bridge.operations(SESSION).state.getSnapshot().bundles).toHaveLength(0)
    expect(resumed.rpc.mock.calls.filter(call => call[1] === 'native-discard')).toHaveLength(0)
  })

  it.each([
    ['ordinary reference', '@[Document](dsh-resource:document)'],
    ['reference whose clipboard text contains an Ark marker', formatNativeMediaMarker(FIRST)],
  ])('preserves another source’s %s while restoring remaining markers', async (_case, clipboardText) => {
    const ready = new Map([FIRST, SECOND].map(id => [id, summary(id)]))
    const current = fixture(`@document ${formatNativeMediaMarker(FIRST)} ${formatNativeMediaMarker(SECOND)} ${question}`, ready)
    expect(current.shell.insertReference({
      source: 'document-source', ref: 'document', label: 'Document', clipboardText: clipboardText!, appearance: 'file',
    }, { start: 0, end: '@document'.length, draftRev: current.shell.state.getSnapshot().draftRev })).toBe(true)
    const before = current.shell.state.getSnapshot().draft
    current.source.warm({ sessionId: SESSION })
    await vi.waitFor(() => expect(current.shell.state.getSnapshot().occurrences).toHaveLength(3))
    const after = current.shell.state.getSnapshot()
    expect(after.draft).toBe(before)
    expect(after.occurrences.map(row => [row.source, row.ref])).toEqual([
      ['document-source', 'document'], [NATIVE_MEDIA_REFERENCE_SOURCE, FIRST], [NATIVE_MEDIA_REFERENCE_SOURCE, SECOND],
    ])
    expect(current.rpc.mock.calls.filter(call => call[1] === 'native-discard')).toHaveLength(0)
    expect(current.bridge.operations(SESSION).state.getSnapshot().bundles.map(bundle => bundle.bundleId)).toEqual([FIRST, SECOND])
  })
})
