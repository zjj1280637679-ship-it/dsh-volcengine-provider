import { constants as bufferConstants } from 'node:buffer'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMediaFallbackRpcHandler, ORIGINAL_MEDIA_PROTOCOL_VERSION,
  ORIGINAL_MEDIA_MAX_ACTIVE_STAGINGS, ORIGINAL_MEDIA_MAX_CHUNK_BYTES,
  ORIGINAL_MEDIA_RECOMMENDED_CHUNK_BYTES, ORIGINAL_MEDIA_TOKEN_TTL_MS,
  MediaFallbackLifecycleError, OriginalVideoStaging, registerMediaFallbackRpc,
} from '../../src/media-fallback-rpc.js'
import {
  NATIVE_MEDIA_PROTOCOL_VERSION,
  NATIVE_MEDIA_RECOMMENDED_CHUNK_BYTES,
} from '../../src/native-media-protocol.js'
import { NativeMediaStaging } from '../../src/native-media-staging.js'
import { OriginalMediaStore, OriginalMediaStoreCapacityError } from '../../src/original-media-store.js'

function beginRequest(bytes: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-one', name: 'clip.mp4', mediaType: 'video/mp4', bytes,
    prompt: 'understand the complete video', clientSubmissionId: '12345678-1234-4234-9234-123456789abc',
    expectedProvider: 'volcengine-coding-plan', expectedModel: 'seed-video',
    ...overrides,
  }
}

function encoded(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) return Promise.reject(new Error('The lifecycle signal was not forwarded.'))
  return new Promise((_, reject) => {
    const aborted = (): void => reject(signal.reason ?? new Error('The operation was aborted.'))
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}

const contexts: Context[] = []
const roots: string[] = []
const stagings: OriginalVideoStaging[] = []
const nativeStagings: NativeMediaStaging[] = []
const FIXTURE_INSTANCE = '9'.repeat(32)
const NATIVE_FIXTURE_INSTANCE = '8'.repeat(32)
const NATIVE_BUNDLE = 'a'.repeat(32)
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const staging of nativeStagings.splice(0).reverse()) await staging.dispose()
  for (const staging of stagings.splice(0).reverse()) await staging.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(options: ConstructorParameters<typeof OriginalVideoStaging>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-staging-'))
  roots.push(root)
  const stagingRoot = join(root, '.staging', FIXTURE_INSTANCE)
  const store = new OriginalMediaStore(root, { instanceId: FIXTURE_INSTANCE })
  const staging = new OriginalVideoStaging(store, options)
  stagings.push(staging)
  return { root, stagingRoot, store, staging }
}

async function nativeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-native-staging-'))
  roots.push(root)
  const store = new OriginalMediaStore(root, { instanceId: NATIVE_FIXTURE_INSTANCE })
  const nativeStaging = new NativeMediaStaging(store, {
    mintFileId: () => 'b'.repeat(32),
  })
  nativeStagings.push(nativeStaging)
  return { root, store, nativeStaging }
}

function nativeBeginRequest(bytes: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-one', bundleId: NATIVE_BUNDLE,
    expectedProvider: 'volcengine-coding-plan', expectedModel: 'seed-video',
    files: [{ name: 'still.png', bytes, modality: 'image', mediaType: 'image/png' }],
    ...overrides,
  }
}

async function upload(staging: OriginalVideoStaging, data: Uint8Array, chunkBytes = data.byteLength) {
  const { token } = await staging.begin(beginRequest(data.byteLength))
  for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
    const chunk = data.subarray(offset, Math.min(offset + chunkBytes, data.byteLength))
    await staging.append({ sessionId: 'session-one', token, offset, data: encoded(chunk) })
  }
  const committed = await staging.commit('session-one', token)
  return { token, committed }
}

