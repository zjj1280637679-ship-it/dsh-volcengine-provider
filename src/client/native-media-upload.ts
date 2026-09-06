import {
  NATIVE_MEDIA_PROTOCOL_VERSION,
  NATIVE_MEDIA_RPC_CHANNEL,
  type NativeMediaBundleSummary,
  type NativeMediaCapabilities,
  type NativeMediaFileDeclaration,
} from '../native-media-protocol.js'
import {
  arkChatMediaFileSpec,
} from '../media-file-types.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InputTriggerServiceContract,
  InputTriggerSource,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  formatNativeMediaMarker,
  nativeMediaMarkerIds,
  NATIVE_MEDIA_MARKER_NAME_PREFIX,
  parseLeadingNativeMediaMarkers,
} from '../native-media-marker.js'
import type {
  MediaDirectoryState,
  MediaSelection,
  ReadableStore,
} from './media-operations.js'

type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

interface InputState {
  readonly draft: string
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  readonly occurrences: readonly {
    readonly source: string
    readonly ref: string
    readonly offset: number
    readonly length: number
  }[]
}

type PublicSessionInput = ReturnType<IConversation['input']['for']>

// The two supported Harness lines publish the same SessionInput verbs through
// IConversation, while their complete InputState currencies contain different
// extra fields. Keep only the snapshot fields this bridge reads.
type SessionInput = Pick<PublicSessionInput, 'setDraft' | 'insertReference' | 'notify'> & {
  readonly state: ReadableStore<InputState>
}

// Candidate and pick request details changed between the supported releases.
// Identity, reference serialization and enter adjudication are the stable
// public surface this non-menu source actually implements.
type NativeMediaInputTriggerSource = Pick<
  InputTriggerSource,
  'trigger' | 'name' | 'order' | 'showGroupTitle'
> & {
  candidates(session: { readonly sessionId: string }, request: { readonly signal: AbortSignal }): Promise<readonly never[]>
  onPick(): undefined
  matchEnter(
    session: { readonly sessionId: string },
    line: string,
    signal: AbortSignal,
    envelope: { readonly images: number },
  ): Promise<undefined>
  warm(session: { readonly sessionId: string }): void
  lexicon(session: { readonly sessionId: string }): readonly string[] | undefined
  subscribeLexicon(session: { readonly sessionId: string }, listener: () => void): () => void
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

export interface NativeMediaClientServices {
  readonly connection: Pick<ConnectionHandle, 'isLoopback'> & {
    readonly rpc: {
      call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<Result<unknown>>
    }
  }
  readonly directories: {
    directoryFor(sessionId: string): {
      readonly store: ReadableStore<MediaDirectoryState>
      load(): Promise<unknown>
    }
  }
  readonly sessions: {
    scope(sessionId: string): unknown
    subagentAddress(sessionId: string): unknown
  }
  readonly conversation: {
    readonly input: {
      for(scope: Parameters<IConversation['input']['for']>[0]): SessionInput
    }
  }
  readonly inputTriggers: {
    registerSource(source: NativeMediaInputTriggerSource): ReturnType<InputTriggerServiceContract['registerSource']>
  }
  readonly generation: ReadableStore<number>
}

interface NativeMediaBeginResult {
  readonly bundleId: string
  readonly files: readonly { readonly fileId: string }[]
}

interface DraftRecord {
  readonly sessionId: string
  readonly bundleId: string
  readonly label: string
  readonly expected: MediaSelection
  readonly generation: number
  readonly controller: AbortController
  readonly upload: Promise<void>
  state: 'uploading' | 'ready' | 'failed'
}

interface SessionRecovery {
  readonly input: SessionInput
  readonly ready: Map<string, NativeMediaBundleSummary>
  readonly listeners: Set<() => void>
  readonly suppressed: Set<string>
  stop: () => void
  previous: InputState
  rehydrating: boolean
  loaded: boolean
}

export interface NativeMediaDraftState {
  readonly uploads: number
  readonly bundles: readonly NativeMediaDraftBundle[]
}

export interface NativeMediaDraftFile extends NativeMediaFileDeclaration {
  /** Bytes acknowledged by the local staging service, without changing the file. */
  readonly uploadedBytes: number
}

export interface NativeMediaDraftBundle {
  readonly bundleId: string
  readonly label: string
  readonly expected: MediaSelection
  readonly state: 'uploading' | 'ready' | 'failed' | 'cancelled'
  /** Older persisted bundle summaries contain no individual file metadata. */
  readonly files?: readonly NativeMediaDraftFile[]
  readonly error?: string
}

export interface NativeMediaDraftOperations {
  readonly state: ReadableStore<NativeMediaDraftState>
  readonly selection: ReadableStore<MediaDirectoryState>
  load(): Promise<void>
  addFiles(files: readonly File[]): Promise<void>
  cancelUpload(bundleId: string): void
  notify(level: 'info' | 'error', text: string): void
}

export const NATIVE_MEDIA_REFERENCE_SOURCE = 'dsh-volcengine-provider.native-media.v1'
const BUNDLE_ID_PATTERN = /^[a-f0-9]{32}$/u
const FILE_ID_PATTERN = /^[a-f0-9]{32}$/u
const FILE_NAME_MAX_CHARS = 255
const DISCARD_TIMEOUT_MS = 1_000

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The media staging response was invalid.')
  }
  return value as Record<string, unknown>
}

