import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  OriginalMediaStore, OriginalMediaStoreCapacityError, OriginalMediaStoreError,
} from '../../src/original-media-store.js'

const roots: string[] = []
const FIXTURE_INSTANCE = 'a'.repeat(32)

async function fixture(): Promise<{ root: string; stagingRoot: string; store: OriginalMediaStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-original-'))
  roots.push(root)
  return {
    root,
    stagingRoot: join(root, '.staging', FIXTURE_INSTANCE),
    store: new OriginalMediaStore(root, { instanceId: FIXTURE_INSTANCE }),
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('plugin-owned original media store', () => {
  it('atomically publishes exact MP4 bytes under a content-addressed id', async () => {
    const { root, store } = await fixture()
    const bytes = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 1, 2, 255])
    const ref = await store.persistVideo(bytes)

    expect(ref).toEqual({
      attachmentId: expect.stringMatching(/^volcengine-original:v1:sha256:[a-f0-9]{64}$/u),
      name: 'video.mp4', bytes: bytes.byteLength,
    })
    expect(store.owns(ref)).toBe(true)
    // A fresh instance models a Harness process restart: the durable id alone
    // must resolve the exact original bytes.
    expect(await new OriginalMediaStore(root).read(ref)).toEqual(bytes)
    const files = await readdir(root)
    expect(files).toEqual(expect.arrayContaining(['.staging', `${ref.attachmentId.slice(-64)}.mp4`]))
    expect(await readFile(join(root, `${ref.attachmentId.slice(-64)}.mp4`))).toEqual(Buffer.from(bytes))
    expect(files.some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('reuses an independently verified object for identical content', async () => {
    const { root, store } = await fixture()
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    const first = await store.persistVideo(bytes)
    const second = await store.persistVideo(Uint8Array.from(bytes))
    expect(second).toEqual(first)
    expect(await readdir(root)).toHaveLength(2)
  })

  it('never scavenges another instance staging file or an unowned root temporary file', async () => {
    const { root, stagingRoot, store } = await fixture()
    const ref = await store.persistVideo(Uint8Array.from([3, 2, 1]))
    const temporary = `.${'a'.repeat(64)}.${'b'.repeat(32)}.tmp`
    const firstToken = 'c'.repeat(64)
    await store.beginStaging(firstToken, 1)
    await writeFile(join(root, temporary), Uint8Array.from([9]))
    await writeFile(join(root, 'keep.txt'), 'keep')
    const secondInstance = 'b'.repeat(32)
    const secondToken = 'd'.repeat(64)
    const second = new OriginalMediaStore(root, { instanceId: secondInstance })
    await second.beginStaging(secondToken, 1)
    expect(await second.read(ref)).toEqual(Uint8Array.from([3, 2, 1]))
    expect(await readdir(root)).toEqual(expect.arrayContaining([`${ref.attachmentId.slice(-64)}.mp4`, 'keep.txt']))
    expect(await readdir(root)).toContain(temporary)
    expect(await readFile(join(stagingRoot, `${firstToken}.part`))).toEqual(Buffer.alloc(0))
    expect(await readFile(join(root, '.staging', secondInstance, `${secondToken}.part`))).toEqual(Buffer.alloc(0))
    await second.discardStaging(secondToken)
    await second.disposeStagingInstance()
    await expect(access(join(root, '.staging', secondInstance))).rejects.toThrow()
    expect(await readFile(join(stagingRoot, `${firstToken}.part`))).toEqual(Buffer.alloc(0))
    await store.discardStaging(firstToken)
    await store.disposeStagingInstance()
    await expect(access(stagingRoot)).rejects.toThrow()
    expect(await readFile(join(root, temporary))).toEqual(Buffer.from([9]))
  })

  it('revalidates both declared length and SHA-256 on every owned read', async () => {
    const { root, store } = await fixture()
    const ref = await store.persistVideo(Uint8Array.from([9, 8, 7, 6]))
    const file = join(root, `${ref.attachmentId.slice(-64)}.mp4`)
    await writeFile(file, Uint8Array.from([9, 8, 7, 5]))
    await expect(store.read(ref)).rejects.toThrow(OriginalMediaStoreError)
    await expect(store.read(ref)).rejects.toThrow('integrity check')
    await expect(store.read({ ...ref, bytes: ref.bytes + 1 })).rejects.toThrow('integrity check')
  })

  it('rejects foreign, malformed, empty, and unsafe references without exposing its path', async () => {
    const { root, store } = await fixture()
    expect(store.owns({ attachmentId: 'sha256:foreign', name: 'x', bytes: 1 })).toBe(false)
    for (const ref of [
      { attachmentId: 'volcengine-original:v1:sha256:not-a-hash', name: 'x', bytes: 1 },
      { attachmentId: `volcengine-original:v1:sha256:${'0'.repeat(64)}`, name: 'x', bytes: 0 },
      { attachmentId: `volcengine-original:v1:sha256:${'0'.repeat(64)}`, name: 'x', bytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(store.read(ref)).rejects.toThrow('reference is invalid')
      await expect(store.read(ref)).rejects.not.toThrow(root)
    }
    await expect(store.persistVideo(new Uint8Array())).rejects.toThrow('byte length is invalid')
  })

  it('promotes a sequential staging file atomically only after length and digest verification', async () => {
    const { stagingRoot, store } = await fixture()
    const token = 'd'.repeat(64)
    const bytes = Uint8Array.from([1, 3, 3, 7, 9])
    const hash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    await store.beginStaging(token, bytes.byteLength)
    await store.appendStaging(token, 0, bytes.subarray(0, 2))
    await store.appendStaging(token, 2, bytes.subarray(2))
    await expect(store.verifyStaging(token, bytes.byteLength, '0'.repeat(64))).rejects.toThrow('integrity check')
    const ref = await store.commitStaging(token, bytes.byteLength, hash)
    expect(await store.read(ref)).toEqual(bytes)
    await expect(readFile(join(stagingRoot, `${token}.part`))).rejects.toThrow()
  })

  it('retains a safe original name for general media while preserving the v1 opaque disk layout', async () => {
    const { root, store } = await fixture()
    const token = '4'.repeat(64)
    const bytes = Uint8Array.from([137, 80, 78, 71])
    const hash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    await store.beginStaging(token, bytes.byteLength)
    await store.appendStaging(token, 0, bytes)
    const ref = await store.commitNamedStaging(token, bytes.byteLength, hash, '原始画面.png')

    expect(ref).toEqual({
      attachmentId: `volcengine-original:v1:sha256:${hash}`,
      name: '原始画面.png',
      bytes: bytes.byteLength,
    })
    // The suffix is an old v1 implementation detail, not a media conversion.
    expect(await readFile(join(root, `${hash}.mp4`))).toEqual(Buffer.from(bytes))
    const restarted = new OriginalMediaStore(root)
    await expect(restarted.verify(ref)).resolves.toBeUndefined()
    expect(await restarted.read(ref)).toEqual(bytes)
  })

  it('publishes a verified workspace copy without overwriting a conflicting destination', async () => {
    const { root, store } = await fixture()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-volcengine-workspace-copy-'))
    roots.push(workspace)
    const bytes = Uint8Array.of(4, 8, 15, 16, 23, 42)
    const ref = await store.persistVideo(bytes)
    const target = join(workspace, 'source.mp4')

    await expect(store.copyTo(ref, target)).resolves.toMatchObject({
      bytes: bytes.byteLength,
      reused: false,
      sha256: ref.attachmentId.slice(-64),
    })
    expect(await readFile(target)).toEqual(Buffer.from(bytes))
    await expect(new OriginalMediaStore(root).copyTo(ref, target)).resolves.toMatchObject({ reused: true })

    const conflicting = join(workspace, 'conflict.mp4')
    await writeFile(conflicting, Uint8Array.of(9, 9, 9))
    await expect(store.copyTo(ref, conflicting)).rejects.toThrow('different bytes')
    expect(await readFile(conflicting)).toEqual(Buffer.from([9, 9, 9]))
    expect((await readdir(workspace)).some(name => name.endsWith('.part'))).toBe(false)
  })

  it('rejects path-like general media names without consuming the staged bytes', async () => {
    const { store } = await fixture()
    const token = '5'.repeat(64)
    const bytes = Uint8Array.of(1)
    const hash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    await store.beginStaging(token, bytes.byteLength)
    await store.appendStaging(token, 0, bytes)
    await expect(store.commitNamedStaging(token, bytes.byteLength, hash, 'C:\\private\\clip.mp4'))
      .rejects.toThrow('file name is invalid')
    await expect(store.verifyStaging(token, bytes.byteLength, hash)).resolves.toBeUndefined()
    await store.discardStaging(token)
  })

  it('reserves declared bytes against live volume capacity while retaining runtime headroom', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-capacity-'))
    roots.push(root)
    const mebibyte = 1024 * 1024
    const store = new OriginalMediaStore(root, { availableBytes: async () => 10n * BigInt(mebibyte) })
    const accepted = 'e'.repeat(64)
    await expect(store.beginStaging(accepted, 9 * mebibyte)).resolves.toBeUndefined()
    await store.discardStaging(accepted)
    await expect(store.beginStaging('f'.repeat(64), 9 * mebibyte + 1))
      .rejects.toBeInstanceOf(OriginalMediaStoreCapacityError)
  })

  it('rechecks live volume capacity immediately before every staging append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-append-capacity-'))
    roots.push(root)
    const mebibyte = 1024 * 1024
    let available = 10n * BigInt(mebibyte)
    const store = new OriginalMediaStore(root, { availableBytes: async () => available })
    const token = '1'.repeat(64)
    await store.beginStaging(token, 1)
    available = BigInt(mebibyte)
    await expect(store.appendStaging(token, 0, Uint8Array.of(1)))
      .rejects.toBeInstanceOf(OriginalMediaStoreCapacityError)
  })

  it('serializes each process-wide capacity check through the corresponding fsynced write', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'dsh-volcengine-capacity-gate-a-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'dsh-volcengine-capacity-gate-b-'))
    roots.push(firstRoot, secondRoot)
    const enough = 100n * 1024n * 1024n
    let gateWrites = false
    let calls = 0
    let active = 0
    let maximumActive = 0
    let entered!: () => void
    let release!: () => void
    const firstEntered = new Promise<void>(resolve => { entered = resolve })
    const firstRelease = new Promise<void>(resolve => { release = resolve })
    const availableBytes = async (): Promise<bigint> => {
      if (!gateWrites) return enough
      calls++
      active++
      maximumActive = Math.max(maximumActive, active)
      if (calls === 1) {
        entered()
        await firstRelease
      }
      active--
      return enough
    }
    const first = new OriginalMediaStore(firstRoot, { availableBytes })
    const second = new OriginalMediaStore(secondRoot, { availableBytes })
    const firstToken = '2'.repeat(64)
    const secondToken = '3'.repeat(64)
    await first.beginStaging(firstToken, 1)
    await second.beginStaging(secondToken, 1)
    gateWrites = true
    const firstWrite = first.appendStaging(firstToken, 0, Uint8Array.of(1))
    await firstEntered
    const secondWrite = second.appendStaging(secondToken, 0, Uint8Array.of(2))
    await Promise.resolve()
    expect(calls).toBe(1)
    release()
    await Promise.all([firstWrite, secondWrite])
    expect(calls).toBe(2)
    expect(maximumActive).toBe(1)
  })
})
