import { constants as bufferConstants } from 'node:buffer'
import { createHash, randomBytes, type Hash } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'

import {
  NATIVE_MEDIA_PROTOCOL_VERSION,
  NATIVE_MEDIA_RECOMMENDED_CHUNK_BYTES,
  type NativeMediaBundleSummary,
} from './native-media-protocol.js'
import {
  NativeMediaInputError,
  NativeMediaLifecycleError,
  type NativeMediaStaging,
} from './native-media-staging.js'
import type { OriginalVideoAttachmentRef } from './original-media-store.js'
import { OriginalMediaStore, OriginalMediaStoreCapacityError } from './original-media-store.js'

export const ORIGINAL_MEDIA_PROTOCOL_VERSION = 2
/** Per-RPC transport ceiling only; a file may contain any number of chunks. */
export const ORIGINAL_MEDIA_MAX_CHUNK_BYTES = 1024 * 1024
/** Preferred chunk size retained for protocol-v2 client compatibility. */
export const ORIGINAL_MEDIA_RECOMMENDED_CHUNK_BYTES = ORIGINAL_MEDIA_MAX_CHUNK_BYTES
export const ORIGINAL_MEDIA_MAX_ACTIVE_STAGINGS = 8
export const ORIGINAL_MEDIA_TOKEN_TTL_MS = 5 * 60 * 1000

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u
const NATIVE_BUNDLE_PATTERN = /^[a-f0-9]{32}$/u
const NATIVE_FILE_PATTERN = /^[a-f0-9]{32}$/u
const SESSION_ID_MAX_CHARS = 512
const SUBMISSION_ID_MAX_CHARS = 128
const FILE_NAME_MAX_CHARS = 255
const PROMPT_MAX_CHARS = 65_536
const SELECTION_ID_MAX_CHARS = 512
const MP4_DATA_URL_PREFIX = 'data:video/mp4;base64,'
const MAX_MP4_DATA_URL_BYTES = Math.floor(
  (bufferConstants.MAX_STRING_LENGTH - MP4_DATA_URL_PREFIX.length) / 4,
) * 3
const PROCESS_ACTIVE_TOKENS = new Map<string, string>()
const PROCESS_ACTIVE_SESSIONS = new Map<string, string>()

type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: {
    readonly code: 'bad-request' | 'cancelled' | 'resource-exhausted' | 'internal'
    readonly message: string
    readonly details: Record<string, unknown>
  } }

type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>

interface HostConnection {
  readonly rpc?: {
    readonly handle?: (channel: string, handler: RpcHandler, options: { readonly authority: 'loopback' }) => () => Promise<void>
  }
}

export interface OriginalVideoBeginRequest {
  readonly sessionId: string
  readonly name: string
  readonly mediaType: 'video/mp4'
  readonly bytes: number
  readonly prompt: string
  readonly clientSubmissionId: string
  readonly expectedProvider: string
  readonly expectedModel: string
}

export interface StagedOriginalVideo {
  readonly sessionId: string
  readonly attachment: OriginalVideoAttachmentRef
  readonly sha256: string
  readonly prompt: string
  readonly expectedProvider: string
  readonly expectedModel: string
}

export class MediaFallbackInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaFallbackInputError'
  }
}

export class MediaFallbackSelectionError extends Error {
  constructor() {
    super('The selected provider or model changed after the original MP4 upload began.')
    this.name = 'MediaFallbackSelectionError'
  }
}

export class MediaFallbackLifecycleError extends Error {
  constructor() {
    super('The original-media staging service is closing.')
    this.name = 'MediaFallbackLifecycleError'
  }
}

type PendingPhase = 'uploading' | 'appending' | 'verifying' | 'committed'

interface PendingEntry {
  readonly sessionId: string
  readonly name: string
  readonly declaredBytes: number
  readonly prompt: string
  readonly expectedProvider: string
  readonly expectedModel: string
  readonly submissionKey: string
  readonly hasher: Hash
  sha256?: string
  receivedBytes: number
  expiresAt: number
  phase: PendingPhase
}