function capabilities(value: unknown): NativeMediaCapabilities {
  const candidate = object(value)
  if (candidate.version !== NATIVE_MEDIA_PROTOCOL_VERSION || candidate.nativeDrafts !== true
    || !Number.isSafeInteger(candidate.chunkBytes) || Number(candidate.chunkBytes) <= 0) {
    throw new Error('The installed provider does not expose the native Ark media draft protocol.')
  }
  return {
    version: NATIVE_MEDIA_PROTOCOL_VERSION,
    nativeDrafts: true,
    chunkBytes: Number(candidate.chunkBytes),
  }
}

function beginResult(value: unknown, bundleId: string, count: number): NativeMediaBeginResult {
  const candidate = object(value)
  if (candidate.bundleId !== bundleId || !Array.isArray(candidate.files)
    || candidate.files.length !== count) throw new Error('The media staging response was invalid.')
  const files = candidate.files.map(item => {
    const file = object(item)
    if (typeof file.fileId !== 'string' || !FILE_ID_PATTERN.test(file.fileId)) {
      throw new Error('The media staging response was invalid.')
    }
    return { fileId: file.fileId }
  })
  if (new Set(files.map(file => file.fileId)).size !== files.length) {
    throw new Error('The media staging response was invalid.')
  }
  return { bundleId, files }
}

function summary(value: unknown, expectedId?: string): NativeMediaBundleSummary {
  const candidate = object(value)
  if (typeof candidate.bundleId !== 'string' || !BUNDLE_ID_PATTERN.test(candidate.bundleId)
    || expectedId !== undefined && candidate.bundleId !== expectedId
    || (candidate.state !== 'ready' && candidate.state !== 'claimed')
    || typeof candidate.label !== 'string' || candidate.label.length === 0
    || typeof candidate.expectedProvider !== 'string' || candidate.expectedProvider.length === 0
    || typeof candidate.expectedModel !== 'string' || candidate.expectedModel.length === 0) {
    throw new Error('The media bundle is invalid or no longer available.')
  }
  return candidate as unknown as NativeMediaBundleSummary
}

function listed(value: unknown): readonly NativeMediaBundleSummary[] {
  const candidate = object(value)
  if (!Array.isArray(candidate.bundles)) throw new Error('The media staging response was invalid.')
  const rows = candidate.bundles.map(item => summary(item))
  if (new Set(rows.map(row => row.bundleId)).size !== rows.length) {
    throw new Error('The media staging response was invalid.')
  }
  return rows
}

function safeFile(file: File): NativeMediaFileDeclaration {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('Each Ark media attachment must contain at least one byte.')
  }
  if (file.name.length === 0 || file.name.length > FILE_NAME_MAX_CHARS
    || file.name === '.' || file.name === '..' || /[\\/\u0000-\u001f\u007f]/u.test(file.name)) {
    throw new Error('An Ark media attachment has an invalid file name.')
  }
  return { name: file.name, bytes: file.size, ...arkChatMediaFileSpec(file.name, file.type) }
}

function sameSelection(left: MediaSelection, right: MediaSelection | null): boolean {
  return right !== null && left.provider === right.provider && left.model === right.model
}

