import { constants as bufferConstants } from 'node:buffer'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatNativeMediaMarker,
  nativeMediaMarkerIds,
  nativeMediaMarkerOccurrences,
  parseNativeMediaMarker,
  parseLeadingNativeMediaMarkers,
} from '../../src/native-media-marker.js'
import {
  NativeMediaClaimError,
  NativeMediaInputError,
  NativeMediaSelectionError,
  NativeMediaStaging,
  type NativeMediaBeginRequest,
  type NativeMediaFileDeclaration,
} from '../../src/native-media-staging.js'
import { OriginalMediaStore } from '../../src/original-media-store.js'

const roots: string[] = []
const SESSION = 'session-one'
const BUNDLE = '1'.repeat(32)
const PROVIDER = 'volcengine-coding-plan'
const MODEL = 'doubao-seed-2.0-lite'

const declarations = [
  { name: '画面.png', bytes: 4, modality: 'image', mediaType: 'image/png' },
  { name: 'clip.mov', bytes: 5, modality: 'video', mediaType: 'video/quicktime' },
  { name: 'voice.m4a', bytes: 3, modality: 'audio', mediaType: 'audio/x-m4a', format: 'm4a' },
] as const satisfies readonly NativeMediaFileDeclaration[]

const payloads = [
  Uint8Array.of(137, 80, 78, 71),
  Uint8Array.of(0, 1, 2, 3, 4),
  Uint8Array.of(9, 8, 7),
] as const

function stagingToken(bundleId: string, fileId: string): string {
  return createHash('sha256').update(bundleId).update('\u0000').update(fileId).digest('hex')
}

function request(overrides: Partial<NativeMediaBeginRequest> = {}): NativeMediaBeginRequest {
  return {
    sessionId: SESSION,
    bundleId: BUNDLE,
    expectedProvider: PROVIDER,
    expectedModel: MODEL,
    files: declarations,
    ...overrides,
  }
}

async function fixture(options: {
  now?: () => number
  ttlMs?: number
  availableBytes?: (path: string) => Promise<bigint>
  instance?: string
} = {}): Promise<{
  root: string
  stagingRoot: string
  store: OriginalMediaStore
  staging: NativeMediaStaging
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-native-media-'))
  roots.push(root)
  const instance = options.instance ?? 'a'.repeat(32)
  const store = new OriginalMediaStore(root, {
    instanceId: instance,
    ...(options.availableBytes === undefined ? {} : { availableBytes: options.availableBytes }),
  })
  let sequence = 1
  const staging = new NativeMediaStaging(store, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    mintFileId: () => (sequence++).toString(16).padStart(32, '0'),
  })
  return { root, stagingRoot: join(root, '.staging', instance), store, staging }
}