describe('disk-backed original video staging', () => {
  it('writes canonical chunks in order, hashes on the Host, and consumes exactly once', async () => {
    const { store, staging } = await fixture()
    const bytes = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3])
    const { token } = await staging.begin(beginRequest(bytes.byteLength))
    const entry = (staging as unknown as { pending: Map<string, object> }).pending.get(token)!
    expect(entry).not.toHaveProperty('bytes')
    await expect(staging.append({
      sessionId: 'session-one', token, offset: 0, data: encoded(bytes.subarray(0, 5)),
    })).resolves.toEqual({ receivedBytes: 5 })
    await expect(staging.append({
      sessionId: 'session-one', token, offset: 5, data: encoded(bytes.subarray(5)),
    })).resolves.toEqual({ receivedBytes: bytes.byteLength })
    const expectedHash = createHash('sha256').update(bytes).digest('hex')
    await expect(staging.commit('session-one', token)).resolves.toEqual({ token, sha256: expectedHash })
    await expect(staging.commit('session-one', token)).resolves.toEqual({ token, sha256: expectedHash })
    await expect(staging.take('another-session', token, 'volcengine-coding-plan', 'seed-video')).resolves.toBeUndefined()
    await expect(staging.take('session-one', token, 'volcengine-coding-plan', 'other-model'))
      .rejects.toThrow('selected provider or model changed')
    const consumed = await staging.take('session-one', token, 'volcengine-coding-plan', 'seed-video')
    expect(consumed).toMatchObject({ sha256: expectedHash, prompt: 'understand the complete video' })
    expect(await store.read(consumed!.attachment)).toEqual(bytes)
    await expect(staging.take('session-one', token, 'volcengine-coding-plan', 'seed-video')).resolves.toBeUndefined()
  })

  it('does not enforce the old 8 MiB file limit when sent in bounded chunks', async () => {
    const { store, staging } = await fixture()
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 257)
    for (let index = 0; index < bytes.byteLength; index++) bytes[index] = index % 251
    const chunkBytes = ORIGINAL_MEDIA_MAX_CHUNK_BYTES
    const { token, committed } = await upload(staging, bytes, chunkBytes)
    expect(committed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const consumed = await staging.take('session-one', token, 'volcengine-coding-plan', 'seed-video')
    expect(consumed?.attachment.bytes).toBe(bytes.byteLength)
    expect(createHash('sha256').update(await store.read(consumed!.attachment)).digest('hex')).toBe(committed.sha256)
  }, 30_000)

  it('rejects a single RPC chunk above 1 MiB without imposing a file limit', async () => {
    const { staging } = await fixture()
    const bytes = Buffer.alloc(ORIGINAL_MEDIA_MAX_CHUNK_BYTES + 1, 7)
    const { token } = await staging.begin(beginRequest(bytes.byteLength))
    await expect(staging.append({ sessionId: 'session-one', token, offset: 0, data: encoded(bytes) }))
      .rejects.toThrow('1 MiB per-request')
    await staging.append({
      sessionId: 'session-one', token, offset: 0, data: encoded(bytes.subarray(0, ORIGINAL_MEDIA_MAX_CHUNK_BYTES)),
    })
    await staging.append({
      sessionId: 'session-one', token, offset: ORIGINAL_MEDIA_MAX_CHUNK_BYTES,
      data: encoded(bytes.subarray(ORIGINAL_MEDIA_MAX_CHUNK_BYTES)),
    })
    await expect(staging.commit('session-one', token)).resolves.toMatchObject({ token })
  })

  it('rejects gaps, overlaps, incomplete commits, noncanonical chunks, and append replay', async () => {
    const { staging } = await fixture()
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const { token } = await staging.begin(beginRequest(bytes.byteLength))
    await expect(staging.append({ sessionId: 'session-one', token, offset: 1, data: encoded(bytes.subarray(0, 2)) }))
      .rejects.toThrow('strictly sequential')
    await expect(staging.append({ sessionId: 'session-one', token, offset: 0, data: `${encoded(bytes.subarray(0, 2))}\n` }))
      .rejects.toThrow('canonical base64')
    await staging.append({ sessionId: 'session-one', token, offset: 0, data: encoded(bytes.subarray(0, 2)) })
    await expect(staging.append({ sessionId: 'session-one', token, offset: 0, data: encoded(bytes.subarray(0, 2)) }))
      .rejects.toThrow('strictly sequential')
    await expect(staging.commit('session-one', token)).rejects.toThrow('incomplete')
    await staging.append({ sessionId: 'session-one', token, offset: 2, data: encoded(bytes.subarray(2)) })
    await expect(staging.append({ sessionId: 'session-one', token, offset: 4, data: encoded(Uint8Array.from([5])) }))
      .rejects.toThrow('strictly sequential')
    await expect(staging.commit('session-one', token)).resolves.toMatchObject({ token })
  })

  it('keeps begin idempotent only for an identical client submission', async () => {
    const { staging } = await fixture()
    const first = await staging.begin(beginRequest(10))
    await expect(staging.begin(beginRequest(10))).resolves.toEqual(first)
    await expect(staging.begin(beginRequest(11))).rejects.toThrow('already in use')
    await expect(staging.begin(beginRequest(10, { mediaType: 'video/quicktime' }))).rejects.toThrow('begin request is invalid')
    await expect(staging.begin({ ...beginRequest(10), unexpected: true })).rejects.toThrow('begin request is invalid')
  })

  it('allows one active upload per session and eight per process', async () => {
    const { staging } = await fixture()
    const { staging: otherInstance } = await fixture()
    const firstRequest = beginRequest(1, { sessionId: 'session-0', clientSubmissionId: 'submission-0' })
    const first = await staging.begin(firstRequest)
    await expect(otherInstance.begin(beginRequest(1, {
      sessionId: 'session-0', clientSubmissionId: 'different-submission',
    }))).rejects.toThrow('already has an active')
    await expect(staging.begin(firstRequest)).resolves.toEqual(first)

    for (let index = 1; index < ORIGINAL_MEDIA_MAX_ACTIVE_STAGINGS; index++) {
      const target = index % 2 === 0 ? staging : otherInstance
      await target.begin(beginRequest(1, {
        sessionId: `session-${index}`, clientSubmissionId: `submission-${index}`,
      }))
    }
    await expect(otherInstance.begin(beginRequest(1, {
      sessionId: 'session-overflow', clientSubmissionId: 'submission-overflow',
    }))).rejects.toThrow('maximum number of active')
    await expect(staging.discard('session-0', first.token)).resolves.toBe(true)
    await expect(otherInstance.begin(beginRequest(1, {
      sessionId: 'session-overflow', clientSubmissionId: 'submission-overflow',
    }))).resolves.toMatchObject({ token: expect.stringMatching(/^[a-f0-9]{64}$/u) })
  })

  it('bounds metadata and rejects MP4 sizes the Node Buffer/data URL cannot represent', async () => {
    const { staging } = await fixture()
    for (const overrides of [
      { sessionId: 's'.repeat(513) },
      { clientSubmissionId: 'i'.repeat(129) },
      { name: `${'n'.repeat(252)}.mp4` },
      { prompt: 'p'.repeat(65_537) },
      { expectedProvider: 'p'.repeat(513) },
      { expectedModel: 'm'.repeat(513) },
    ]) {
      await expect(staging.begin(beginRequest(1, overrides))).rejects.toThrow('begin request is invalid')
    }
    const dataUrlLimit = Math.floor((bufferConstants.MAX_STRING_LENGTH - 'data:video/mp4;base64,'.length) / 4) * 3
    await expect(staging.begin(beginRequest(dataUrlLimit + 1))).rejects.toThrow('begin request is invalid')
    if (bufferConstants.MAX_LENGTH < Number.MAX_SAFE_INTEGER) {
      await expect(staging.begin(beginRequest(bufferConstants.MAX_LENGTH + 1))).rejects.toThrow('begin request is invalid')
    }
  })

  it('removes a staging file when begin is cancelled after disk creation', async () => {
    const token = 'a'.repeat(64)
    const { stagingRoot, store, staging } = await fixture({ mintToken: () => token })
    const controller = new AbortController()
    const beginStaging = store.beginStaging.bind(store)
    vi.spyOn(store, 'beginStaging').mockImplementationOnce(async (candidate, requiredBytes, signal) => {
      await beginStaging(candidate, requiredBytes, signal)
      controller.abort()
    })

    await expect(staging.begin(beginRequest(1), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(staging.pendingCount()).toBe(0)
    await expect(access(join(stagingRoot, `${token}.part`))).rejects.toThrow()
  })

  it('periodically expires tokens and deletes partial disk staging without another request', async () => {
    vi.useFakeTimers()
    let now = 10_000
    const { stagingRoot, staging } = await fixture({ now: () => now, ttlMs: 50 })
    const stop = staging.startExpirySweep()
    const { token } = await staging.begin(beginRequest(3))
    await staging.append({ sessionId: 'session-one', token, offset: 0, data: encoded(Uint8Array.from([1])) })
    expect(staging.pendingCount()).toBe(1)
    await expect(access(join(stagingRoot, `${token}.part`))).resolves.toBeUndefined()
    now += 50
    await vi.advanceTimersByTimeAsync(50)
    await staging.whenSweepIdle()
    expect(staging.pendingCount()).toBe(0)
    await expect(access(join(stagingRoot, `${token}.part`))).rejects.toThrow()
    stop()
  })

  it('aborts and drains a delayed begin before retiring its instance directory', async () => {
    const token = '6'.repeat(64)
    const { stagingRoot, store, staging } = await fixture({ mintToken: () => token })
    const entered = deferred()
    const beginStaging = store.beginStaging.bind(store)
    vi.spyOn(store, 'beginStaging').mockImplementationOnce(async (candidate, requiredBytes, signal) => {
      await beginStaging(candidate, requiredBytes, signal)
      entered.resolve()
      await waitForAbort(signal)
    })

    const operation = staging.begin(beginRequest(1))
    const rejection = expect(operation).rejects.toBeInstanceOf(MediaFallbackLifecycleError)
    await entered.promise
    const disposal = staging.dispose()
    await rejection
    await expect(disposal).resolves.toBeUndefined()
    expect(staging.pendingCount()).toBe(0)
    await expect(access(stagingRoot)).rejects.toThrow()
    await expect(staging.begin(beginRequest(1, { clientSubmissionId: 'after-close' })))
      .rejects.toBeInstanceOf(MediaFallbackLifecycleError)
  })

  it('aborts and drains a delayed append without leaving a partial file', async () => {
    const { stagingRoot, store, staging } = await fixture()
    const { token } = await staging.begin(beginRequest(1))
    const entered = deferred()
    vi.spyOn(store, 'appendStaging').mockImplementationOnce(async (_token, _offset, _data, signal) => {
      entered.resolve()
      await waitForAbort(signal)
    })

    const operation = staging.append({
      sessionId: 'session-one', token, offset: 0, data: encoded(Uint8Array.of(1)),
    })
    const rejection = expect(operation).rejects.toBeInstanceOf(MediaFallbackLifecycleError)
    await entered.promise
    const disposal = staging.dispose()
    await rejection
    await expect(disposal).resolves.toBeUndefined()
    expect(staging.pendingCount()).toBe(0)
    await expect(access(stagingRoot)).rejects.toThrow()
  })

  it('finishes owned cleanup when shutdown interrupts a delayed discard', async () => {
    const { stagingRoot, store, staging } = await fixture()
    const { token } = await staging.begin(beginRequest(1))
    const entered = deferred()
    vi.spyOn(store, 'discardStaging').mockImplementationOnce(async (_token, signal) => {
      entered.resolve()
      await waitForAbort(signal)
    })

    const operation = staging.discard('session-one', token)
    const rejection = expect(operation).rejects.toBeInstanceOf(MediaFallbackLifecycleError)
    await entered.promise
    const disposal = staging.dispose()
    await rejection
    await expect(disposal).resolves.toBeUndefined()
    expect(staging.pendingCount()).toBe(0)
    await expect(access(stagingRoot)).rejects.toThrow()
  })

  it('aborts and drains a delayed take before cleanup completes', async () => {
    const { stagingRoot, store, staging } = await fixture()
    const { token } = await upload(staging, Uint8Array.of(1, 2, 3))
    const entered = deferred()
    vi.spyOn(store, 'commitStaging').mockImplementationOnce(async (_token, _bytes, _hash, signal) => {
      entered.resolve()
      return waitForAbort(signal)
    })

    const operation = staging.take('session-one', token, 'volcengine-coding-plan', 'seed-video')
    const rejection = expect(operation).rejects.toBeInstanceOf(MediaFallbackLifecycleError)
    await entered.promise
    const disposal = staging.dispose()
    await rejection
    await expect(disposal).resolves.toBeUndefined()
    expect(staging.pendingCount()).toBe(0)
    await expect(access(stagingRoot)).rejects.toThrow()
  })

  it('discards partial files and clears every pending token on disposal', async () => {
    const { stagingRoot, staging } = await fixture()
    const first = await staging.begin(beginRequest(3))
    const second = await staging.begin(beginRequest(99, {
      sessionId: 'session-two', clientSubmissionId: 'second-submission',
    }))
    await staging.append({ sessionId: 'session-one', token: first.token, offset: 0, data: encoded(Uint8Array.from([1])) })
    await expect(staging.discard('another-session', first.token)).resolves.toBe(false)
    await expect(staging.discard('session-one', first.token)).resolves.toBe(true)
    await expect(access(join(stagingRoot, `${first.token}.part`))).rejects.toThrow()
    expect(staging.pendingCount()).toBe(1)
    await staging.dispose()
    expect(staging.pendingCount()).toBe(0)
    await expect(access(stagingRoot)).rejects.toThrow()
  })
})