function secureBundleId(): string {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('This browser cannot create a secure Ark media reference.')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64Of(data: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < data.byteLength; offset += step) {
    binary += String.fromCharCode(...data.subarray(offset, Math.min(offset + step, data.byteLength)))
  }
  return btoa(binary)
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason instanceof Error
      ? signal.reason : new DOMException('Submission was cancelled.', 'AbortError'))
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function labelFor(files: readonly File[]): string {
  return files.length === 1 ? files[0]!.name : `${files[0]!.name} +${files.length - 1}`
}

function occurrence(reference: { readonly ref: string }, bundleId: string): boolean {
  return reference.ref === bundleId
}

/** Native-composer side path: files stage over loopback; Harness still owns submit/queue/steer. */
export class NativeMediaDraftBridge {
  private readonly records = new Map<string, DraftRecord>()
  private readonly details = new Map<string, NativeMediaDraftBundle>()
  private readonly recordSessions = new Map<string, string>()
  private readonly recoveries = new Map<string, SessionRecovery>()
  private readonly operationStores = new Map<string, {
    value: NativeMediaDraftState
    listeners: Set<() => void>
  }>()
  private readonly serialized = new WeakMap<AbortSignal, Set<string>>()
  private sourceOff: (() => void) | undefined
  private disposed = false

  readonly source: NativeMediaInputTriggerSource = {
    trigger: '/',
    name: NATIVE_MEDIA_REFERENCE_SOURCE,
    order: 1_000,
    showGroupTitle: false,
    candidates: async () => [],
    onPick: () => undefined,
    warm: session => { void this.warm(session.sessionId) },
    lexicon: session => {
      const recovery = this.recoveries.get(session.sessionId)
      if (recovery === undefined || !recovery.loaded) return undefined
      return [...recovery.ready.keys()].map(id => NATIVE_MEDIA_MARKER_NAME_PREFIX + id)
    },
    subscribeLexicon: (session, listener) => {
      const recovery = this.ensureRecovery(session.sessionId)
      recovery.listeners.add(listener)
      return () => { recovery.listeners.delete(listener) }
    },
    matchEnter: async (session, line, signal) => {
      if (!line.startsWith(`/${NATIVE_MEDIA_MARKER_NAME_PREFIX}`)) return undefined
      const ids = parseLeadingNativeMediaMarkers(line)
      if (ids.length === 0 || nativeMediaMarkerIds(line).length !== ids.length) {
        throw new Error('An Ark media attachment reference is malformed or was moved. Keep attachment chips at the start of the message.')
      }
      if (new Set(ids).size !== ids.length) throw new Error('The same Ark media attachment cannot be submitted twice.')
      await Promise.all(ids.map(id => this.validateBundle(session.sessionId, id, signal)))
      return undefined
    },
    codec: {
      clipboardText: ref => formatNativeMediaMarker(ref),
      serialize: (ref, signal) => this.serialize(ref, signal),
    },
  }

  constructor(private readonly services: NativeMediaClientServices) {}

  register(): () => void {
    if (this.disposed) throw new Error('The Ark media input side path has already been disposed.')
    this.sourceOff ??= this.services.inputTriggers.registerSource(this.source)
    return () => this.dispose()
  }

  operations(sessionId: string): NativeMediaDraftOperations {
    const store = this.store(sessionId)
    const directory = this.services.directories.directoryFor(sessionId)
    return {
      state: {
        getSnapshot: () => store.value,
        subscribe: listener => { store.listeners.add(listener); return () => { store.listeners.delete(listener) } },
      },
      selection: directory.store,
      load: async () => { if (!this.disposed) { await directory.load(); await this.warm(sessionId) } },
      addFiles: files => this.addFiles(sessionId, files),
      cancelUpload: bundleId => this.cancelUpload(sessionId, bundleId),
      notify: (level, text) => this.input(sessionId).notify(level, text),
    }
  }

  private store(sessionId: string): { value: NativeMediaDraftState; listeners: Set<() => void> } {
    let store = this.operationStores.get(sessionId)
    if (store === undefined) {
      store = { value: { uploads: 0, bundles: [] }, listeners: new Set() }
      this.operationStores.set(sessionId, store)
    }
    return store
  }

