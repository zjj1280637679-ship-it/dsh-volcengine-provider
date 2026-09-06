import { constants as bufferConstants } from 'node:buffer'
import { createHash, randomBytes, type Hash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  isArkChatMediaDeclaration,
  type ArkChatMediaFileSpec,
  type ArkChatMediaModality,
} from './media-file-types.js'
import {
  formatNativeMediaMarker,
  isNativeMediaBundleId,
} from './native-media-marker.js'
import {
  isSafeOriginalMediaName,
  OriginalMediaStore,
  type OriginalMediaAttachmentRef,
} from './original-media-store.js'

export const NATIVE_MEDIA_BUNDLE_TTL_MS = 5 * 60 * 1000

const MANIFEST_VERSION = 1
const FILE_ID_PATTERN = /^[a-f0-9]{32}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SESSION_ID_MAX_CHARS = 512
const SELECTION_ID_MAX_CHARS = 512
const MESSAGE_ID_MAX_CHARS = 512

export interface NativeMediaFileDeclaration extends ArkChatMediaFileSpec {
  readonly name: string
  readonly bytes: number
}

export interface NativeMediaBeginRequest {
  readonly sessionId: string
  /** Client-minted 128-bit id already present in the composer's durable marker. */
  readonly bundleId: string
  /** Transitional alias; when supplied it must be identical to bundleId. */
  readonly clientSubmissionId?: string
  readonly expectedProvider: string
  readonly expectedModel: string
  readonly files: readonly NativeMediaFileDeclaration[]
}

export interface NativeMediaFileHandle extends NativeMediaFileDeclaration {
  readonly fileId: string
}

export interface NativeMediaBundleHandle {
  readonly bundleId: string
  readonly marker: string
  readonly files: readonly NativeMediaFileHandle[]
}

export interface NativeMediaAppendRequest {
  readonly sessionId: string
  readonly bundleId: string
  readonly fileId: string
  readonly offset: number
  readonly data: Uint8Array
}

export interface NativeMediaArmedFile extends NativeMediaFileHandle {
  readonly sha256: string
}

export interface NativeMediaArmedBundle {
  readonly bundleId: string
  readonly marker: string
  readonly label: string
  readonly state: 'ready'
  readonly sessionId: string
  readonly expectedProvider: string
  readonly expectedModel: string
  readonly files: readonly NativeMediaArmedFile[]
}

export interface NativeMediaClaim {
  readonly bundleId: string
  readonly marker: string
  readonly sessionId: string
  readonly messageId: string
}

export interface MaterializedNativeMediaFile extends NativeMediaArmedFile {
  readonly attachment: OriginalMediaAttachmentRef
}

export interface MaterializedNativeMediaBundle {
  readonly bundleId: string
  readonly marker: string
  readonly sessionId: string
  readonly messageId: string
  readonly expectedProvider: string
  readonly expectedModel: string
  readonly files: readonly MaterializedNativeMediaFile[]
}

export type NativeMediaBundlePhase = 'uploading' | 'committing' | 'armed' | 'materializing' | 'materialized'

export interface NativeMediaBundleStatus {
  readonly bundleId: string
  readonly marker: string
  readonly label: string
  readonly state: 'ready' | 'claimed'
  readonly expectedProvider: string
  readonly expectedModel: string
  readonly phase: NativeMediaBundlePhase
  readonly files: readonly {
    readonly fileId: string
    readonly receivedBytes: number
    readonly bytes: number
  }[]
  readonly messageId?: string
}

export interface NativeMediaStagingOptions {
  readonly now?: () => number
  readonly mintFileId?: () => string
  readonly ttlMs?: number
}

export class NativeMediaInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NativeMediaInputError'
  }
}

export class NativeMediaClaimError extends Error {
  constructor() {
    super('The armed media bundle is already bound to another user message.')
    this.name = 'NativeMediaClaimError'
  }
}

export class NativeMediaSelectionError extends Error {
  constructor() {
    super('The selected provider or model changed after the media bundle upload began.')
    this.name = 'NativeMediaSelectionError'
  }
}

export class NativeMediaLifecycleError extends Error {
  constructor() {
    super('The native media staging service is closing.')
    this.name = 'NativeMediaLifecycleError'
  }
}

interface NormalizedFile extends NativeMediaFileDeclaration {
  readonly modality: ArkChatMediaModality
}

interface PendingFile extends NormalizedFile {
  readonly fileId: string
  readonly stagingToken?: string
  hasher?: Hash
  receivedBytes: number
  appending: boolean
  sha256?: string
  attachment?: OriginalMediaAttachmentRef
}

interface PendingBundle {
  readonly bundleId: string
  readonly sessionId: string
  readonly expectedProvider: string
  readonly expectedModel: string
  readonly files: PendingFile[]
  readonly createdAt: number
  expiresAt: number
  phase: NativeMediaBundlePhase
  messageId?: string
  commitPromise?: Promise<NativeMediaArmedBundle>
  materializePromise?: Promise<MaterializedNativeMediaBundle>
  materialized?: MaterializedNativeMediaBundle
}

