import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, mkdir, readFile, rename, rmdir, stat, statfs, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { VerbatimAttachmentRefLike } from './media.js'

const ATTACHMENT_PREFIX = 'volcengine-original:v1:sha256:'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u
const INSTANCE_PATTERN = /^[a-f0-9]{32}$/u
const MINIMUM_FREE_SPACE_RESERVE = 1024n * 1024n
const MAXIMUM_FREE_SPACE_RESERVE = 64n * 1024n * 1024n
let processCapacityWriteTail: Promise<void> = Promise.resolve()

async function serializedCapacityWrite<T>(operation: () => Promise<T>): Promise<T> {
  const previous = processCapacityWriteTail
  let release!: () => void
  processCapacityWriteTail = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

/** Safe, path-free failure raised by the plugin-owned original-media store. */
export class OriginalMediaStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OriginalMediaStoreError'
  }
}

/** A local-volume capacity failure safe to report without exposing its path. */
export class OriginalMediaStoreCapacityError extends OriginalMediaStoreError {
  constructor() {
    super('This computer does not have enough free staging space for the declared original MP4.')
    this.name = 'OriginalMediaStoreCapacityError'
  }
}

/** Reference format owned exclusively by {@link OriginalMediaStore}. */
export interface OriginalVideoAttachmentRef extends VerbatimAttachmentRefLike {
  readonly attachmentId: `${typeof ATTACHMENT_PREFIX}${string}`
  readonly name: 'video.mp4'
}

type DshHomePath = (...segments: string[]) => string

export interface OriginalMediaStoreOptions {
  /** Test seam; production uses the staging volume's currently available bytes. */
  readonly availableBytes?: (path: string) => Promise<bigint>
  /** Test seam; production mints one unguessable directory per plugin instance. */
  readonly instanceId?: string
}

function fallbackRoot(): string {
  const configured = process.env.DSH_HOME?.trim()
  const home = configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
  return resolve(home, 'attachments', 'volcengine-original', 'v1')
}

/** Resolve the active Harness home without taking a package-version dependency. */
export function originalMediaRoot(ctx: Context): string {
  const service = ctx.get('dshHomePath') as DshHomePath | undefined
  if (typeof service !== 'function') return fallbackRoot()
  let root: string
  try {
    root = service('attachments', 'volcengine-original', 'v1')
  } catch (cause) {
    throw new OriginalMediaStoreError('The Harness media directory is unavailable.', { cause })
  }
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new OriginalMediaStoreError('The Harness media directory is unavailable.')
  }
  return root
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function systemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

interface AttachmentIdLike {
  readonly attachmentId: string
  readonly name?: string
  readonly bytes?: number
}

function attachmentHash(ref: AttachmentIdLike): string | undefined {
  if (!ref.attachmentId.startsWith(ATTACHMENT_PREFIX)) return undefined
  const hash = ref.attachmentId.slice(ATTACHMENT_PREFIX.length)
  return SHA256_PATTERN.test(hash) ? hash : undefined
}

/** Durable content store plus disk-backed, process-local staging files. */
export class OriginalMediaStore {
  private ready: Promise<void> | undefined
  private readonly stagingRoot: string
  private readonly availableBytes: (path: string) => Promise<bigint>

  constructor(readonly root: string, options: OriginalMediaStoreOptions = {}) {
    if (!isAbsolute(root)) throw new OriginalMediaStoreError('The Harness media directory is unavailable.')
    const instanceId = options.instanceId ?? randomBytes(16).toString('hex')
    if (!INSTANCE_PATTERN.test(instanceId)) throw new OriginalMediaStoreError('The original-media store instance id is invalid.')
    this.stagingRoot = join(root, '.staging', instanceId)
    this.availableBytes = options.availableBytes ?? (async path => {
      const volume = await statfs(path, { bigint: true })
      return volume.bavail * volume.bsize
    })
  }

  owns(ref: AttachmentIdLike): boolean {
    return attachmentHash(ref) !== undefined
  }

  private pathFor(hash: string): string {
    return join(this.root, `${hash}.mp4`)
  }