  private publish(sessionId: string): void {
    if (this.disposed) return
    const store = this.store(sessionId)
    const state = this.recoveries.get(sessionId)?.input.state.getSnapshot()
    const ids = new Set<string>()
    if (state !== undefined) {
      for (const row of state.occurrences) {
        if (row.source === NATIVE_MEDIA_REFERENCE_SOURCE) ids.add(row.ref)
      }
      for (const marker of nativeMediaMarkerIds(state.draft, true)) {
        // Text encoded by another source is never our attachment.
        if (!state.occurrences.some(row => row.offset < marker.end
          && row.offset + row.length > marker.start)) ids.add(marker.bundleId)
      }
    }
    const bundles = [...ids].flatMap(id => {
      if (this.recordSessions.get(id) !== sessionId) return []
      const detail = this.details.get(id)
      return detail === undefined ? [] : [detail]
    })
    if (bundles.length === store.value.bundles.length
      && bundles.every((bundle, index) => bundle === store.value.bundles[index])) return
    store.value = { uploads: bundles.filter(bundle => bundle.state === 'uploading').length, bundles }
    for (const listener of [...store.listeners]) listener()
  }

  private updateDetail(sessionId: string, bundleId: string, patch: Partial<NativeMediaDraftBundle>): void {
    const detail = this.details.get(bundleId)
    if (detail === undefined) return
    this.details.set(bundleId, { ...detail, ...patch })
    this.publish(sessionId)
  }

  private input(sessionId: string): SessionInput {
    const scope = this.services.sessions.scope(sessionId)
    if (scope === undefined || this.services.sessions.subagentAddress(sessionId) !== undefined) {
      throw new Error('Ark media attachments are available only in a local top-level Harness session.')
    }
    // Session scope types moved packages between 0.1.1 and 0.1.2. The runtime
    // guard above is the stable public contract; this is the sole type seam.
    return this.services.conversation.input.for(scope as Parameters<IConversation['input']['for']>[0])
  }

  private async selection(sessionId: string, signal?: AbortSignal): Promise<MediaSelection> {
    if (!this.services.connection.isLoopback) {
      throw new Error('Raw Ark media attachment staging is available only through local Harness.')
    }
    const directory = this.services.directories.directoryFor(sessionId)
    await directory.load()
    signal?.throwIfAborted()
    const state = directory.store.getSnapshot()
    if (state.current === null || state.routable === false
      || !state.current.provider.startsWith('volcengine-') || state.current.model.length === 0) {
      throw new Error('Select an enabled Volcengine Ark model before adding media.')
    }
    return { ...state.current }
  }

  private async addFiles(sessionId: string, files: readonly File[]): Promise<void> {
    if (this.disposed) throw new Error('The Ark media input side path is unavailable.')
    if (files.length === 0) return
    const declarations = files.map(safeFile)
    // Subscribe before the optimistic insert so chip deletion/undo is observed
    // even when the Host has not warmed the slash-trigger source yet.
    const input = this.ensureRecovery(sessionId).input
    const snapshot = input.state.getSnapshot()
    if (snapshot.phase !== 'plain') {
      throw new Error('Finish or cancel the current composer action before adding Ark media.')
    }
    const expected = await this.selection(sessionId)
    const generation = this.services.generation.getSnapshot()
    const bundleId = secureBundleId()
    const controller = new AbortController()
    this.details.set(bundleId, {
      bundleId, label: labelFor(files), expected, state: 'uploading',
      files: declarations.map(file => ({ ...file, uploadedBytes: 0 })),
    })
    const upload = this.upload(sessionId, bundleId, expected, generation, files, declarations, controller.signal)
    const record: DraftRecord = {
      sessionId, bundleId, label: labelFor(files), expected, generation,
      controller, upload, state: 'uploading',
    }
    this.records.set(bundleId, record)
    this.bindSession(bundleId, sessionId)
    const live = input.state.getSnapshot()
    if (live.phase !== 'plain' || !input.insertReference(this.reference(record.label, bundleId), {
      start: 0, end: 0, draftRev: live.draftRev,
    })) {
      this.discardRecordInBackground(sessionId, bundleId)
      throw new Error('The Harness draft changed before the Ark attachment could be inserted. Select it again.')
    }
    this.separateLeadingOccurrence(input, bundleId)
    this.publish(sessionId)
    void upload.then(() => {
      record.state = 'ready'
      if (this.records.get(bundleId) !== record) return
      this.updateDetail(sessionId, bundleId, { state: 'ready' })
      this.records.delete(bundleId)
      if (!this.disposed) void this.refresh(sessionId).catch(() => undefined)
    }, error => {
      record.state = 'failed'
      if (!this.disposed && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'The Ark media upload failed; remove the attachment chip and select the file again.'
        this.updateDetail(sessionId, bundleId, { state: 'failed', error: message })
        input.notify('error', message)
      }
    })
  }