interface DurableManifestFile extends NormalizedFile {
  readonly fileId: string
  readonly sha256: string
  readonly attachment: OriginalMediaAttachmentRef
}

interface DurableManifest {
  readonly version: typeof MANIFEST_VERSION
  readonly bundleId: string
  readonly sessionId: string
  readonly expectedProvider: string
  readonly expectedModel: string
  readonly createdAt: number
  readonly phase: 'armed' | 'materialized'
  readonly messageId?: string
  readonly files: readonly DurableManifestFile[]
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function systemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function validIdentity(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID_PATTERN.test(value)
}

function maximumRepresentableBytes(file: ArkChatMediaFileSpec): number {
  const prefixChars = file.modality === 'audio' ? 0 : `data:${file.mediaType};base64,`.length
  const base64Bytes = Math.floor((bufferConstants.MAX_STRING_LENGTH - prefixChars) / 4) * 3
  return Math.min(bufferConstants.MAX_LENGTH, base64Bytes, Number.MAX_SAFE_INTEGER)
}

function normalizeFile(value: unknown): NormalizedFile {
  if (!plainRecord(value)) throw new NativeMediaInputError('A native media file declaration is invalid.')
  const allowed = new Set(['bytes', 'format', 'mediaType', 'modality', 'name'])
  if (Object.keys(value).some(key => !allowed.has(key))
    || !isSafeOriginalMediaName(value.name)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
    throw new NativeMediaInputError('A native media file declaration is invalid.')
  }
  const media = {
    modality: value.modality,
    mediaType: value.mediaType,
    ...(value.format === undefined ? {} : { format: value.format }),
  }
  if (!isArkChatMediaDeclaration(media)
    || (value.bytes as number) > maximumRepresentableBytes(media)) {
    throw new NativeMediaInputError('A native media file declaration is invalid.')
  }
  return {
    name: value.name,
    bytes: value.bytes as number,
    modality: media.modality,
    mediaType: media.mediaType,
    ...(media.format === undefined ? {} : { format: media.format }),
  }
}

interface NormalizedBeginRequest extends Omit<NativeMediaBeginRequest, 'clientSubmissionId' | 'files'> {
  readonly files: readonly NormalizedFile[]
  readonly totalBytes: number
}

function normalizeBegin(value: unknown): NormalizedBeginRequest {
  if (!plainRecord(value)) throw new NativeMediaInputError('The native media bundle request is invalid.')
  const allowed = new Set([
    'bundleId', 'clientSubmissionId', 'expectedModel', 'expectedProvider', 'files', 'sessionId',
  ])
  if (Object.keys(value).some(key => !allowed.has(key))
    || !validIdentity(value.sessionId, SESSION_ID_MAX_CHARS)
    || !isNativeMediaBundleId(value.bundleId)
    || (value.clientSubmissionId !== undefined && value.clientSubmissionId !== value.bundleId)
    || !validIdentity(value.expectedProvider, SELECTION_ID_MAX_CHARS)
    || !validIdentity(value.expectedModel, SELECTION_ID_MAX_CHARS)
    || !Array.isArray(value.files) || value.files.length === 0) {
    throw new NativeMediaInputError('The native media bundle request is invalid.')
  }
  const files = value.files.map(normalizeFile)
  let totalBytes = 0
  for (const file of files) {
    if (!Number.isSafeInteger(totalBytes + file.bytes)) {
      throw new NativeMediaInputError('The native media bundle byte total cannot be represented safely.')
    }
    totalBytes += file.bytes
  }
  return {
    sessionId: value.sessionId,
    bundleId: value.bundleId,
    expectedProvider: value.expectedProvider,
    expectedModel: value.expectedModel,
    files,
    totalBytes,
  }
}

function sameFile(left: NativeMediaFileDeclaration, right: NativeMediaFileDeclaration): boolean {
  return left.name === right.name && left.bytes === right.bytes
    && left.modality === right.modality && left.mediaType === right.mediaType
    && left.format === right.format
}

function sameBegin(entry: PendingBundle, request: NormalizedBeginRequest): boolean {
  return entry.sessionId === request.sessionId && entry.bundleId === request.bundleId
    && entry.expectedProvider === request.expectedProvider
    && entry.expectedModel === request.expectedModel
    && entry.files.length === request.files.length
    && entry.files.every((file, index) => sameFile(file, request.files[index]!))
}

function messageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`
}

/**
 * Process-local coordinator plus a durable armed-manifest mirror. Selection
 * only stages bytes; a bundle still needs its own marker and an exact inbox
 * message claim before pre-step code may materialize it into message content.
 */
export class NativeMediaStaging {
  readonly ttlMs: number
  private readonly now: () => number
  private readonly mintFileId: () => string
  private readonly manifestRoot: string
  private readonly bundles = new Map<string, PendingBundle>()
  private readonly messages = new Map<string, Set<string>>()
  private readonly retiring = new Set<PendingBundle>()
  private manifestReady: Promise<void> | undefined
  private recovery: Promise<void> | undefined
  private expiryTimer: ReturnType<typeof setInterval> | undefined
  private beginTail: Promise<void> = Promise.resolve()
  private sweepTail: Promise<void> = Promise.resolve()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly shutdown = new AbortController()
  private closing = false
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(readonly store: OriginalMediaStore, options: NativeMediaStagingOptions = {}) {
    this.ttlMs = options.ttlMs ?? NATIVE_MEDIA_BUNDLE_TTL_MS
    this.now = options.now ?? Date.now
    this.mintFileId = options.mintFileId ?? (() => randomBytes(16).toString('hex'))
    this.manifestRoot = join(store.root, '.native-bundles', 'v1')
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Invalid native media bundle lifetime.')
    }
  }

  private enterOperation(): () => void {
    if (this.closing || this.disposed) throw new NativeMediaLifecycleError()
    let resolve!: () => void
    const marker = new Promise<void>(done => { resolve = done })
    this.inFlight.add(marker)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.inFlight.delete(marker)
      resolve()
    }
  }

  private operationSignal(external?: AbortSignal): AbortSignal {
    return external === undefined ? this.shutdown.signal : AbortSignal.any([external, this.shutdown.signal])
  }

  private async whenOperationsIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  private async serializedBegin<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.beginTail
    let release!: () => void
    this.beginTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private ensureManifestRoot(): Promise<void> {
    this.manifestReady ??= mkdir(this.manifestRoot, { recursive: true }).then(() => undefined)
      .catch(cause => {
        this.manifestReady = undefined
        throw new NativeMediaInputError('The durable native media manifest directory is unavailable.', { cause })
      })
    return this.manifestReady
  }

  private manifestPath(bundleId: string): string {
    if (!isNativeMediaBundleId(bundleId)) throw new NativeMediaInputError('The native media bundle id is invalid.')
    return join(this.manifestRoot, `${bundleId}.json`)
  }

  private manifestOf(entry: PendingBundle, phase: 'armed' | 'materialized'): DurableManifest {
    return {
      version: MANIFEST_VERSION,
      bundleId: entry.bundleId,
      sessionId: entry.sessionId,
      expectedProvider: entry.expectedProvider,
      expectedModel: entry.expectedModel,
      createdAt: entry.createdAt,
      phase,
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
      files: entry.files.map(file => ({
        fileId: file.fileId,
        name: file.name,
        bytes: file.bytes,
        modality: file.modality,
        mediaType: file.mediaType,
        ...(file.format === undefined ? {} : { format: file.format }),
        sha256: file.sha256!,
        attachment: file.attachment!,
      })),
    }
  }

  private async persistManifest(entry: PendingBundle, phase: 'armed' | 'materialized'): Promise<void> {
    await this.ensureManifestRoot()
    const target = this.manifestPath(entry.bundleId)
    const temporary = join(this.manifestRoot, `.${entry.bundleId}.${randomBytes(16).toString('hex')}.tmp`)
    let file: Awaited<ReturnType<typeof open>> | undefined
    let published = false
    try {
      file = await open(temporary, 'wx', 0o600)
      await file.writeFile(`${JSON.stringify(this.manifestOf(entry, phase))}\n`, 'utf8')
      await file.sync()
      await file.close()
      file = undefined
      await rename(temporary, target)
      published = true
    } catch (cause) {
      throw new NativeMediaInputError('The durable native media manifest could not be stored.', { cause })
    } finally {
      if (file !== undefined) await file.close().catch(() => undefined)
      if (!published) await unlink(temporary).catch(() => undefined)
    }
  }

  private async deleteManifest(bundleId: string): Promise<void> {
    await this.ensureManifestRoot()
    await unlink(this.manifestPath(bundleId)).catch(cause => {
      if (systemCode(cause) !== 'ENOENT') {
        throw new NativeMediaInputError('The durable native media manifest could not be retired.', { cause })
      }
    })
  }

  private parseManifest(value: unknown, expectedBundleId: string): PendingBundle | undefined {
    const manifestKeys = new Set([
      'bundleId', 'createdAt', 'expectedModel', 'expectedProvider', 'files',
      'messageId', 'phase', 'sessionId', 'version',
    ])
    if (!plainRecord(value) || Object.keys(value).some(key => !manifestKeys.has(key))
      || value.version !== MANIFEST_VERSION
      || value.bundleId !== expectedBundleId || !isNativeMediaBundleId(value.bundleId)
      || !validIdentity(value.sessionId, SESSION_ID_MAX_CHARS)
      || !validIdentity(value.expectedProvider, SELECTION_ID_MAX_CHARS)
      || !validIdentity(value.expectedModel, SELECTION_ID_MAX_CHARS)
      || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
      || (value.phase !== 'armed' && value.phase !== 'materialized')
      || (value.messageId !== undefined && !validIdentity(value.messageId, MESSAGE_ID_MAX_CHARS))
      || !Array.isArray(value.files) || value.files.length === 0) return undefined
    if (value.phase === 'materialized' && value.messageId === undefined) return undefined
    const files: PendingFile[] = []
    const fileIds = new Set<string>()
    for (const raw of value.files) {
      const fileKeys = new Set([
        'attachment', 'bytes', 'fileId', 'format', 'mediaType', 'modality', 'name', 'sha256',
      ])
      if (!plainRecord(raw) || Object.keys(raw).some(key => !fileKeys.has(key))
        || !validFileId(raw.fileId) || fileIds.has(raw.fileId)
        || typeof raw.sha256 !== 'string' || !SHA256_PATTERN.test(raw.sha256)) return undefined
      fileIds.add(raw.fileId)
      let normalized: NormalizedFile
      try {
        normalized = normalizeFile({
          name: raw.name,
          bytes: raw.bytes,
          modality: raw.modality,
          mediaType: raw.mediaType,
          ...(raw.format === undefined ? {} : { format: raw.format }),
        })
      } catch {
        return undefined
      }
      const attachmentKeys = new Set(['attachmentId', 'bytes', 'name'])
      if (!plainRecord(raw.attachment)
        || Object.keys(raw.attachment).some(key => !attachmentKeys.has(key))
        || raw.attachment.name !== normalized.name || raw.attachment.bytes !== normalized.bytes
        || typeof raw.attachment.attachmentId !== 'string'
        || !raw.attachment.attachmentId.endsWith(raw.sha256)
        || !this.store.owns(raw.attachment as unknown as OriginalMediaAttachmentRef)) return undefined
      files.push({
        ...normalized,
        fileId: raw.fileId,
        receivedBytes: normalized.bytes,
        appending: false,
        sha256: raw.sha256,
        attachment: raw.attachment as unknown as OriginalMediaAttachmentRef,
      })
    }
    const entry: PendingBundle = {
      bundleId: value.bundleId,
      sessionId: value.sessionId,
      expectedProvider: value.expectedProvider,
      expectedModel: value.expectedModel,
      files,
      createdAt: value.createdAt as number,
      expiresAt: Number.MAX_SAFE_INTEGER,
      phase: value.phase,
      ...(value.messageId === undefined ? {} : { messageId: value.messageId }),
    }
    if (entry.phase === 'materialized') entry.materialized = this.materializedOf(entry)
    return entry
  }

  private async recoverManifests(): Promise<void> {
    await this.ensureManifestRoot()
    const names = await readdir(this.manifestRoot)
    const recovered: PendingBundle[] = []
    for (const name of names) {
      if (/^\.[a-f0-9]{32}\.[a-f0-9]{32}\.tmp$/u.test(name)) {
        await unlink(join(this.manifestRoot, name)).catch(() => undefined)
        continue
      }
      const match = /^([a-f0-9]{32})\.json$/u.exec(name)
      if (match === null) continue
      let entry: PendingBundle | undefined
      try {
        entry = this.parseManifest(JSON.parse(await readFile(join(this.manifestRoot, name), 'utf8')), match[1]!)
      } catch {
        entry = undefined
      }
      if (entry === undefined) {
        await unlink(join(this.manifestRoot, name)).catch(() => undefined)
        continue
      }
      recovered.push(entry)
    }
    recovered.sort((left, right) => right.createdAt - left.createdAt || left.bundleId.localeCompare(right.bundleId))
    for (const entry of recovered) {
      if (this.bundles.has(entry.bundleId)) {
        await this.deleteManifest(entry.bundleId).catch(() => undefined)
        continue
      }
      this.bundles.set(entry.bundleId, entry)
      if (entry.messageId !== undefined) {
        const key = messageKey(entry.sessionId, entry.messageId)
        const claimed = this.messages.get(key) ?? new Set<string>()
        claimed.add(entry.bundleId)
        this.messages.set(key, claimed)
      }
    }
  }

  private ensureRecovered(): Promise<void> {
    this.recovery ??= this.recoverManifests().catch(cause => {
      this.recovery = undefined
      if (cause instanceof NativeMediaInputError) throw cause
      throw new NativeMediaInputError('Durable native media manifests could not be recovered.', { cause })
    })
    return this.recovery
  }

  private mintUniqueFileId(reserved: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = this.mintFileId()
      if (FILE_ID_PATTERN.test(candidate) && !reserved.has(candidate)) return candidate
    }
    throw new Error('Secure native media file id generation failed.')
  }

  private remove(entry: PendingBundle): boolean {
    if (!this.bundles.delete(entry.bundleId)) return false
    if (entry.messageId !== undefined) {
      const key = messageKey(entry.sessionId, entry.messageId)
      const claimed = this.messages.get(key)
      claimed?.delete(entry.bundleId)
      if (claimed?.size === 0) this.messages.delete(key)
    }
    return true
  }

  private async discardParts(entry: PendingBundle): Promise<void> {
    const results = await Promise.allSettled(entry.files.map(file => file.stagingToken === undefined
      ? Promise.resolve()
      : this.store.discardStaging(file.stagingToken)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  private async retire(entry: PendingBundle): Promise<void> {
    const previousPhase = entry.phase
    this.retiring.add(entry)
    entry.phase = 'materializing'
    try {
      await this.deleteManifest(entry.bundleId)
      await this.discardParts(entry)
      this.remove(entry)
    } catch (cause) {
      entry.phase = previousPhase
      throw cause
    } finally {
      this.retiring.delete(entry)
    }
  }

  private busy(entry: PendingBundle): boolean {
    return entry.phase === 'committing' || entry.phase === 'materializing'
      || entry.files.some(file => file.appending)
  }

  async sweepExpired(signal?: AbortSignal): Promise<void> {
    await this.ensureRecovered()
    signal?.throwIfAborted()
    const now = this.now()
    for (const entry of this.bundles.values()) {
      if (entry.phase !== 'uploading' || entry.expiresAt > now || this.busy(entry)) continue
      await this.retire(entry).catch(() => undefined)
    }
    signal?.throwIfAborted()
  }

  startExpirySweep(): () => void {
    if (this.closing || this.disposed) throw new NativeMediaLifecycleError()
    if (this.expiryTimer !== undefined) throw new Error('Native media expiry sweep is already running.')
    const interval = Math.max(1, Math.min(this.ttlMs, 60_000))
    const timer = setInterval(() => {
      this.sweepTail = this.sweepTail
        .then(() => this.sweepExpired(this.shutdown.signal))
        .catch(() => undefined)
    }, interval)
    timer.unref?.()
    this.expiryTimer = timer
    let active = true
    return () => {
      if (!active) return
      active = false
      clearInterval(timer)
      if (this.expiryTimer === timer) this.expiryTimer = undefined
    }
  }

  whenSweepIdle(): Promise<void> {
    return this.sweepTail
  }

  pendingCount(): number {
    return this.bundles.size
  }

  private handle(entry: PendingBundle): NativeMediaBundleHandle {
    return {
      bundleId: entry.bundleId,
      marker: formatNativeMediaMarker(entry.bundleId),
      files: entry.files.map(file => ({
        fileId: file.fileId,
        name: file.name,
        bytes: file.bytes,
        modality: file.modality,
        mediaType: file.mediaType,
        ...(file.format === undefined ? {} : { format: file.format }),
      })),
    }
  }

  private armedOf(entry: PendingBundle): NativeMediaArmedBundle {
    return {
      bundleId: entry.bundleId,
      marker: formatNativeMediaMarker(entry.bundleId),
      label: this.labelOf(entry),
      state: 'ready',
      sessionId: entry.sessionId,
      expectedProvider: entry.expectedProvider,
      expectedModel: entry.expectedModel,
      files: entry.files.map(file => ({
        fileId: file.fileId,
        name: file.name,
        bytes: file.bytes,
        modality: file.modality,
        mediaType: file.mediaType,
        ...(file.format === undefined ? {} : { format: file.format }),
        sha256: file.sha256!,
      })),
    }
  }

  private materializedOf(entry: PendingBundle): MaterializedNativeMediaBundle {
    const files = entry.files.map(file => Object.freeze({
      fileId: file.fileId,
      name: file.name,
      bytes: file.bytes,
      modality: file.modality,
      mediaType: file.mediaType,
      ...(file.format === undefined ? {} : { format: file.format }),
      sha256: file.sha256!,
      attachment: Object.freeze({ ...file.attachment! }),
    }))
    return Object.freeze({
      bundleId: entry.bundleId,
      marker: formatNativeMediaMarker(entry.bundleId),
      sessionId: entry.sessionId,
      messageId: entry.messageId!,
      expectedProvider: entry.expectedProvider,
      expectedModel: entry.expectedModel,
      files: Object.freeze(files),
    })
  }

  private labelOf(entry: PendingBundle): string {
    const first = entry.files[0]!.name
    return entry.files.length === 1 ? first : `${first} +${entry.files.length - 1}`
  }

  private statusOf(entry: PendingBundle): NativeMediaBundleStatus {
    return {
      bundleId: entry.bundleId,
      marker: formatNativeMediaMarker(entry.bundleId),
      label: this.labelOf(entry),
      state: entry.messageId === undefined ? 'ready' : 'claimed',
      expectedProvider: entry.expectedProvider,
      expectedModel: entry.expectedModel,
      phase: entry.phase,
      files: entry.files.map(file => ({
        fileId: file.fileId,
        receivedBytes: file.receivedBytes,
        bytes: file.bytes,
      })),
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
    }
  }

  async begin(requestValue: unknown, signal?: AbortSignal): Promise<NativeMediaBundleHandle> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      const request = normalizeBegin(requestValue)
      return await this.serializedBegin(async () => {
        await this.ensureRecovered()
        await this.sweepExpired(activeSignal)
        activeSignal.throwIfAborted()
        const existing = this.bundles.get(request.bundleId)
        if (existing !== undefined) {
          if (sameBegin(existing, request)) return this.handle(existing)
          throw new NativeMediaInputError('The native media bundle id is already in use.')
        }
        let reservedBytes = request.totalBytes
        for (const pending of this.bundles.values()) {
          if (pending.phase !== 'uploading') continue
          for (const file of pending.files) {
            const remaining = file.bytes - file.receivedBytes
            if (!Number.isSafeInteger(reservedBytes + remaining)) {
              throw new NativeMediaInputError('The native media staging reservation cannot be represented safely.')
            }
            reservedBytes += remaining
          }
        }
        const reserved = new Set<string>()
        const files: PendingFile[] = request.files.map(file => {
          const fileId = this.mintUniqueFileId(reserved)
          reserved.add(fileId)
          return {
            ...file,
            fileId,
            stagingToken: createHash('sha256')
              .update(request.bundleId).update('\u0000').update(fileId).digest('hex'),
            hasher: createHash('sha256'),
            receivedBytes: 0,
            appending: false,
          }
        })
        const created: PendingFile[] = []
        try {
          // Aggregate free-space admission is a live volume guard, not a
          // plugin-defined media-size threshold. Each append rechecks again.
          for (const file of files) {
            await this.store.beginStaging(file.stagingToken!, reservedBytes, activeSignal)
            created.push(file)
          }
          activeSignal.throwIfAborted()
        } catch (cause) {
          await Promise.all(created.map(file => this.store.discardStaging(file.stagingToken!).catch(() => undefined)))
          throw cause
        }
        const timestamp = this.now()
        const entry: PendingBundle = {
          bundleId: request.bundleId,
          sessionId: request.sessionId,
          expectedProvider: request.expectedProvider,
          expectedModel: request.expectedModel,
          files,
          createdAt: timestamp,
          expiresAt: timestamp + this.ttlMs,
          phase: 'uploading',
        }
        this.bundles.set(entry.bundleId, entry)
        return this.handle(entry)
      })
    } finally {
      leave()
    }
  }

  async append(requestValue: unknown, signal?: AbortSignal): Promise<{ readonly receivedBytes: number }> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      if (!plainRecord(requestValue)
        || Object.keys(requestValue).some(key => !['bundleId', 'data', 'fileId', 'offset', 'sessionId'].includes(key))
        || !validIdentity(requestValue.sessionId, SESSION_ID_MAX_CHARS)
        || !isNativeMediaBundleId(requestValue.bundleId) || !validFileId(requestValue.fileId)
        || !Number.isSafeInteger(requestValue.offset) || (requestValue.offset as number) < 0
        || !(requestValue.data instanceof Uint8Array) || requestValue.data.byteLength === 0) {
        throw new NativeMediaInputError('The native media append request is invalid.')
      }
      await this.ensureRecovered()
      await this.sweepExpired(activeSignal)
      activeSignal.throwIfAborted()
      const entry = this.bundles.get(requestValue.bundleId)
      if (entry === undefined || entry.sessionId !== requestValue.sessionId || entry.phase !== 'uploading') {
        throw new NativeMediaInputError('The native media bundle is invalid or unavailable.')
      }
      const file = entry.files.find(candidate => candidate.fileId === requestValue.fileId)
      if (file === undefined || file.appending) {
        throw new NativeMediaInputError('The native media file is invalid or busy.')
      }
      const offset = requestValue.offset as number
      const source = requestValue.data as Uint8Array
      if (offset !== file.receivedBytes || !Number.isSafeInteger(offset + source.byteLength)
        || offset + source.byteLength > file.bytes) {
        throw new NativeMediaInputError('Native media chunks must be complete and strictly sequential per file.')
      }
      const chunk = Uint8Array.from(source)
      file.appending = true
      try {
        await this.store.appendStaging(file.stagingToken!, offset, chunk, activeSignal)
        activeSignal.throwIfAborted()
        file.hasher!.update(chunk)
        file.receivedBytes += chunk.byteLength
        entry.expiresAt = this.now() + this.ttlMs
        return { receivedBytes: file.receivedBytes }
      } catch (cause) {
        await this.retire(entry).catch(() => undefined)
        throw cause
      } finally {
        file.appending = false
        chunk.fill(0)
      }
    } finally {
      leave()
    }
  }

  private async commitEntry(entry: PendingBundle, signal: AbortSignal): Promise<NativeMediaArmedBundle> {
    const hashes = entry.files.map(file => file.hasher!.digest('hex'))
    try {
      await Promise.all(entry.files.map((file, index) => this.store.verifyStaging(
        file.stagingToken!, file.bytes, hashes[index]!, signal,
      )))
      signal.throwIfAborted()
      const attachments: OriginalMediaAttachmentRef[] = []
      for (let index = 0; index < entry.files.length; index++) {
        const file = entry.files[index]!
        attachments.push(await this.store.commitNamedStaging(
          file.stagingToken!, file.bytes, hashes[index]!, file.name, signal,
        ))
      }
      for (let index = 0; index < entry.files.length; index++) {
        const file = entry.files[index]!
        file.sha256 = hashes[index]!
        file.attachment = attachments[index]!
        file.hasher = undefined
      }
      entry.expiresAt = Number.MAX_SAFE_INTEGER
      // The durable manifest is the publication boundary across process
      // restarts. In-memory armed state is assigned only after its rename.
      await this.persistManifest(entry, 'armed')
      entry.phase = 'armed'
      return this.armedOf(entry)
    } catch (cause) {
      await this.retire(entry).catch(() => undefined)
      throw cause
    }
  }

  async commit(sessionId: string, bundleId: string, signal?: AbortSignal): Promise<NativeMediaArmedBundle> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      await this.ensureRecovered()
      await this.sweepExpired(activeSignal)
      activeSignal.throwIfAborted()
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !isNativeMediaBundleId(bundleId)) {
        throw new NativeMediaInputError('The native media commit request is invalid.')
      }
      const entry = this.bundles.get(bundleId)
      if (entry === undefined || entry.sessionId !== sessionId) {
        throw new NativeMediaInputError('The native media bundle is invalid or unavailable.')
      }
      if (entry.phase === 'armed' || entry.phase === 'materializing' || entry.phase === 'materialized') {
        return this.armedOf(entry)
      }
      if (entry.phase === 'committing') return entry.commitPromise!
      if (entry.files.some(file => file.appending || file.receivedBytes !== file.bytes)) {
        throw new NativeMediaInputError('The native media bundle upload is incomplete.')
      }
      entry.phase = 'committing'
      const operation = this.commitEntry(entry, activeSignal)
      entry.commitPromise = operation
      return await operation
    } finally {
      leave()
    }
  }

  /** Bind one durable bundle marker to one exact durable UserMessage id. */
  async claim(
    sessionId: string,
    bundleId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<NativeMediaClaim | undefined> {
    const claims = await this.claimMany(sessionId, [bundleId], messageId, signal)
    return claims?.[0]
  }

  /** Validate every marker first, then bind all bundles to the same message. */
  async claimMany(
    sessionId: string,
    bundleIds: readonly string[],
    messageId: string,
    signal?: AbortSignal,
  ): Promise<readonly NativeMediaClaim[] | undefined> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      await this.ensureRecovered()
      await this.sweepExpired(activeSignal)
      activeSignal.throwIfAborted()
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || bundleIds.length === 0
        || bundleIds.some(bundleId => !isNativeMediaBundleId(bundleId))
        || new Set(bundleIds).size !== bundleIds.length
        || !validIdentity(messageId, MESSAGE_ID_MAX_CHARS)) {
        throw new NativeMediaInputError('The native media claim is invalid.')
      }
      const entries: PendingBundle[] = []
      for (const bundleId of bundleIds) {
        const entry = this.bundles.get(bundleId)
        if (entry === undefined || entry.sessionId !== sessionId || this.retiring.has(entry)
          || (entry.phase !== 'armed' && entry.phase !== 'materializing' && entry.phase !== 'materialized')) return undefined
        if (entry.messageId !== undefined && entry.messageId !== messageId) throw new NativeMediaClaimError()
        entries.push(entry)
      }

      const key = messageKey(sessionId, messageId)
      const claimed = this.messages.get(key) ?? new Set<string>()
      const newlyBound = entries.filter(entry => entry.messageId === undefined)
      for (const entry of newlyBound) {
        entry.messageId = messageId
        claimed.add(entry.bundleId)
      }
      if (newlyBound.length > 0) this.messages.set(key, claimed)
      try {
        await Promise.all(newlyBound.map(entry => this.persistManifest(
          entry, entry.phase === 'materialized' ? 'materialized' : 'armed',
        )))
      } catch (cause) {
        for (const entry of newlyBound) {
          entry.messageId = undefined
          claimed.delete(entry.bundleId)
        }
        if (claimed.size === 0) this.messages.delete(key)
        await Promise.all(newlyBound.map(entry => this.persistManifest(
          entry, entry.phase === 'materialized' ? 'materialized' : 'armed',
        ).catch(() => undefined)))
        throw cause
      }
      return entries.map(entry => ({
        bundleId: entry.bundleId,
        marker: formatNativeMediaMarker(entry.bundleId),
        sessionId,
        messageId,
      }))
    } finally {
      leave()
    }
  }

  private async materializeEntry(entry: PendingBundle, signal: AbortSignal): Promise<MaterializedNativeMediaBundle> {
    try {
      signal.throwIfAborted()
      const materialized = this.materializedOf(entry)
      entry.materialized = materialized
      await this.persistManifest(entry, 'materialized')
      entry.phase = 'materialized'
      return materialized
    } catch (cause) {
      entry.phase = 'armed'
      entry.materializePromise = undefined
      throw cause
    }
  }

  /** Resolve only this exact marker/message pair and recheck provider/model. */
  async materialize(
    sessionId: string,
    bundleId: string,
    messageId: string,
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<MaterializedNativeMediaBundle | undefined> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      await this.ensureRecovered()
      await this.sweepExpired(activeSignal)
      activeSignal.throwIfAborted()
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !isNativeMediaBundleId(bundleId)
        || !validIdentity(messageId, MESSAGE_ID_MAX_CHARS)
        || !validIdentity(provider, SELECTION_ID_MAX_CHARS)
        || !validIdentity(model, SELECTION_ID_MAX_CHARS)) {
        throw new NativeMediaInputError('The native media materialization request is invalid.')
      }
      const mappedBundles = this.messages.get(messageKey(sessionId, messageId))
      if (!mappedBundles?.has(bundleId)) return undefined
      const entry = this.bundles.get(bundleId)
      if (entry === undefined || entry.sessionId !== sessionId || entry.messageId !== messageId) return undefined
      if (entry.expectedProvider !== provider || entry.expectedModel !== model) {
        await this.retire(entry).catch(() => undefined)
        throw new NativeMediaSelectionError()
      }
      if (entry.phase === 'materialized') return entry.materialized ?? this.materializedOf(entry)
      if (entry.phase === 'materializing') return entry.materializePromise!
      if (entry.phase !== 'armed') return undefined
      entry.phase = 'materializing'
      const operation = this.materializeEntry(entry, activeSignal)
      entry.materializePromise = operation
      return await operation
    } finally {
      leave()
    }
  }

  /** Delete the marker manifest only after the augmented message is durable. */
  async confirm(sessionId: string, bundleId: string, messageId: string): Promise<boolean> {
    const leave = this.enterOperation()
    try {
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !isNativeMediaBundleId(bundleId)
        || !validIdentity(messageId, MESSAGE_ID_MAX_CHARS)) return false
      await this.ensureRecovered()
      if (!this.messages.get(messageKey(sessionId, messageId))?.has(bundleId)) return false
      const entry = this.bundles.get(bundleId)
      if (entry === undefined || entry.phase !== 'materialized' || entry.messageId !== messageId) return false
      await this.deleteManifest(bundleId)
      this.remove(entry)
      return true
    } finally {
      leave()
    }
  }

  async status(
    sessionId: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<NativeMediaBundleStatus | undefined> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !isNativeMediaBundleId(bundleId)) return undefined
      await this.ensureRecovered()
      await this.sweepExpired(activeSignal)
      const entry = this.bundles.get(bundleId)
      return entry === undefined || entry.sessionId !== sessionId
        || entry.phase === 'uploading' || entry.phase === 'committing'
        ? undefined
        : this.statusOf(entry)
    } finally {
      leave()
    }
  }

  async list(sessionId: string, signal?: AbortSignal): Promise<readonly NativeMediaBundleStatus[]> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS)) return []
      await this.ensureRecovered()
      await this.sweepExpired(activeSignal)
      return [...this.bundles.values()]
        .filter(entry => entry.sessionId === sessionId
          && entry.phase !== 'uploading' && entry.phase !== 'committing')
        .map(entry => this.statusOf(entry))
    } finally {
      leave()
    }
  }

  private async discardOwned(
    sessionId: string,
    bundleId: string,
    messageId: string | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      await this.ensureRecovered()
      await this.sweepExpired(activeSignal)
      activeSignal.throwIfAborted()
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !isNativeMediaBundleId(bundleId)) return false
      const entry = this.bundles.get(bundleId)
      if (entry === undefined || entry.sessionId !== sessionId
        || entry.messageId !== messageId || this.busy(entry)) return false
      await this.retire(entry)
      activeSignal.throwIfAborted()
      return true
    } finally {
      leave()
    }
  }

  /** Draft deletion cannot retire a bundle bound to an accepted message. */
  async discard(sessionId: string, bundleId: string, signal?: AbortSignal): Promise<boolean> {
    return this.discardOwned(sessionId, bundleId, undefined, signal)
  }

  async discardClaim(
    sessionId: string,
    bundleId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !isNativeMediaBundleId(bundleId)
      || !validIdentity(messageId, MESSAGE_ID_MAX_CHARS)) return false
    return this.discardOwned(sessionId, bundleId, messageId, signal)
  }

  async discardUnclaimed(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS)) return false
    await this.ensureRecovered()
    const bundleIds = [...this.bundles.values()]
      .filter(entry => entry.sessionId === sessionId && entry.messageId === undefined)
      .map(entry => entry.bundleId)
    const results = await Promise.all(bundleIds.map(bundleId => this.discard(sessionId, bundleId, signal)))
    return results.some(Boolean)
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.closing = true
    this.shutdown.abort(new NativeMediaLifecycleError())
    if (this.expiryTimer !== undefined) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = undefined
    }
    this.disposePromise = (async () => {
      try {
        await Promise.all([this.whenOperationsIdle(), this.beginTail, this.sweepTail])
        const partial = [...this.bundles.values()].filter(entry => entry.phase === 'uploading')
        this.bundles.clear()
        this.messages.clear()
        const cleanup = await Promise.allSettled(partial.flatMap(entry => (
          entry.files.flatMap(file => file.stagingToken === undefined
            ? []
            : [this.store.discardStaging(file.stagingToken)])
        )))
        await this.store.disposeStagingInstance()
        const failed = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed !== undefined) throw failed.reason
      } finally {
        this.disposed = true
      }
    })()
    return this.disposePromise
  }
}