export interface OriginalVideoStagingOptions {
  readonly now?: () => number
  readonly mintToken?: () => string
  readonly ttlMs?: number
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function validIdentity(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function canonicalBase64(value: string, subject = 'MP4'): Uint8Array {
  const maximumEncodedChars = 4 * Math.ceil(ORIGINAL_MEDIA_MAX_CHUNK_BYTES / 3)
  if (value.length > maximumEncodedChars) {
    throw new MediaFallbackInputError(`The ${subject} chunk exceeds the 1 MiB per-request transport ceiling.`)
  }
  if (value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new MediaFallbackInputError(`The ${subject} chunk must use canonical base64 encoding.`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength > ORIGINAL_MEDIA_MAX_CHUNK_BYTES) {
    decoded.fill(0)
    throw new MediaFallbackInputError(`The ${subject} chunk exceeds the 1 MiB per-request transport ceiling.`)
  }
  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) {
    decoded.fill(0)
    throw new MediaFallbackInputError(`The ${subject} chunk must use canonical base64 encoding.`)
  }
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength)
}

function parseBegin(payload: unknown): OriginalVideoBeginRequest {
  const keys = [
    'bytes', 'clientSubmissionId', 'expectedModel', 'expectedProvider', 'mediaType', 'name', 'prompt', 'sessionId',
  ] as const
  if (!plainRecord(payload) || !exactKeys(payload, keys)
    || !validIdentity(payload.sessionId, SESSION_ID_MAX_CHARS)
    || payload.mediaType !== 'video/mp4'
    || !Number.isSafeInteger(payload.bytes) || (payload.bytes as number) <= 0
    || (payload.bytes as number) > bufferConstants.MAX_LENGTH
    || (payload.bytes as number) > MAX_MP4_DATA_URL_BYTES
    || typeof payload.prompt !== 'string' || payload.prompt.length > PROMPT_MAX_CHARS
    || !validIdentity(payload.clientSubmissionId, SUBMISSION_ID_MAX_CHARS)
    || !validIdentity(payload.expectedProvider, SELECTION_ID_MAX_CHARS)
    || !validIdentity(payload.expectedModel, SELECTION_ID_MAX_CHARS)
    || typeof payload.name !== 'string' || payload.name.length === 0 || payload.name.length > FILE_NAME_MAX_CHARS
    || /[\\/\u0000-\u001f\u007f]/u.test(payload.name)) {
    throw new MediaFallbackInputError('The original MP4 begin request is invalid.')
  }
  return payload as unknown as OriginalVideoBeginRequest
}

function parseTokenRequest(payload: unknown, endpoint: string): { sessionId: string; token: string } {
  if (!plainRecord(payload) || !exactKeys(payload, ['sessionId', 'token'])
    || !validIdentity(payload.sessionId, SESSION_ID_MAX_CHARS)
    || typeof payload.token !== 'string' || !TOKEN_PATTERN.test(payload.token)) {
    throw new MediaFallbackInputError(`The original-media ${endpoint} request is invalid.`)
  }
  return { sessionId: payload.sessionId, token: payload.token }
}

function sameBegin(entry: PendingEntry, request: OriginalVideoBeginRequest): boolean {
  return entry.sessionId === request.sessionId && entry.declaredBytes === request.bytes
    && entry.name === request.name && entry.prompt === request.prompt
    && entry.expectedProvider === request.expectedProvider && entry.expectedModel === request.expectedModel
}

export class MediaFallbackResourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaFallbackResourceError'
  }
}

/** Disk-backed, process-local handoff from loopback RPC to the token command. */
export class OriginalVideoStaging {
  readonly ttlMs: number
  private readonly now: () => number
  private readonly mintToken: () => string
  private readonly pending = new Map<string, PendingEntry>()
  private readonly submissions = new Map<string, string>()
  private expiryTimer: ReturnType<typeof setInterval> | undefined
  private beginTail: Promise<void> = Promise.resolve()
  private sweepTail: Promise<void> = Promise.resolve()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly shutdown = new AbortController()
  private closing = false
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(readonly store: OriginalMediaStore, options: OriginalVideoStagingOptions = {}) {
    this.ttlMs = options.ttlMs ?? ORIGINAL_MEDIA_TOKEN_TTL_MS
    this.now = options.now ?? Date.now
    this.mintToken = options.mintToken ?? (() => randomBytes(32).toString('hex'))
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error('Invalid original-video token lifetime.')
  }

