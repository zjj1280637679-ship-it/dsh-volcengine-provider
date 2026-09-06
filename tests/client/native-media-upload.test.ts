// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NativeMediaDraftBridge,
  NATIVE_MEDIA_REFERENCE_SOURCE,
  type NativeMediaClientServices,
} from '../../src/client/native-media-upload.js'
import { formatNativeMediaMarker } from '../../src/native-media-marker.js'
import type { MediaDirectoryState } from '../../src/client/media-operations.js'

if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error)
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

const SESSION = 'session-a'
const BUNDLE = '01'.repeat(16)
const FILE_ID = '2'.repeat(32)

interface TestInputState {
  draft: string
  draftRev: number
  phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  occurrences: {
    source: string
    ref: string
    offset: number
    length: number
    label?: string
  }[]
}

function input(initialDraft = '') {
  let state: TestInputState = {
    draft: initialDraft, draftRev: 0, phase: 'plain', occurrences: [],
  }
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const listener of [...listeners]) listener() }
  return {
    setDraft(text: string) {
      state = { ...state, draft: text, draftRev: state.draftRev + 1 }
      publish()
    },
    insertReference(reference: {
      source: string; ref: string; label: string; clipboardText: string
    }, span: {
      start: number; end: number; draftRev: number
    }) {
      if (span.draftRev !== state.draftRev || span.start < 0 || span.end < span.start
        || span.end > state.draft.length || state.phase !== 'plain') return false
      // Harness publishes the clipboard/persistence projection in state.draft;
      // the friendly label is rendered by the editor node itself.
      const text = reference.clipboardText
      const delta = text.length - (span.end - span.start)
      state = {
        ...state,
        draft: state.draft.slice(0, span.start) + text + state.draft.slice(span.end),
        draftRev: state.draftRev + 1,
        occurrences: [
          ...state.occurrences.filter(row => row.offset + row.length <= span.start),
          {
            source: reference.source, ref: reference.ref, label: reference.label,
            offset: span.start, length: text.length,
          },
          ...state.occurrences.filter(row => row.offset >= span.end).map(row => ({ ...row, offset: row.offset + delta })),
        ],
      }
      publish()
      return true
    },
    notify: vi.fn(),
    state: {
      getSnapshot: () => state,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    replace(next: TestInputState) { state = next; publish() },
  }
}

function summary(bundleId = BUNDLE) {
  return {
    bundleId,
    label: 'clip.mp4',
    state: 'ready',
    expectedProvider: 'volcengine-coding-plan',
    expectedModel: 'doubao-seed-2.0-lite',
  }
}

function setup(initialDraft = '') {
  const sessionInput = input(initialDraft)
  let selection: MediaDirectoryState = {
    current: { provider: 'volcengine-coding-plan', model: 'doubao-seed-2.0-lite' },
    routable: true,
  }
  const appended: Uint8Array[] = []
  let source: NativeMediaDraftBridge['source'] | undefined
  let generated = false
  const originalCrypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { ...originalCrypto, getRandomValues(data: Uint8Array) {
      data.fill(generated ? 3 : 1)
      generated = true
      return data
    } },
  })
  const rpc = vi.fn<NativeMediaClientServices['connection']['rpc']['call']>(async (_channel, endpoint, payload) => {
    if (endpoint === 'native-capabilities') {
      return { ok: true, value: { version: 3, nativeDrafts: true, chunkBytes: 2 } }
    }
    if (endpoint === 'native-begin') {
      expect((payload as { bundleId: string }).bundleId).toBe(BUNDLE)
      return { ok: true, value: { bundleId: BUNDLE, files: [{ fileId: FILE_ID }] } }
    }
    if (endpoint === 'native-append') {
      appended.push(Uint8Array.from(atob((payload as { data: string }).data), char => char.charCodeAt(0)))
      return { ok: true, value: { receivedBytes: (payload as { offset: number }).offset + appended.at(-1)!.byteLength } }
    }
    if (endpoint === 'native-commit' || endpoint === 'native-status') {
      return { ok: true, value: summary((payload as { bundleId: string }).bundleId) }
    }
    if (endpoint === 'native-list') return { ok: true, value: { bundles: [] } }
    if (endpoint === 'native-discard') return { ok: true, value: { discarded: true } }
    return { ok: false, error: { message: `unexpected ${endpoint}` } }
  })
  const services: NativeMediaClientServices = {
    connection: { isLoopback: true, rpc: { call: rpc } },
    directories: { directoryFor: () => ({
      store: { getSnapshot: () => selection, subscribe: () => () => {} },
      load: async () => {},
    }) },
    sessions: { scope: id => id === SESSION ? {} : undefined, subagentAddress: () => undefined },
    conversation: { input: { for: () => sessionInput } },
    inputTriggers: { registerSource(candidate) { source = candidate; return () => { source = undefined } } },
    generation: { getSnapshot: () => 0, subscribe: () => () => {} },
  }
  const bridge = new NativeMediaDraftBridge(services)
  bridge.register()
  return {
    bridge, services, rpc, appended, sessionInput,
    get source() { return source! },
    select(model: string) { selection = { ...selection, current: { ...selection.current!, model } } },
    restoreCrypto() { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto }) },
  }
}