  private cancelUpload(sessionId: string, bundleId: string): void {
    const record = this.records.get(bundleId)
    if (record?.sessionId !== sessionId || record.state !== 'uploading') return
    const input = this.input(sessionId)
    if (input.state.getSnapshot().phase !== 'plain') {
      input.notify('info', '请先取消当前发送操作，再取消附件上传。')
      return
    }
    record.state = 'failed'
    this.updateDetail(sessionId, bundleId, { state: 'cancelled' })
    record.controller.abort(new DOMException('方舟附件上传已取消，请删除输入框中对应的 Ark 引用。', 'AbortError'))
    this.discardInBackground(sessionId, bundleId)
    void record.upload.catch(() => undefined).finally(() => this.discardInBackground(sessionId, bundleId))
  }

  private reference(label: string, bundleId: string): ReferenceInsert {
    return {
      source: NATIVE_MEDIA_REFERENCE_SOURCE,
      ref: bundleId,
      label: `Ark · ${label}`,
      appearance: 'file',
      clipboardText: formatNativeMediaMarker(bundleId),
    }
  }

  private separateLeadingOccurrence(input: SessionInput, bundleId: string): void {
    const state = input.state.getSnapshot()
    const row = state.occurrences.find(item => item.source === NATIVE_MEDIA_REFERENCE_SOURCE
      && occurrence(item, bundleId))
    if (row === undefined) return
    const end = row.offset + row.length
    if (end === state.draft.length || !/\s/u.test(state.draft[end]!)) {
      input.setDraft(state.draft.slice(0, end) + ' ' + state.draft.slice(end))
    }
  }