  private remove(token: string, entry: PendingEntry): void {
    if (!this.pending.delete(token)) return
    this.submissions.delete(entry.submissionKey)
    if (PROCESS_ACTIVE_TOKENS.get(token) === entry.sessionId) PROCESS_ACTIVE_TOKENS.delete(token)
    if (PROCESS_ACTIVE_SESSIONS.get(entry.sessionId) === token) PROCESS_ACTIVE_SESSIONS.delete(entry.sessionId)
  }

  private enterOperation(): () => void {
    if (this.closing || this.disposed) throw new MediaFallbackLifecycleError()
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

  private async whenOperationsIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  private operationSignal(external?: AbortSignal): AbortSignal {
    if (external === undefined) return this.shutdown.signal
    return AbortSignal.any([external, this.shutdown.signal])
  }

  private async pruneExpired(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const now = this.now()
    const expired: string[] = []
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt > now || entry.phase === 'appending' || entry.phase === 'verifying') continue
      this.remove(token, entry)
      expired.push(token)
    }
    // Once ownership is removed from the maps, cleanup must finish even when
    // shutdown arrives; otherwise dispose would no longer know this token.
    await Promise.all(expired.map(token => this.store.discardStaging(token).catch(() => undefined)))
    signal?.throwIfAborted()
  }

  /** Start bounded periodic expiry; the returned disposer owns the timer. */
  startExpirySweep(): () => void {
    if (this.closing || this.disposed) throw new MediaFallbackLifecycleError()
    if (this.expiryTimer !== undefined) throw new Error('Original-video expiry sweep is already running.')
    const interval = Math.max(1, Math.min(this.ttlMs, 60_000))
    const timer = setInterval(() => {
      this.sweepTail = this.sweepTail.then(() => this.pruneExpired(this.shutdown.signal)).catch(() => undefined)
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

  pendingCount(): number {
    return this.pending.size
  }

  whenSweepIdle(): Promise<void> {
    return this.sweepTail
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

  async begin(payload: unknown, signal?: AbortSignal): Promise<{ readonly token: string }> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      const request = parseBegin(payload)
      return await this.serializedBegin(async () => {
        await this.pruneExpired(activeSignal)
        activeSignal.throwIfAborted()
        const submissionKey = `${request.sessionId}\u0000${request.clientSubmissionId}`
        const existingToken = this.submissions.get(submissionKey)
        if (existingToken !== undefined) {
          const existing = this.pending.get(existingToken)
          if (existing !== undefined && sameBegin(existing, request)) {
            return { token: existingToken }
          }
          throw new MediaFallbackInputError('The media submission id is already in use.')
        }
        if (PROCESS_ACTIVE_SESSIONS.has(request.sessionId)) {
          throw new MediaFallbackInputError('This session already has an active original MP4 upload.')
        }
        if (PROCESS_ACTIVE_TOKENS.size >= ORIGINAL_MEDIA_MAX_ACTIVE_STAGINGS) {
          throw new MediaFallbackResourceError('This process already has the maximum number of active original MP4 uploads.')
        }
        let token: string | undefined
        for (let attempt = 0; attempt < 32; attempt++) {
          const candidate = this.mintToken()
          if (TOKEN_PATTERN.test(candidate) && !PROCESS_ACTIVE_TOKENS.has(candidate)) { token = candidate; break }
        }
        if (token === undefined) throw new Error('Secure staging token generation failed.')
        let requiredBytes = request.bytes
        for (const entry of this.pending.values()) {
          const remaining = entry.declaredBytes - entry.receivedBytes
          if (!Number.isSafeInteger(requiredBytes + remaining)) {
            throw new MediaFallbackResourceError('The local staging reservation cannot represent another original MP4 upload.')
          }
          requiredBytes += remaining
        }
        PROCESS_ACTIVE_TOKENS.set(token, request.sessionId)
        PROCESS_ACTIVE_SESSIONS.set(request.sessionId, token)
        try {
          await this.store.beginStaging(token, requiredBytes, activeSignal)
          activeSignal.throwIfAborted()
        } catch (error) {
          if (PROCESS_ACTIVE_TOKENS.get(token) === request.sessionId) PROCESS_ACTIVE_TOKENS.delete(token)
          if (PROCESS_ACTIVE_SESSIONS.get(request.sessionId) === token) PROCESS_ACTIVE_SESSIONS.delete(request.sessionId)
          await this.store.discardStaging(token).catch(() => undefined)
          throw error
        }
        const entry: PendingEntry = {
          sessionId: request.sessionId,
          name: request.name,
          declaredBytes: request.bytes,
          prompt: request.prompt,
          expectedProvider: request.expectedProvider,
          expectedModel: request.expectedModel,
          submissionKey,
          hasher: createHash('sha256'),
          receivedBytes: 0,
          expiresAt: this.now() + this.ttlMs,
          phase: 'uploading',
        }
        this.pending.set(token, entry)
        this.submissions.set(submissionKey, token)
        return { token }
      })
    } finally {
      leave()
    }
  }

  async append(payload: unknown, signal?: AbortSignal): Promise<{ readonly receivedBytes: number }> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      if (!plainRecord(payload) || !exactKeys(payload, ['data', 'offset', 'sessionId', 'token'])
      || !validIdentity(payload.sessionId, SESSION_ID_MAX_CHARS)
      || typeof payload.token !== 'string' || !TOKEN_PATTERN.test(payload.token)
      || !Number.isSafeInteger(payload.offset) || (payload.offset as number) < 0 || typeof payload.data !== 'string') {
        throw new MediaFallbackInputError('The original MP4 append request is invalid.')
      }
      await this.pruneExpired(activeSignal)
      activeSignal.throwIfAborted()
      const entry = this.pending.get(payload.token)
      if (entry === undefined || entry.sessionId !== payload.sessionId || entry.phase !== 'uploading') {
        throw new MediaFallbackInputError('The staged original MP4 token is invalid or unavailable.')
      }
      const chunk = canonicalBase64(payload.data)
      const offset = payload.offset as number
      if (offset !== entry.receivedBytes || !Number.isSafeInteger(offset + chunk.byteLength)
      || offset + chunk.byteLength > entry.declaredBytes) {
        chunk.fill(0)
        throw new MediaFallbackInputError('The original MP4 chunks must be complete and strictly sequential.')
      }
      entry.phase = 'appending'
      try {
        await this.store.appendStaging(payload.token, offset, chunk, activeSignal)
        activeSignal.throwIfAborted()
        entry.hasher.update(chunk)
        entry.receivedBytes += chunk.byteLength
        entry.expiresAt = this.now() + this.ttlMs
        entry.phase = 'uploading'
        return { receivedBytes: entry.receivedBytes }
      } catch (cause) {
        this.remove(payload.token, entry)
        await this.store.discardStaging(payload.token).catch(() => undefined)
        throw cause
      } finally {
        chunk.fill(0)
      }
    } finally {
      leave()
    }
  }

  async commit(sessionId: string, token: string, signal?: AbortSignal): Promise<{ readonly token: string; readonly sha256: string }> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      await this.pruneExpired(activeSignal)
      activeSignal.throwIfAborted()
      const entry = this.pending.get(token)
      if (entry === undefined || entry.sessionId !== sessionId) {
        throw new MediaFallbackInputError('The staged original MP4 token is invalid or unavailable.')
      }
      if (entry.phase === 'committed') return { token, sha256: entry.sha256! }
      if (entry.phase !== 'uploading' || entry.receivedBytes !== entry.declaredBytes) {
        throw new MediaFallbackInputError('The original MP4 upload is incomplete.')
      }
      entry.phase = 'verifying'
      try {
        const sha256 = entry.hasher.digest('hex')
        entry.sha256 = sha256
        await this.store.verifyStaging(token, entry.declaredBytes, sha256, activeSignal)
        activeSignal.throwIfAborted()
        entry.phase = 'committed'
        entry.expiresAt = this.now() + this.ttlMs
        return { token, sha256 }
      } catch (cause) {
        this.remove(token, entry)
        await this.store.discardStaging(token).catch(() => undefined)
        throw cause
      }
    } finally {
      leave()
    }
  }

  /** Atomically consume a committed token and publish its exact content-addressed file. */
  async take(
    sessionId: string,
    token: string,
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<StagedOriginalVideo | undefined> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      await this.pruneExpired(activeSignal)
      activeSignal.throwIfAborted()
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !TOKEN_PATTERN.test(token)) return undefined
      const entry = this.pending.get(token)
      if (entry === undefined || entry.sessionId !== sessionId || entry.phase !== 'committed') return undefined
      if (entry.expectedProvider !== provider || entry.expectedModel !== model) {
        throw new MediaFallbackSelectionError()
      }
      this.remove(token, entry)
      try {
        const sha256 = entry.sha256!
        const attachment = await this.store.commitStaging(token, entry.declaredBytes, sha256, activeSignal)
        activeSignal.throwIfAborted()
        return {
          sessionId, attachment, sha256, prompt: entry.prompt,
          expectedProvider: entry.expectedProvider, expectedModel: entry.expectedModel,
        }
      } catch (cause) {
        await this.store.discardStaging(token).catch(() => undefined)
        throw cause
      }
    } finally {
      leave()
    }
  }

  async discard(sessionId: string, token: string, signal?: AbortSignal): Promise<boolean> {
    const leave = this.enterOperation()
    try {
      const activeSignal = this.operationSignal(signal)
      await this.pruneExpired(activeSignal)
      activeSignal.throwIfAborted()
      if (!validIdentity(sessionId, SESSION_ID_MAX_CHARS) || !TOKEN_PATTERN.test(token)) return false
      const entry = this.pending.get(token)
      if (entry === undefined || entry.sessionId !== sessionId
        || entry.phase === 'appending' || entry.phase === 'verifying') return false
      this.remove(token, entry)
      try {
        await this.store.discardStaging(token, activeSignal)
        activeSignal.throwIfAborted()
        return true
      } catch (cause) {
        await this.store.discardStaging(token).catch(() => undefined)
        throw cause
      }
    } finally {
      leave()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.closing = true
    this.shutdown.abort(new MediaFallbackLifecycleError())
    if (this.expiryTimer !== undefined) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = undefined
    }
    this.disposePromise = (async () => {
      try {
        // Abort is observed at every async boundary we control. Node cannot
        // preempt a single fs promise already executing in libuv, so shutdown
        // deliberately waits for that finite platform syscall before cleanup.
        await Promise.all([this.whenOperationsIdle(), this.beginTail, this.sweepTail])
        const entries = [...this.pending.entries()]
        this.pending.clear()
        this.submissions.clear()
        for (const [token, entry] of entries) {
          if (PROCESS_ACTIVE_TOKENS.get(token) === entry.sessionId) PROCESS_ACTIVE_TOKENS.delete(token)
          if (PROCESS_ACTIVE_SESSIONS.get(entry.sessionId) === token) PROCESS_ACTIVE_SESSIONS.delete(entry.sessionId)
        }
        const cleanup = await Promise.allSettled(entries.map(([token]) => this.store.discardStaging(token)))
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

function success<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function cancelled(): RpcResult<never> {
  return { ok: false, error: { code: 'cancelled', message: 'The original-media request was cancelled.', details: {} } }
}

function resourceExhausted(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'resource-exhausted', message, details: {} } }
}

interface NativeBundleRequest {
  readonly sessionId: string
  readonly bundleId: string
}

interface NativeAppendRequest extends NativeBundleRequest {
  readonly fileId: string
  readonly offset: number
  readonly data: Uint8Array
}

function parseNativeBundleRequest(payload: unknown, endpoint: string): NativeBundleRequest {
  if (!plainRecord(payload) || !exactKeys(payload, ['bundleId', 'sessionId'])
    || !validIdentity(payload.sessionId, SESSION_ID_MAX_CHARS)
    || typeof payload.bundleId !== 'string' || !NATIVE_BUNDLE_PATTERN.test(payload.bundleId)) {
    throw new MediaFallbackInputError(`The native-media ${endpoint} request is invalid.`)
  }
  return { sessionId: payload.sessionId, bundleId: payload.bundleId }
}

function parseNativeListRequest(payload: unknown): { readonly sessionId: string } {
  if (!plainRecord(payload) || !exactKeys(payload, ['sessionId'])
    || !validIdentity(payload.sessionId, SESSION_ID_MAX_CHARS)) {
    throw new MediaFallbackInputError('The native-media list request is invalid.')
  }
  return { sessionId: payload.sessionId }
}

function parseNativeAppendRequest(payload: unknown): NativeAppendRequest {
  if (!plainRecord(payload) || !exactKeys(payload, ['bundleId', 'data', 'fileId', 'offset', 'sessionId'])
    || !validIdentity(payload.sessionId, SESSION_ID_MAX_CHARS)
    || typeof payload.bundleId !== 'string' || !NATIVE_BUNDLE_PATTERN.test(payload.bundleId)
    || typeof payload.fileId !== 'string' || !NATIVE_FILE_PATTERN.test(payload.fileId)
    || !Number.isSafeInteger(payload.offset) || (payload.offset as number) < 0
    || typeof payload.data !== 'string') {
    throw new MediaFallbackInputError('The native-media append request is invalid.')
  }
  return {
    sessionId: payload.sessionId,
    bundleId: payload.bundleId,
    fileId: payload.fileId,
    offset: payload.offset as number,
    data: canonicalBase64(payload.data, 'native-media'),
  }
}

function nativeSummary(status: NativeMediaBundleSummary): NativeMediaBundleSummary {
  return {
    bundleId: status.bundleId,
    label: status.label,
    state: status.state,
    expectedProvider: status.expectedProvider,
    expectedModel: status.expectedModel,
  }
}

function unavailableNativeBundle(): RpcResult<never> {
  return badRequest('The native media bundle is invalid or no longer available.')
}

export function createMediaFallbackRpcHandler(
  staging: OriginalVideoStaging,
  nativeStaging: NativeMediaStaging,
): RpcHandler {
  return async (endpoint, payload, signal) => {
    if (signal.aborted) return cancelled()
    try {
      if (endpoint === 'capabilities') {
        if (!plainRecord(payload) || Object.keys(payload).length !== 0) return badRequest('The capabilities request is invalid.')
        return success({
          version: ORIGINAL_MEDIA_PROTOCOL_VERSION,
          chunkBytes: ORIGINAL_MEDIA_RECOMMENDED_CHUNK_BYTES,
          maxChunkBytes: ORIGINAL_MEDIA_MAX_CHUNK_BYTES,
        })
      }
      if (endpoint === 'begin') {
        const result = await staging.begin(payload, signal)
        if (signal.aborted && plainRecord(payload) && validIdentity(payload.sessionId, SESSION_ID_MAX_CHARS)) {
          await staging.discard(payload.sessionId, result.token).catch(() => undefined)
          return cancelled()
        }
        return success(result)
      }
      if (endpoint === 'append') return success(await staging.append(payload, signal))
      if (endpoint === 'commit') {
        const request = parseTokenRequest(payload, 'commit')
        return success(await staging.commit(request.sessionId, request.token, signal))
      }
      if (endpoint === 'discard') {
        const request = parseTokenRequest(payload, 'discard')
        return success({ discarded: await staging.discard(request.sessionId, request.token, signal) })
      }
      if (endpoint === 'native-capabilities') {
        if (!plainRecord(payload) || Object.keys(payload).length !== 0) {
          return badRequest('The native-media capabilities request is invalid.')
        }
        return success({
          version: NATIVE_MEDIA_PROTOCOL_VERSION,
          nativeDrafts: true,
          chunkBytes: NATIVE_MEDIA_RECOMMENDED_CHUNK_BYTES,
        })
      }
      if (endpoint === 'native-begin') {
        const result = await nativeStaging.begin(payload, signal)
        if (signal.aborted) {
          const sessionId = plainRecord(payload) && typeof payload.sessionId === 'string' ? payload.sessionId : ''
          await nativeStaging.discard(sessionId, result.bundleId).catch(() => undefined)
          return cancelled()
        }
        return success({
          bundleId: result.bundleId,
          files: result.files.map(file => ({ fileId: file.fileId })),
        })
      }
      if (endpoint === 'native-append') {
        const request = parseNativeAppendRequest(payload)
        try {
          return success(await nativeStaging.append(request, signal))
        } finally {
          request.data.fill(0)
        }
      }
      if (endpoint === 'native-commit') {
        const request = parseNativeBundleRequest(payload, 'commit')
        return success(nativeSummary(await nativeStaging.commit(request.sessionId, request.bundleId, signal)))
      }
      if (endpoint === 'native-status') {
        const request = parseNativeBundleRequest(payload, 'status')
        const status = await nativeStaging.status(request.sessionId, request.bundleId, signal)
        return status === undefined ? unavailableNativeBundle() : success(nativeSummary(status))
      }
      if (endpoint === 'native-list') {
        const request = parseNativeListRequest(payload)
        return success({ bundles: (await nativeStaging.list(request.sessionId, signal)).map(nativeSummary) })
      }
      if (endpoint === 'native-discard') {
        const request = parseNativeBundleRequest(payload, 'discard')
        return success({ discarded: await nativeStaging.discard(request.sessionId, request.bundleId, signal) })
      }
      return badRequest('The original-media endpoint is unknown.')
    } catch (error) {
      if (signal.aborted) return cancelled()
      if (error instanceof MediaFallbackInputError || error instanceof NativeMediaInputError) {
        return badRequest(error.message)
      }
      if (error instanceof MediaFallbackResourceError || error instanceof OriginalMediaStoreCapacityError) {
        return resourceExhausted(error.message)
      }
      if (error instanceof MediaFallbackLifecycleError || error instanceof NativeMediaLifecycleError) return cancelled()
      return { ok: false, error: {
        code: 'internal', message: 'The original-media request could not be completed.', details: {},
      } }
    }
  }
}

/** Register only against the three-argument Host API that can enforce loopback authority. */
export function registerMediaFallbackRpc(
  ctx: Context,
  staging: OriginalVideoStaging,
  nativeStaging: NativeMediaStaging,
): void {
  ctx.effect(() => {
    const stopSweep = staging.startExpirySweep()
    let stopNativeSweep: () => void
    try {
      stopNativeSweep = nativeStaging.startExpirySweep()
    } catch (cause) {
      stopSweep()
      throw cause
    }
    return async () => {
      stopSweep()
      stopNativeSweep()
      const results = await Promise.allSettled([staging.dispose(), nativeStaging.dispose()])
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed !== undefined) throw failed.reason
    }
  })
  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.get('connection') as HostConnection | undefined
    const rpc = connection?.rpc
    const handle = rpc?.handle
    if (typeof handle !== 'function' || handle.length < 3) return
    connectionCtx.effect(() => handle.call(
      rpc,
      '/volcengine-media',
      createMediaFallbackRpcHandler(staging, nativeStaging),
      { authority: 'loopback' },
    ))
  })
}

export function supportsMediaFallbackRpc(ctx: Context): boolean {
  const connection = ctx.get('connection') as HostConnection | undefined
  const handle = connection?.rpc?.handle
  return typeof handle === 'function' && handle.length >= 3
}