async function uploadAll(staging: NativeMediaStaging, begin = request()) {
  const handle = await staging.begin(begin)
  for (let index = 0; index < handle.files.length; index++) {
    const bytes = payloads[index]!
    const file = handle.files[index]!
    const split = Math.max(1, bytes.byteLength - 1)
    await staging.append({
      sessionId: begin.sessionId,
      bundleId: begin.bundleId,
      fileId: file.fileId,
      offset: 0,
      data: bytes.subarray(0, split),
    })
    if (split < bytes.byteLength) {
      await staging.append({
        sessionId: begin.sessionId,
        bundleId: begin.bundleId,
        fileId: file.fileId,
        offset: split,
        data: bytes.subarray(split),
      })
    }
  }
  return { handle, armed: await staging.commit(begin.sessionId, begin.bundleId) }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('native Ark media marker vocabulary', () => {
  it('uses one 128-bit canonical marker with strict whitespace boundaries', () => {
    const marker = formatNativeMediaMarker(BUNDLE)
    expect(marker).toBe(`/__dsh_volc_media_v1_${BUNDLE}`)
    expect(parseNativeMediaMarker(marker)).toBe(BUNDLE)
    expect(parseNativeMediaMarker(` ${marker}`)).toBeUndefined()
    expect(() => formatNativeMediaMarker('f'.repeat(64))).toThrow('bundle id')
    expect(nativeMediaMarkerOccurrences(`before\n${marker}\tafter`)).toEqual([
      { marker, bundleId: BUNDLE, start: 7, end: 7 + marker.length },
    ])
    expect(nativeMediaMarkerIds(`${marker}\n${formatNativeMediaMarker('2'.repeat(32))}`))
      .toEqual([BUNDLE, '2'.repeat(32)])
    expect(parseLeadingNativeMediaMarkers(`\n${marker}\ttext ${formatNativeMediaMarker('2'.repeat(32))}`))
      .toEqual([BUNDLE])
    expect(nativeMediaMarkerOccurrences(`x${marker} ${marker}, ${marker}y`)).toEqual([])
  })
})

describe('durable native Ark media bundle staging', () => {
  it('arms image/video/audio atomically, claims one exact message, and confirms only after materialization', async () => {
    const { store, staging } = await fixture()
    const { handle, armed } = await uploadAll(staging)

    expect(handle.marker).toBe(formatNativeMediaMarker(BUNDLE))
    expect(armed).toMatchObject({ label: '画面.png +2', state: 'ready' })
    expect(armed.files.map(file => ({ name: file.name, modality: file.modality, mediaType: file.mediaType, format: file.format })))
      .toEqual([
        { name: '画面.png', modality: 'image', mediaType: 'image/png', format: undefined },
        { name: 'clip.mov', modality: 'video', mediaType: 'video/quicktime', format: undefined },
        { name: 'voice.m4a', modality: 'audio', mediaType: 'audio/x-m4a', format: 'm4a' },
      ])
    expect(await staging.claim(SESSION, BUNDLE, 'message-one')).toMatchObject({
      bundleId: BUNDLE, sessionId: SESSION, messageId: 'message-one',
    })
    await expect(staging.claim(SESSION, BUNDLE, 'message-one')).resolves.toMatchObject({ messageId: 'message-one' })
    await expect(staging.claim(SESSION, BUNDLE, 'message-two')).rejects.toBeInstanceOf(NativeMediaClaimError)
    await expect(staging.materialize(SESSION, BUNDLE, 'not-the-message', PROVIDER, MODEL)).resolves.toBeUndefined()

    const materialized = await staging.materialize(SESSION, BUNDLE, 'message-one', PROVIDER, MODEL)
    expect(materialized?.files.map(file => file.attachment.name)).toEqual(declarations.map(file => file.name))
    for (let index = 0; index < materialized!.files.length; index++) {
      expect(await store.read(materialized!.files[index]!.attachment)).toEqual(payloads[index])
    }
    await expect(staging.confirm(SESSION, BUNDLE, 'message-two')).resolves.toBe(false)
    await expect(staging.confirm(SESSION, BUNDLE, 'message-one')).resolves.toBe(true)
    await expect(staging.status(SESSION, BUNDLE)).resolves.toBeUndefined()
    expect(staging.pendingCount()).toBe(0)
  })

  it('recovers committed bytes, metadata, marker claim, and list/status across Host restarts', async () => {
    const { root, staging } = await fixture()
    const { armed } = await uploadAll(staging)
    const manifest = join(root, '.native-bundles', 'v1', `${BUNDLE}.json`)
    await expect(access(manifest)).resolves.toBeUndefined()
    await staging.dispose()

    const secondStore = new OriginalMediaStore(root, { instanceId: 'b'.repeat(32) })
    const second = new NativeMediaStaging(secondStore)
    await expect(second.list(SESSION)).resolves.toEqual([
      expect.objectContaining({ bundleId: BUNDLE, marker: armed.marker, phase: 'armed' }),
    ])
    await expect(second.status(SESSION, BUNDLE)).resolves.toMatchObject({ phase: 'armed' })
    await second.claim(SESSION, BUNDLE, 'message-after-restart')
    const materialized = await second.materialize(
      SESSION, BUNDLE, 'message-after-restart', PROVIDER, MODEL,
    )
    expect(materialized?.files.map(file => file.attachment.name)).toEqual(declarations.map(file => file.name))
    await second.dispose()

    const third = new NativeMediaStaging(new OriginalMediaStore(root, { instanceId: 'c'.repeat(32) }))
    await expect(third.status(SESSION, BUNDLE)).resolves.toMatchObject({
      phase: 'materialized', messageId: 'message-after-restart',
    })
    await expect(third.claim(SESSION, BUNDLE, 'different-message')).rejects.toBeInstanceOf(NativeMediaClaimError)
    await expect(third.claim(SESSION, BUNDLE, 'message-after-restart')).resolves.toBeDefined()
    await expect(third.confirm(SESSION, BUNDLE, 'message-after-restart')).resolves.toBe(true)
    await expect(access(manifest)).rejects.toThrow()
    await third.dispose()
  })

  it('supports multiple bundles per session and claims many for one message all-or-none', async () => {
    const { staging } = await fixture()
    const secondBundle = '2'.repeat(32)
    await uploadAll(staging)
    await uploadAll(staging, request({ bundleId: secondBundle }))
    await expect(staging.list(SESSION)).resolves.toHaveLength(2)

    await expect(staging.claimMany(
      SESSION, [BUNDLE, 'f'.repeat(32)], 'message-many',
    )).resolves.toBeUndefined()
    await expect(staging.status(SESSION, BUNDLE)).resolves.toMatchObject({ state: 'ready' })
    await expect(staging.status(SESSION, secondBundle)).resolves.toMatchObject({ state: 'ready' })

    await expect(staging.claimMany(
      SESSION, [BUNDLE, secondBundle], 'message-many',
    )).resolves.toHaveLength(2)
    await expect(staging.claim(SESSION, BUNDLE, 'another-message')).rejects.toBeInstanceOf(NativeMediaClaimError)
    for (const bundleId of [BUNDLE, secondBundle]) {
      await expect(staging.materialize(
        SESSION, bundleId, 'message-many', PROVIDER, MODEL,
      )).resolves.toMatchObject({ bundleId, messageId: 'message-many' })
      await expect(staging.confirm(SESSION, bundleId, 'message-many')).resolves.toBe(true)
    }
    await expect(staging.list(SESSION)).resolves.toEqual([])
  })

  it('keeps begin idempotent only for the same session, bundle id, and complete request', async () => {
    const { staging } = await fixture()
    const first = await staging.begin(request({ clientSubmissionId: BUNDLE }))
    await expect(staging.begin(request())).resolves.toEqual(first)
    await expect(staging.begin(request({ expectedModel: 'another-model' }))).rejects.toThrow('already in use')
    await expect(staging.begin(request({ bundleId: '2'.repeat(32) }))).resolves.toMatchObject({
      bundleId: '2'.repeat(32),
    })
    await expect(staging.begin(request({ sessionId: 'another-session' }))).rejects.toThrow('already in use')
    await expect(staging.begin(request({ clientSubmissionId: 'not-the-bundle' }))).rejects.toThrow('request is invalid')
  })

  it('allows only the claiming message to retire a bound bundle, including after restart', async () => {
    const { root, staging } = await fixture()
    await uploadAll(staging)
    await staging.claim(SESSION, BUNDLE, 'owner-message')
    expect(await staging.discard(SESSION, BUNDLE)).toBe(false)
    expect(await staging.discardClaim(SESSION, BUNDLE, 'other-message')).toBe(false)
    expect(await staging.status(SESSION, BUNDLE)).toMatchObject({ state: 'claimed', messageId: 'owner-message' })
    await staging.dispose()

    const restarted = new NativeMediaStaging(new OriginalMediaStore(root, { instanceId: 'b'.repeat(32) }))
    expect(await restarted.discardClaim(SESSION, BUNDLE, 'owner-message')).toBe(true)
    expect(await restarted.status(SESSION, BUNDLE)).toBeUndefined()
    await expect(access(join(root, '.native-bundles', 'v1', `${BUNDLE}.json`))).rejects.toThrow()
    await restarted.dispose()
  })

  it('does not accept a claim while draft retirement is awaiting disk cleanup', async () => {
    const { root, store, staging } = await fixture()
    await uploadAll(staging)
    let entered!: () => void
    let release!: () => void
    const cleaning = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const discardPart = store.discardStaging.bind(store)
    vi.spyOn(store, 'discardStaging').mockImplementation(async token => {
      entered()
      await gate
      await discardPart(token)
    })
    const retiring = staging.discard(SESSION, BUNDLE)
    await cleaning
    try {
      expect(await staging.claim(SESSION, BUNDLE, 'late-message')).toBeUndefined()
    } finally {
      release()
      await retiring
    }
    await staging.dispose()
    const restarted = new NativeMediaStaging(new OriginalMediaStore(root, { instanceId: 'b'.repeat(32) }))
    expect(await restarted.list(SESSION)).toEqual([])
    await restarted.dispose()
  })

  it('requires complete sequential chunks per file and destroys a bundle whose bytes fail SHA verification', async () => {
    const { root, staging } = await fixture()
    const handle = await staging.begin(request())
    const first = handle.files[0]!
    await expect(staging.append({
      sessionId: SESSION, bundleId: BUNDLE, fileId: first.fileId, offset: 1, data: Uint8Array.of(1),
    })).rejects.toThrow('strictly sequential')
    await staging.append({
      sessionId: SESSION, bundleId: BUNDLE, fileId: first.fileId, offset: 0, data: payloads[0],
    })
    await expect(staging.commit(SESSION, BUNDLE)).rejects.toThrow('incomplete')
    for (let index = 1; index < handle.files.length; index++) {
      await staging.append({
        sessionId: SESSION,
        bundleId: BUNDLE,
        fileId: handle.files[index]!.fileId,
        offset: 0,
        data: payloads[index],
      })
    }
    await writeFile(
      join(root, '.staging', 'a'.repeat(32), `${stagingToken(BUNDLE, first.fileId)}.part`),
      Uint8Array.of(0, 0, 0, 0),
    )
    await expect(staging.commit(SESSION, BUNDLE)).rejects.toThrow('integrity check')
    await expect(staging.status(SESSION, BUNDLE)).resolves.toBeUndefined()
  })

  it('uses only Ark Chat declarations and path-free original names', async () => {
    const { root, staging } = await fixture()
    for (const file of [
      { name: 'payload.bin', bytes: 1, modality: 'video', mediaType: 'application/octet-stream' },
      { name: 'voice.mp3', bytes: 1, modality: 'audio', mediaType: 'audio/mpeg', format: 'wav' },
      { name: 'C:\\private\\clip.mp4', bytes: 1, modality: 'video', mediaType: 'video/mp4' },
      { name: '../clip.mp4', bytes: 1, modality: 'video', mediaType: 'video/mp4' },
    ]) {
      const error = await staging.begin(request({ files: [file as NativeMediaFileDeclaration] })).catch(value => value)
      expect(error).toBeInstanceOf(NativeMediaInputError)
      expect(String(error)).not.toContain(root)
      expect(staging.pendingCount()).toBe(0)
    }
  })

  it('has no aggregate media-size or file-count policy below runtime and disk limits', async () => {
    const gibibyte = 1024 * 1024 * 1024
    const { staging } = await fixture({ availableBytes: async () => 4n * BigInt(gibibyte) })
    const files = Array.from({ length: 9 }, (_, index) => ({
      name: `large-${index}.mp4`,
      bytes: 64 * 1024 * 1024,
      modality: 'video' as const,
      mediaType: 'video/mp4' as const,
    }))
    await expect(staging.begin(request({ files }))).resolves.toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ bytes: 64 * 1024 * 1024 })]),
    })
    await expect(staging.discard(SESSION, BUNDLE)).resolves.toBe(true)

    const maximum = Math.min(
      bufferConstants.MAX_LENGTH,
      Math.floor((bufferConstants.MAX_STRING_LENGTH - 'data:video/mp4;base64,'.length) / 4) * 3,
    )
    await expect(staging.begin(request({
      bundleId: '2'.repeat(32),
      files: [{ name: 'too-large.mp4', bytes: maximum + 1, modality: 'video', mediaType: 'video/mp4' }],
    }))).rejects.toThrow('file declaration is invalid')
  })

  it('drops a claimed bundle instead of crossing a provider/model boundary', async () => {
    const { root, staging } = await fixture()
    await uploadAll(staging)
    await staging.claim(SESSION, BUNDLE, 'message-one')
    await expect(staging.materialize(SESSION, BUNDLE, 'message-one', PROVIDER, 'changed-model'))
      .rejects.toBeInstanceOf(NativeMediaSelectionError)
    await expect(staging.status(SESSION, BUNDLE)).resolves.toBeUndefined()
    await expect(access(join(root, '.native-bundles', 'v1', `${BUNDLE}.json`))).rejects.toThrow()
  })

  it('expires partial bytes but keeps armed manifests until explicit lifecycle cleanup', async () => {
    let now = 10_000
    const { root, stagingRoot, staging } = await fixture({ now: () => now, ttlMs: 50 })
    const partial = await staging.begin(request())
    await staging.append({
      sessionId: SESSION, bundleId: BUNDLE, fileId: partial.files[0]!.fileId,
      offset: 0, data: Uint8Array.of(137),
    })
    now += 50
    await staging.sweepExpired()
    await expect(access(join(stagingRoot, `${stagingToken(BUNDLE, partial.files[0]!.fileId)}.part`))).rejects.toThrow()

    const durableBundle = '2'.repeat(32)
    now += 1
    const { armed } = await uploadAll(staging, request({ bundleId: durableBundle }))
    const content = join(root, `${armed.files[0]!.sha256}.mp4`)
    const manifest = join(root, '.native-bundles', 'v1', `${durableBundle}.json`)
    await expect(access(content)).resolves.toBeUndefined()
    now += 50
    await staging.sweepExpired()
    await expect(access(manifest)).resolves.toBeUndefined()
    await expect(staging.status(SESSION, durableBundle)).resolves.toMatchObject({ state: 'ready' })
    await expect(readFile(content)).resolves.toEqual(Buffer.from(payloads[0]))
    await expect(staging.discard(SESSION, durableBundle)).resolves.toBe(true)
    await expect(access(manifest)).rejects.toThrow()
  })

  it('disposes incomplete parts but deliberately keeps an armed restart manifest', async () => {
    const { root, stagingRoot, staging } = await fixture()
    const partial = await staging.begin(request())
    await staging.append({
      sessionId: SESSION, bundleId: BUNDLE, fileId: partial.files[0]!.fileId,
      offset: 0, data: Uint8Array.of(137),
    })
    await staging.dispose()
    await expect(access(stagingRoot)).rejects.toThrow()

    const second = new NativeMediaStaging(new OriginalMediaStore(root, { instanceId: 'b'.repeat(32) }))
    await uploadAll(second, request({ bundleId: '2'.repeat(32) }))
    await second.dispose()
    await expect(access(join(root, '.native-bundles', 'v1', `${'2'.repeat(32)}.json`))).resolves.toBeUndefined()
  })
})