  private async upload(
    sessionId: string,
    bundleId: string,
    expected: MediaSelection,
    generation: number,
    files: readonly File[],
    declarations: readonly NativeMediaFileDeclaration[],
    signal: AbortSignal,
  ): Promise<void> {
    const rawCapabilities = unwrap(await this.services.connection.rpc.call(
      NATIVE_MEDIA_RPC_CHANNEL, 'native-capabilities', {}, signal,
    ))
    const { chunkBytes } = capabilities(rawCapabilities)
    this.assertStable(sessionId, expected, generation, signal)
    const begun = beginResult(unwrap(await this.services.connection.rpc.call(
      NATIVE_MEDIA_RPC_CHANNEL, 'native-begin', {
        sessionId, bundleId, expectedProvider: expected.provider, expectedModel: expected.model,
        files: declarations,
      }, signal,
    )), bundleId, files.length)
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!
      const fileId = begun.files[index]!.fileId
      let offset = 0
      while (offset < file.size) {
        this.assertStable(sessionId, expected, generation, signal)
        const end = Math.min(file.size, offset + chunkBytes)
        const data = new Uint8Array(await file.slice(offset, end).arrayBuffer())
        signal.throwIfAborted()
        const appended = object(unwrap(await this.services.connection.rpc.call(NATIVE_MEDIA_RPC_CHANNEL, 'native-append', {
          sessionId, bundleId, fileId, offset, data: base64Of(data),
        }, signal)))
        if (appended.receivedBytes !== end) throw new Error('The media staging service did not confirm the uploaded bytes.')
        offset = end
        const detail = this.details.get(bundleId)
        if (detail?.state === 'uploading') {
          this.updateDetail(sessionId, bundleId, {
            files: detail.files?.map((item, itemIndex) => itemIndex === index
              ? { ...item, uploadedBytes: offset } : item),
          })
        }
      }
    }
    this.assertStable(sessionId, expected, generation, signal)
    const committed = summary(unwrap(await this.services.connection.rpc.call(
      NATIVE_MEDIA_RPC_CHANNEL, 'native-commit', { sessionId, bundleId }, signal,
    )), bundleId)
    this.assertStable(sessionId, expected, generation, signal)
    if (committed.state !== 'ready') throw new Error('The Ark media bundle was not committed.')
  }

  private assertStable(sessionId: string, expected: MediaSelection, generation: number, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (generation !== this.services.generation.getSnapshot()) {
      throw new Error('The Harness connection changed; remove the Ark attachment chip and select the file again.')
    }
    const current = this.services.directories.directoryFor(sessionId).store.getSnapshot().current
    if (!sameSelection(expected, current)) {
      throw new Error('The selected model changed during upload; remove the Ark attachment chip and select the file again.')
    }
  }

  private async validateBundle(sessionId: string, bundleId: string, signal: AbortSignal): Promise<NativeMediaBundleSummary> {
    if (!BUNDLE_ID_PATTERN.test(bundleId)) throw new Error('The Ark media attachment reference is invalid.')
    const expected = await this.selection(sessionId, signal)
    const row = summary(unwrap(await this.services.connection.rpc.call(
      NATIVE_MEDIA_RPC_CHANNEL, 'native-status', { sessionId, bundleId }, signal,
    )), bundleId)
    if (row.state !== 'ready' || row.expectedProvider !== expected.provider || row.expectedModel !== expected.model) {
      throw new Error('The Ark media attachment belongs to a different model selection or is no longer ready.')
    }
    this.bindSession(bundleId, sessionId)
    return row
  }

  private async serialize(bundleId: string, signal: AbortSignal): Promise<string> {
    if (!BUNDLE_ID_PATTERN.test(bundleId)) throw new Error('The Ark media attachment reference is invalid.')
    let seen = this.serialized.get(signal)
    if (seen === undefined) { seen = new Set(); this.serialized.set(signal, seen) }
    if (seen.has(bundleId)) throw new Error('The same Ark media attachment cannot be submitted twice.')
    seen.add(bundleId)
    const record = this.records.get(bundleId)
    const sessionId = record?.sessionId ?? this.recordSessions.get(bundleId)
    if (sessionId === undefined) throw new Error('The Ark media attachment is no longer associated with this Harness session.')
    if (record !== undefined) await raceAbort(record.upload, signal)
    await this.validateBundle(sessionId, bundleId, signal)
    return formatNativeMediaMarker(bundleId)
  }

  private bindSession(bundleId: string, sessionId: string): void {
    const existing = this.recordSessions.get(bundleId)
    if (existing !== undefined && existing !== sessionId) {
      throw new Error('The Ark media reference collided across Harness sessions.')
    }
    this.recordSessions.set(bundleId, sessionId)
  }

  private ensureRecovery(sessionId: string): SessionRecovery {
    const existing = this.recoveries.get(sessionId)
    if (existing !== undefined) return existing
    const input = this.input(sessionId)
    const recovery: SessionRecovery = {
      input,
      ready: new Map(),
      listeners: new Set(),
      suppressed: new Set(),
      previous: input.state.getSnapshot(),
      rehydrating: false,
      loaded: false,
      stop: () => {},
    }
    recovery.stop = input.state.subscribe(() => this.inputChanged(sessionId, recovery))
    this.recoveries.set(sessionId, recovery)
    return recovery
  }

  private async warm(sessionId: string): Promise<void> {
    if (this.disposed) return
    this.ensureRecovery(sessionId)
    await this.refresh(sessionId).catch(() => undefined)
  }

  private async refresh(sessionId: string): Promise<void> {
    const recovery = this.ensureRecovery(sessionId)
    const rows = listed(unwrap(await this.services.connection.rpc.call(
      NATIVE_MEDIA_RPC_CHANNEL, 'native-list', { sessionId }, undefined,
    )))
    if (this.disposed) return
    recovery.ready.clear()
    for (const row of rows) {
      recovery.ready.set(row.bundleId, row)
      this.bindSession(row.bundleId, sessionId)
      if (!this.details.has(row.bundleId) && row.state === 'ready') {
        this.details.set(row.bundleId, {
          bundleId: row.bundleId, label: row.label, state: 'ready',
          expected: { provider: row.expectedProvider, model: row.expectedModel },
        })
      }
    }
    recovery.loaded = true
    for (const listener of [...recovery.listeners]) listener()
    this.rehydrate(recovery)
    this.publish(sessionId)
  }

  private inputChanged(_sessionId: string, recovery: SessionRecovery): void {
    if (recovery.rehydrating) return
    const current = recovery.input.state.getSnapshot()
    const previousOccurrenceRefs = new Set(recovery.previous.occurrences
      .filter(row => row.source === NATIVE_MEDIA_REFERENCE_SOURCE).map(row => row.ref))
    const previousRefs = new Set(previousOccurrenceRefs)
    for (const id of nativeMediaMarkerIds(recovery.previous.draft)) previousRefs.add(id)
    const currentOccurrenceRefs = new Set(current.occurrences
      .filter(row => row.source === NATIVE_MEDIA_REFERENCE_SOURCE).map(row => row.ref))
    const raw = new Set(nativeMediaMarkerIds(current.draft))
    const currentRefs = new Set(currentOccurrenceRefs)
    for (const id of raw) currentRefs.add(id)
    for (const ref of previousOccurrenceRefs) {
      if (!currentOccurrenceRefs.has(ref) && raw.has(ref)) recovery.suppressed.add(ref)
    }
    for (const ref of [...recovery.suppressed]) {
      if (!raw.has(ref)) recovery.suppressed.delete(ref)
    }
    // A plain-to-plain disappearance is an explicit draft edit/undo. A native
    // submit passes through `submitting`; never retire its bundle here because
    // the same marker may now be waiting in Harness's durable inbox queue.
    if (recovery.previous.phase === 'plain' && current.phase === 'plain') {
      let lexiconChanged = false
      for (const ref of previousRefs) {
        if (currentRefs.has(ref)) continue
        this.discardRecordInBackground(_sessionId, ref)
        lexiconChanged = recovery.ready.delete(ref) || lexiconChanged
      }
      if (lexiconChanged) for (const listener of [...recovery.listeners]) listener()
    }
    recovery.previous = current
    this.rehydrate(recovery)
    this.publish(_sessionId)
  }

  private rehydrate(recovery: SessionRecovery): void {
    if (!recovery.loaded || recovery.rehydrating) return
    recovery.rehydrating = true
    try {
      for (;;) {
        const state = recovery.input.state.getSnapshot()
        const marker = nativeMediaMarkerIds(state.draft, true).find(item => {
          if (!recovery.ready.has(item.bundleId) || recovery.suppressed.has(item.bundleId)) return false
          // Clipboard text inside any existing chip belongs to its source.
          return !state.occurrences.some(row => row.offset < item.end
            && row.offset + row.length > item.start)
        })
        if (marker === undefined) break
        const row = recovery.ready.get(marker.bundleId)!
        // InputState uses expanded clipboard coordinates; insertReference uses
        // detect coordinates, where every existing chip occupies one character.
        const expansion = state.occurrences.reduce((total, item) => (
          item.offset + item.length <= marker.start ? total + item.length - 1 : total
        ), 0)
        if (!recovery.input.insertReference(this.reference(row.label, row.bundleId), {
          start: marker.start - expansion, end: marker.end - expansion, draftRev: state.draftRev,
        })) break
      }
      recovery.previous = recovery.input.state.getSnapshot()
    } finally {
      recovery.rehydrating = false
    }
  }

  private discardInBackground(sessionId: string, bundleId: string): void {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISCARD_TIMEOUT_MS)
    void this.services.connection.rpc.call(NATIVE_MEDIA_RPC_CHANNEL, 'native-discard', {
      sessionId, bundleId,
    }, controller.signal).catch(() => undefined).finally(() => clearTimeout(timer))
  }

  /** Abort local work immediately, then retry retirement after the RPC settles. */
  private discardRecordInBackground(sessionId: string, bundleId: string): void {
    const record = this.records.get(bundleId)
    record?.controller.abort(new DOMException('The Ark media attachment was removed.', 'AbortError'))
    this.records.delete(bundleId)
    this.details.delete(bundleId)
    this.recordSessions.delete(bundleId)
    this.discardInBackground(sessionId, bundleId)
    if (record !== undefined) {
      void record.upload.catch(() => undefined).finally(() => {
        this.discardInBackground(sessionId, bundleId)
      })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sourceOff?.()
    this.sourceOff = undefined
    for (const recovery of this.recoveries.values()) recovery.stop()
    this.recoveries.clear()
    // Ready bundles belong to the native persisted draft and must survive a
    // whole Harness restart. Only transfers still in flight are cancelled.
    for (const record of this.records.values()) {
      if (record.state !== 'uploading') continue
      record.controller.abort(new DOMException('The Ark media input side path was disposed.', 'AbortError'))
      this.discardInBackground(record.sessionId, record.bundleId)
      void record.upload.catch(() => undefined).finally(() => {
        this.discardInBackground(record.sessionId, record.bundleId)
      })
    }
    this.records.clear()
    this.details.clear()
    this.recordSessions.clear()
    this.operationStores.clear()
  }
}