describe('loopback media RPC v2 boundary', () => {
  it('advertises the hard per-RPC chunk ceiling without a file limit and supports the full flow', async () => {
    const { staging } = await fixture()
    const { nativeStaging } = await nativeFixture()
    const handler = createMediaFallbackRpcHandler(staging, nativeStaging)
    const signal = new AbortController().signal
    await expect(handler('capabilities', {}, signal)).resolves.toEqual({
      ok: true,
      value: {
        version: ORIGINAL_MEDIA_PROTOCOL_VERSION,
        chunkBytes: ORIGINAL_MEDIA_RECOMMENDED_CHUNK_BYTES,
        maxChunkBytes: ORIGINAL_MEDIA_MAX_CHUNK_BYTES,
      },
    })
    const begun = await handler('begin', beginRequest(3), signal)
    expect(begun).toMatchObject({ ok: true, value: { token: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
    const token = begun.ok ? (begun.value as { token: string }).token : ''
    await expect(handler('append', {
      sessionId: 'session-one', token, offset: 0, data: encoded(Uint8Array.from([1, 2, 3])),
    }, signal)).resolves.toEqual({ ok: true, value: { receivedBytes: 3 } })
    await expect(handler('commit', { sessionId: 'session-one', token }, signal)).resolves.toMatchObject({
      ok: true, value: { token, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    })
    await expect(handler('discard', { sessionId: 'session-one', token }, signal)).resolves.toEqual({
      ok: true, value: { discarded: true },
    })
  })

  it('contains malformed input, cancellation, unknown endpoints, and internal causes', async () => {
    const { staging } = await fixture()
    const { nativeStaging } = await nativeFixture()
    const handler = createMediaFallbackRpcHandler(staging, nativeStaging)
    const signal = new AbortController().signal
    const malformed = await handler('begin', beginRequest(1, { name: 'C:\\private\\clip.mp4' }), signal)
    expect(malformed).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(JSON.stringify(malformed)).not.toContain('C:\\private')
    await expect(handler('unknown', {}, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const controller = new AbortController()
    controller.abort()
    await expect(handler('capabilities', {}, controller.signal)).resolves.toMatchObject({
      ok: false, error: { code: 'cancelled' },
    })
    vi.spyOn(staging, 'begin').mockImplementationOnce(async () => { throw new Error('secret path and bytes') })
    const internal = await handler('begin', beginRequest(1), signal)
    expect(internal).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(internal)).not.toContain('secret')
  })

  it('reports both disposed staging protocols as cancelled without an external abort', async () => {
    const { staging } = await fixture()
    const { nativeStaging } = await nativeFixture()
    const handler = createMediaFallbackRpcHandler(staging, nativeStaging)
    const signal = new AbortController().signal
    await staging.dispose()
    await nativeStaging.dispose()

    await expect(handler('begin', beginRequest(1), signal)).resolves.toMatchObject({
      ok: false, error: { code: 'cancelled' },
    })
    await expect(handler('native-begin', nativeBeginRequest(1), signal)).resolves.toMatchObject({
      ok: false, error: { code: 'cancelled' },
    })
    expect(signal.aborted).toBe(false)
  })

  it('reports local staging capacity exhaustion without exposing a filesystem path', async () => {
    const { store, staging } = await fixture()
    const { nativeStaging } = await nativeFixture()
    const handler = createMediaFallbackRpcHandler(staging, nativeStaging)
    vi.spyOn(store, 'beginStaging').mockRejectedValueOnce(new OriginalMediaStoreCapacityError())
    const result = await handler('begin', beginRequest(1), new AbortController().signal)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'resource-exhausted', message: expect.stringContaining('enough free staging space') },
    })
    expect(JSON.stringify(result)).not.toContain(store.root)
  })

  it('registers one disposable loopback channel only for the authority-aware Host API', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-registration-'))
    roots.push(root)
    let captured: { channel: string; handler: unknown; options: unknown } | undefined
    const disposed = vi.fn(async () => undefined)
    const handle = vi.fn(function (channel: string, handler: unknown, options: unknown) {
      captured = { channel, handler, options }
      return ctx.effect(() => disposed)
    })
    ctx.provide('connection', { rpc: { handle } })
    const originalStaging = new OriginalVideoStaging(new OriginalMediaStore(root, { instanceId: FIXTURE_INSTANCE }))
    const nativeStaging = new NativeMediaStaging(new OriginalMediaStore(root, { instanceId: NATIVE_FIXTURE_INSTANCE }))
    const originalDispose = vi.spyOn(originalStaging, 'dispose')
    const nativeDispose = vi.spyOn(nativeStaging, 'dispose')
    const mounted = ctx.plugin((pluginCtx: Context) => registerMediaFallbackRpc(
      pluginCtx, originalStaging, nativeStaging,
    ))
    await mounted
    expect(handle).toHaveBeenCalledTimes(1)
    expect(captured).toMatchObject({ channel: '/volcengine-media', options: { authority: 'loopback' } })
    await mounted.dispose()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(originalDispose).toHaveBeenCalledTimes(1)
    expect(nativeDispose).toHaveBeenCalledTimes(1)

    const legacy = new Context()
    contexts.push(legacy)
    const legacyRoot = await mkdtemp(join(tmpdir(), 'dsh-volcengine-registration-legacy-'))
    roots.push(legacyRoot)
    const twoArgumentHandle = vi.fn(function (_channel: string, _handler: unknown) { return async () => undefined })
    legacy.provide('connection', { rpc: { handle: twoArgumentHandle } })
    await legacy.plugin((pluginCtx: Context) => registerMediaFallbackRpc(
      pluginCtx,
      new OriginalVideoStaging(new OriginalMediaStore(legacyRoot, { instanceId: FIXTURE_INSTANCE })),
      new NativeMediaStaging(new OriginalMediaStore(legacyRoot, { instanceId: NATIVE_FIXTURE_INSTANCE })),
    ))
    expect(twoArgumentHandle).not.toHaveBeenCalled()
  })
})

describe('loopback native media RPC v3 boundary', () => {
  it('moves exact bytes in bounded chunks without imposing a bundle-size policy', async () => {
    const { staging } = await fixture()
    const { store, nativeStaging } = await nativeFixture()
    const handler = createMediaFallbackRpcHandler(staging, nativeStaging)
    const signal = new AbortController().signal

    await expect(handler('native-capabilities', {}, signal)).resolves.toEqual({
      ok: true,
      value: {
        version: NATIVE_MEDIA_PROTOCOL_VERSION,
        nativeDrafts: true,
        chunkBytes: NATIVE_MEDIA_RECOMMENDED_CHUNK_BYTES,
      },
    })

    const bytes = new Uint8Array(ORIGINAL_MEDIA_MAX_CHUNK_BYTES + 3)
    for (let index = 0; index < bytes.byteLength; index++) bytes[index] = index % 251
    const begun = await handler('native-begin', nativeBeginRequest(bytes.byteLength), signal)
    expect(begun).toEqual({
      ok: true,
      value: { bundleId: NATIVE_BUNDLE, files: [{ fileId: 'b'.repeat(32) }] },
    })
    for (let offset = 0; offset < bytes.byteLength; offset += ORIGINAL_MEDIA_MAX_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + ORIGINAL_MEDIA_MAX_CHUNK_BYTES))
      await expect(handler('native-append', {
        sessionId: 'session-one', bundleId: NATIVE_BUNDLE, fileId: 'b'.repeat(32),
        offset, data: encoded(chunk),
      }, signal)).resolves.toEqual({ ok: true, value: { receivedBytes: offset + chunk.byteLength } })
    }
    await expect(handler('native-commit', {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE,
    }, signal)).resolves.toEqual({
      ok: true,
      value: {
        bundleId: NATIVE_BUNDLE,
        label: 'still.png',
        state: 'ready',
        expectedProvider: 'volcengine-coding-plan',
        expectedModel: 'seed-video',
      },
    })

    await expect(nativeStaging.claim('session-one', NATIVE_BUNDLE, 'message-one')).resolves.toBeDefined()
    const materialized = await nativeStaging.materialize(
      'session-one', NATIVE_BUNDLE, 'message-one', 'volcengine-coding-plan', 'seed-video',
    )
    expect(materialized).toBeDefined()
    const persisted = await store.read(materialized!.files[0]!.attachment)
    expect(createHash('sha256').update(persisted).digest('hex'))
      .toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('strictly rejects malformed or oversized base64 at the RPC boundary', async () => {
    const { staging } = await fixture()
    const { nativeStaging } = await nativeFixture()
    const handler = createMediaFallbackRpcHandler(staging, nativeStaging)
    const signal = new AbortController().signal
    await expect(handler('native-begin', nativeBeginRequest(3), signal)).resolves.toMatchObject({ ok: true })

    const request = {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE, fileId: 'b'.repeat(32), offset: 0,
    }
    await expect(handler('native-append', { ...request, data: 'AQI' }, signal)).resolves.toMatchObject({
      ok: false, error: { code: 'bad-request', message: expect.stringContaining('canonical base64') },
    })
    const oversized = new Uint8Array(ORIGINAL_MEDIA_MAX_CHUNK_BYTES + 1)
    await expect(handler('native-append', { ...request, data: encoded(oversized) }, signal)).resolves.toMatchObject({
      ok: false, error: { code: 'bad-request', message: expect.stringContaining('per-request transport ceiling') },
    })
  })

  it('returns the protocol summary for ready and claimed status/list calls', async () => {
    const { staging } = await fixture()
    const { nativeStaging } = await nativeFixture()
    const handler = createMediaFallbackRpcHandler(staging, nativeStaging)
    const signal = new AbortController().signal
    const bytes = Uint8Array.from([1, 2, 3])
    await handler('native-begin', nativeBeginRequest(bytes.byteLength), signal)
    await handler('native-append', {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE, fileId: 'b'.repeat(32),
      offset: 0, data: encoded(bytes),
    }, signal)
    const expected = {
      bundleId: NATIVE_BUNDLE,
      label: 'still.png',
      state: 'ready' as const,
      expectedProvider: 'volcengine-coding-plan',
      expectedModel: 'seed-video',
    }
    await handler('native-commit', { sessionId: 'session-one', bundleId: NATIVE_BUNDLE }, signal)
    await expect(handler('native-status', {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE,
    }, signal)).resolves.toEqual({ ok: true, value: expected })
    await expect(handler('native-list', { sessionId: 'session-one' }, signal)).resolves.toEqual({
      ok: true, value: { bundles: [expected] },
    })

    await nativeStaging.claim('session-one', NATIVE_BUNDLE, 'message-one')
    const claimed = { ...expected, state: 'claimed' as const }
    await expect(handler('native-status', {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE,
    }, signal)).resolves.toEqual({ ok: true, value: claimed })
    await expect(handler('native-list', { sessionId: 'session-one' }, signal)).resolves.toEqual({
      ok: true, value: { bundles: [claimed] },
    })
    await expect(handler('native-discard', {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE,
    }, signal)).resolves.toEqual({ ok: true, value: { discarded: false } })
    await expect(handler('native-status', {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE,
    }, signal)).resolves.toEqual({ ok: true, value: claimed })
    await expect(nativeStaging.discardClaim('session-one', NATIVE_BUNDLE, 'message-one')).resolves.toBe(true)
    await expect(handler('native-status', {
      sessionId: 'session-one', bundleId: NATIVE_BUNDLE,
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
})