const fixtures: { bridge: NativeMediaDraftBridge; restoreCrypto(): void }[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.bridge.dispose()
    fixture.restoreCrypto()
  }
})

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('native Ark media input side path', () => {
  it('keeps native text, inserts one friendly chip, and stages exact multi-chunk bytes', async () => {
    const fixture = setup('What happens in this clip?')
    fixtures.push(fixture)
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' })
    await fixture.bridge.operations(SESSION).addFiles([file])
    const draft = fixture.sessionInput.state.getSnapshot()
    expect(draft.draft).toBe(`${formatNativeMediaMarker(BUNDLE)} What happens in this clip?`)
    expect(draft.occurrences).toEqual([expect.objectContaining({
      source: NATIVE_MEDIA_REFERENCE_SOURCE, ref: BUNDLE, label: 'Ark · clip.mp4', offset: 0,
    })])
    expect(fixture.source.codec.clipboardText(BUNDLE)).toBe(formatNativeMediaMarker(BUNDLE))
    const serialized = await fixture.source.codec.serialize(BUNDLE, new AbortController().signal)
    expect(serialized).toBe(formatNativeMediaMarker(BUNDLE))
    expect(Uint8Array.from(fixture.appended.flatMap(part => [...part]))).toEqual(bytes)
    expect(fixture.rpc.mock.calls.filter(call => call[1] === 'native-begin')).toHaveLength(1)
    expect(fixture.rpc.mock.calls.filter(call => call[1] === 'native-commit')).toHaveLength(1)
  })

  it('blocks native admission on duplicate, stale, or model-mismatched markers', async () => {
    const fixture = setup()
    fixtures.push(fixture)
    const marker = formatNativeMediaMarker(BUNDLE)
    await expect(fixture.source.matchEnter(
      { sessionId: SESSION }, `${marker} ${marker} question`, new AbortController().signal, { images: 0 },
    )).rejects.toThrow(/twice/u)
    fixture.select('another-model')
    await expect(fixture.source.matchEnter(
      { sessionId: SESSION }, `${marker} question`, new AbortController().signal, { images: 0 },
    )).rejects.toThrow(/different model/u)
    await expect(fixture.source.matchEnter(
      { sessionId: SESSION }, `${marker}, question`, new AbortController().signal, { images: 0 },
    )).rejects.toThrow(/malformed/u)
  })

  it('rehydrates a persisted canonical marker into a chip after refresh', async () => {
    const marker = formatNativeMediaMarker(BUNDLE)
    const fixture = setup(`${marker} resumed question`)
    fixtures.push(fixture)
    fixture.rpc.mockImplementation(async (_channel, endpoint, payload) => {
      if (endpoint === 'native-list') return { ok: true, value: { bundles: [summary()] } }
      if (endpoint === 'native-status') return { ok: true, value: summary((payload as { bundleId: string }).bundleId) }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    })
    fixture.source.warm({ sessionId: SESSION })
    await flush()
    const state = fixture.sessionInput.state.getSnapshot()
    expect(state.draft).toBe(`${marker} resumed question`)
    expect(state.occurrences).toEqual([expect.objectContaining({ ref: BUNDLE })])
    expect(fixture.source.lexicon({ sessionId: SESSION })).toContain(`__dsh_volc_media_v1_${BUNDLE}`)
  })

  it('does not immediately resurrect a raw marker produced by undoing rehydration', async () => {
    const marker = formatNativeMediaMarker(BUNDLE)
    const fixture = setup(marker)
    fixtures.push(fixture)
    fixture.rpc.mockImplementation(async (_channel, endpoint) => endpoint === 'native-list'
      ? { ok: true, value: { bundles: [summary()] } }
      : { ok: true, value: summary() })
    fixture.source.warm({ sessionId: SESSION })
    await flush()
    fixture.sessionInput.replace({
      draft: marker, draftRev: 2, phase: 'plain', occurrences: [],
    })
    expect(fixture.sessionInput.state.getSnapshot().draft).toBe(marker)
    expect(fixture.sessionInput.state.getSnapshot().occurrences).toHaveLength(0)
    await expect(fixture.source.matchEnter(
      { sessionId: SESSION }, marker, new AbortController().signal, { images: 0 },
    )).resolves.toBeUndefined()
  })

  it('keeps the chip when upload or selection validation fails', async () => {
    const fixture = setup('keep this text')
    fixtures.push(fixture)
    fixture.rpc.mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'native-capabilities') return { ok: true, value: { version: 3, nativeDrafts: true, chunkBytes: 2 } }
      if (endpoint === 'native-begin') return { ok: true, value: { bundleId: BUNDLE, files: [{ fileId: FILE_ID }] } }
      if (endpoint === 'native-append') return { ok: false, error: { message: 'disk unavailable' } }
      return { ok: false, error: { message: 'not ready' } }
    })
    await fixture.bridge.operations(SESSION).addFiles([
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
    ])
    await flush()
    expect(fixture.sessionInput.state.getSnapshot().draft).toContain('keep this text')
    expect(fixture.sessionInput.state.getSnapshot().occurrences).toHaveLength(1)
    await expect(fixture.source.codec.serialize(BUNDLE, new AbortController().signal)).rejects.toThrow(/disk unavailable/u)
    expect(fixture.sessionInput.notify).toHaveBeenCalledWith('error', 'disk unavailable')
  })

  it('aborts an in-flight transfer and retries retirement when its chip is removed', async () => {
    const fixture = setup('keep this text')
    fixtures.push(fixture)
    let appendSignal: AbortSignal | undefined
    fixture.rpc.mockImplementation(async (_channel, endpoint, _payload, signal) => {
      if (endpoint === 'native-capabilities') {
        return { ok: true, value: { version: 3, nativeDrafts: true, chunkBytes: 2 } }
      }
      if (endpoint === 'native-begin') {
        return { ok: true, value: { bundleId: BUNDLE, files: [{ fileId: FILE_ID }] } }
      }
      if (endpoint === 'native-append') {
        appendSignal = signal
        return await new Promise((_, reject) => {
          const aborted = (): void => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
          if (signal?.aborted) aborted()
          else signal?.addEventListener('abort', aborted, { once: true })
        })
      }
      if (endpoint === 'native-discard') return { ok: true, value: { discarded: true } }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    })
    await fixture.bridge.operations(SESSION).addFiles([
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
    ])
    await flush()
    expect(appendSignal).toBeDefined()
    const current = fixture.sessionInput.state.getSnapshot()
    fixture.sessionInput.replace({
      draft: 'keep this text', draftRev: current.draftRev + 1, phase: 'plain', occurrences: [],
    })
    await flush()
    expect(appendSignal!.aborted).toBe(true)
    expect(fixture.rpc.mock.calls.some(call => call[1] === 'native-discard')).toBe(true)
    expect(fixture.sessionInput.notify).not.toHaveBeenCalled()
  })

  it('cancels only in-flight work when the client plugin is disposed', async () => {
    const fixture = setup()
    fixtures.push(fixture)
    let appendSignal: AbortSignal | undefined
    fixture.rpc.mockImplementation(async (_channel, endpoint, _payload, signal) => {
      if (endpoint === 'native-capabilities') {
        return { ok: true, value: { version: 3, nativeDrafts: true, chunkBytes: 2 } }
      }
      if (endpoint === 'native-begin') {
        return { ok: true, value: { bundleId: BUNDLE, files: [{ fileId: FILE_ID }] } }
      }
      if (endpoint === 'native-append') {
        appendSignal = signal
        return await new Promise((_, reject) => {
          const aborted = (): void => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
          if (signal?.aborted) aborted()
          else signal?.addEventListener('abort', aborted, { once: true })
        })
      }
      if (endpoint === 'native-discard') return { ok: true, value: { discarded: true } }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    })
    await fixture.bridge.operations(SESSION).addFiles([
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
    ])
    await flush()
    fixture.bridge.dispose()
    await flush()
    expect(appendSignal!.aborted).toBe(true)
    expect(fixture.rpc.mock.calls.some(call => call[1] === 'native-discard')).toBe(true)
    expect(fixture.sessionInput.notify).not.toHaveBeenCalled()
  })

  it('keeps a committed draft bundle durable when the client plugin is disposed', async () => {
    const fixture = setup('survive restart')
    fixtures.push(fixture)
    await fixture.bridge.operations(SESSION).addFiles([
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
    ])
    await fixture.source.codec.serialize(BUNDLE, new AbortController().signal)
    await flush()
    fixture.bridge.dispose()
    await flush()
    expect(fixture.rpc.mock.calls.filter(call => call[1] === 'native-commit')).toHaveLength(1)
    expect(fixture.rpc.mock.calls.filter(call => call[1] === 'native-discard')).toHaveLength(0)
  })
})