  private stagingPath(token: string): string {
    if (!TOKEN_PATTERN.test(token)) throw new OriginalMediaStoreError('The original-media staging token is invalid.')
    return join(this.stagingRoot, `${token}.part`)
  }

  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.root, { recursive: true })
      await mkdir(this.stagingRoot, { recursive: true })
    })().catch(cause => {
      this.ready = undefined
      throw new OriginalMediaStoreError('The Harness media directory is unavailable.', { cause })
    })
    return this.ready
  }

  private reference(hash: string, bytes: number): OriginalVideoAttachmentRef {
    return { attachmentId: `${ATTACHMENT_PREFIX}${hash}`, name: 'video.mp4', bytes }
  }

  /**
   * Reserve room for every declared but not-yet-written byte. The retained
   * margin is 5% of current free space, bounded to 1-64 MiB; it is a live
   * filesystem safety margin, not a media-size policy.
   */
  private async assertStagingCapacity(requiredBytes: number): Promise<void> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) {
      throw new OriginalMediaStoreError('The original MP4 staging reservation is invalid.')
    }
    let available: bigint
    try {
      available = await this.availableBytes(this.stagingRoot)
    } catch (cause) {
      throw new OriginalMediaStoreError('The local staging volume capacity is unavailable.', { cause })
    }
    if (available <= 0n) throw new OriginalMediaStoreCapacityError()
    const proportional = available / 20n
    const reserve = proportional < MINIMUM_FREE_SPACE_RESERVE
      ? MINIMUM_FREE_SPACE_RESERVE
      : proportional > MAXIMUM_FREE_SPACE_RESERVE ? MAXIMUM_FREE_SPACE_RESERVE : proportional
    if (BigInt(requiredBytes) > available - reserve) throw new OriginalMediaStoreCapacityError()
  }

  private async verifyPath(
    path: string,
    expectedBytes: number,
    expectedHash: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const hash = createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of createReadStream(path, { signal })) {
        signal?.throwIfAborted()
        const data = chunk as Buffer
        bytes += data.byteLength
        if (!Number.isSafeInteger(bytes)) throw new OriginalMediaStoreError('The stored original media is too large to represent safely.')
        hash.update(data)
      }
    } catch (cause) {
      if (cause instanceof OriginalMediaStoreError || signal?.aborted) throw cause
      throw new OriginalMediaStoreError('The stored original media is unavailable.', { cause })
    }
    if (bytes !== expectedBytes || hash.digest('hex') !== expectedHash) {
      throw new OriginalMediaStoreError('The stored original media failed its integrity check.')
    }
  }

  private async verifyPublished(hash: string, bytes: number, signal?: AbortSignal): Promise<void> {
    return this.verifyPath(this.pathFor(hash), bytes, hash, signal)
  }

  /** Persist already-materialized exact bytes; no plugin-defined size policy is applied. */
  async persistVideo(data: Uint8Array, signal?: AbortSignal): Promise<OriginalVideoAttachmentRef> {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(data.byteLength) || data.byteLength <= 0) {
      throw new OriginalMediaStoreError('The original MP4 byte length is invalid.')
    }
    const hash = digest(data)
    const target = this.pathFor(hash)
    await this.ensureReady()
    signal?.throwIfAborted()
    try {
      await this.verifyPublished(hash, data.byteLength, signal)
      return this.reference(hash, data.byteLength)
    } catch (error) {
      const cause = error instanceof OriginalMediaStoreError ? error.cause : undefined
      if (systemCode(cause) !== 'ENOENT') throw error
    }

    const temporary = join(this.root, `.${hash}.${randomBytes(16).toString('hex')}.tmp`)
    let file: Awaited<ReturnType<typeof open>> | undefined
    let published = false
    try {
      file = await open(temporary, 'wx', 0o600)
      await file.writeFile(data)
      await file.sync()
      await file.close()
      file = undefined
      signal?.throwIfAborted()
      try {
        await rename(temporary, target)
        published = true
      } catch (cause) {
        if (systemCode(cause) !== 'EEXIST' && systemCode(cause) !== 'EPERM') throw cause
        await this.verifyPublished(hash, data.byteLength, signal)
      }
      await this.verifyPublished(hash, data.byteLength, signal)
      return this.reference(hash, data.byteLength)
    } catch (cause) {
      if (cause instanceof OriginalMediaStoreError || signal?.aborted) throw cause
      throw new OriginalMediaStoreError('The original MP4 could not be stored.', { cause })
    } finally {
      if (file !== undefined) await file.close().catch(() => undefined)
      if (!published) await unlink(temporary).catch(() => undefined)
    }
  }

  /** Create one empty, unpredictable staging file. */
  async beginStaging(token: string, requiredBytes: number, signal?: AbortSignal): Promise<void> {
    await this.ensureReady()
    signal?.throwIfAborted()
    await this.assertStagingCapacity(requiredBytes)
    signal?.throwIfAborted()
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(this.stagingPath(token), 'wx', 0o600)
      await file.close()
      file = undefined
    } catch (cause) {
      if (signal?.aborted) throw cause
      throw new OriginalMediaStoreError('The original MP4 staging file could not be created.', { cause })
    } finally {
      if (file !== undefined) await file.close().catch(() => undefined)
    }
  }

  /** Write one exact chunk at the already-verified sequential offset. */
  async appendStaging(token: string, offset: number, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || data.byteLength <= 0) {
      throw new OriginalMediaStoreError('The original MP4 staging write is invalid.')
    }
    await serializedCapacityWrite(async () => {
      signal?.throwIfAborted()
      // Re-read live free space immediately before each write. Holding the
      // process-wide gate through fsync prevents concurrent chunks from all
      // spending the same observed headroom.
      await this.assertStagingCapacity(data.byteLength)
      signal?.throwIfAborted()
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        file = await open(this.stagingPath(token), 'r+')
        const current = await file.stat()
        if (!Number.isSafeInteger(current.size) || current.size !== offset) {
          throw new OriginalMediaStoreError('The original MP4 staging sequence failed its integrity check.')
        }
        let written = 0
        while (written < data.byteLength) {
          signal?.throwIfAborted()
          const result = await file.write(data, written, data.byteLength - written, offset + written)
          if (result.bytesWritten <= 0) throw new OriginalMediaStoreError('The original MP4 staging write did not make progress.')
          written += result.bytesWritten
        }
        await file.sync()
      } catch (cause) {
        if (cause instanceof OriginalMediaStoreError || signal?.aborted) throw cause
        throw new OriginalMediaStoreError('The original MP4 staging write failed.', { cause })
      } finally {
        if (file !== undefined) await file.close().catch(() => undefined)
      }
    })
  }

  async verifyStaging(token: string, bytes: number, hash: string, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !SHA256_PATTERN.test(hash)) {
      throw new OriginalMediaStoreError('The original MP4 staging declaration is invalid.')
    }
    await this.verifyPath(this.stagingPath(token), bytes, hash, signal)
  }

  /** Verify again, then atomically promote a staged file to its content address. */
  async commitStaging(
    token: string,
    bytes: number,
    hash: string,
    signal?: AbortSignal,
  ): Promise<OriginalVideoAttachmentRef> {
    await this.verifyStaging(token, bytes, hash, signal)
    signal?.throwIfAborted()
    const staged = this.stagingPath(token)
    const target = this.pathFor(hash)
    let targetExists = false
    try {
      await stat(target)
      targetExists = true
    } catch (cause) {
      if (systemCode(cause) !== 'ENOENT') throw new OriginalMediaStoreError('The original-media destination is unavailable.', { cause })
    }
    if (targetExists) {
      await this.verifyPublished(hash, bytes, signal)
      signal?.throwIfAborted()
      await unlink(staged).catch(error => {
        if (systemCode(error) !== 'ENOENT') throw new OriginalMediaStoreError('The staging file could not be retired.', { cause: error })
      })
    } else {
      try {
        signal?.throwIfAborted()
        await rename(staged, target)
      } catch (cause) {
        if (systemCode(cause) !== 'EEXIST' && systemCode(cause) !== 'EPERM') {
          throw new OriginalMediaStoreError('The original MP4 could not be published.', { cause })
        }
        await this.verifyPublished(hash, bytes, signal)
        await unlink(staged).catch(() => undefined)
      }
    }
    await this.verifyPublished(hash, bytes, signal)
    return this.reference(hash, bytes)
  }

  async discardStaging(token: string, signal?: AbortSignal): Promise<void> {
    await this.ensureReady()
    signal?.throwIfAborted()
    await unlink(this.stagingPath(token)).catch(error => {
      if (systemCode(error) !== 'ENOENT') throw new OriginalMediaStoreError('The staging file could not be discarded.', { cause: error })
    })
    signal?.throwIfAborted()
  }

  /** Remove only this instance's directory, and only when it is already empty. */
  async disposeStagingInstance(): Promise<void> {
    const ready = this.ready
    if (ready === undefined) return
    await ready
    await rmdir(this.stagingRoot).catch(cause => {
      const code = systemCode(cause)
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        throw new OriginalMediaStoreError('The original-media staging directory could not be retired.', { cause })
      }
    })
  }

  /** Read an owned reference only after rechecking both length and digest. */
  async read(ref: VerbatimAttachmentRefLike, signal?: AbortSignal): Promise<Uint8Array> {
    const hash = attachmentHash(ref)
    if (hash === undefined || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
      throw new OriginalMediaStoreError('The original-media reference is invalid.')
    }
    await this.ensureReady()
    signal?.throwIfAborted()
    let stored: Buffer
    try {
      stored = await readFile(this.pathFor(hash))
    } catch (cause) {
      throw new OriginalMediaStoreError('The stored original media is unavailable.', { cause })
    }
    signal?.throwIfAborted()
    if (stored.byteLength !== ref.bytes || digest(stored) !== hash) {
      throw new OriginalMediaStoreError('The stored original media failed its integrity check.')
    }
    return new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength)
  }
}

export function createOriginalMediaStore(ctx: Context): OriginalMediaStore {
  return new OriginalMediaStore(originalMediaRoot(ctx))
}
