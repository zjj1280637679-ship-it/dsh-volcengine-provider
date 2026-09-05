import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type ContentBlock, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'

import * as VolcenginePlugin from '../../src/plugin.js'
import type { ModelCardConfig } from '../../src/config.js'
import type { VerbatimAttachmentRefLike, VolcengineAudioBlock } from '../../src/media.js'
import type { WireUserPart } from '../../src/chat/types.js'
import { enqueueCompletion, MemoryCredentials } from './fixtures.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'

// Self-contained, valid media fixtures; running this suite needs no encoder.
// The 2x1 RGBA PNG has an opaque white pixel and a partially transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4DwQMDf8dAB2tBbzPmOzFAAAAAElFTkSuQmCC', 'base64')
// One black MPEG-4 frame in an MP4 container, generated once with FFmpeg.
const MP4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc282aXNvMm1wNDEAAAL3bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAh50cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAG6bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASVzdGJsAAAA2XN0c2QAAAAAAAAAAQAAAMltcDR2AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABCkxhdmMgbXBlZzQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAT2VzZHMAAAAAA4CAgD4AAQAEgICAMCARAAAAAAMNQAADDUAFgICAHgAAAbABAAABtYkTAAABAAAAASAAxI2IAA0AFABUYwaAgIABAgAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAw1AAAMNQAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAACGlsc3QAAABwbW9vZgAAABBtZmhkAAAAAAAAAAEAAABYdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADFwAAQAAAAAARAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAGHRydW4AAAAFAAAAAQAAAHgCAAAAAAAAGW1kYXQAAAGzABAHAAABthYFGCPbfgAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADFwEBAQAAABBtZnJvAAAAAAAAAEM=', 'base64')
// Two MP3 frames of 44.1 kHz stereo silence, generated once with FFmpeg/LAME.
const MP3 = Buffer.from('//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xJkIg/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=', 'base64')

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function filePath(root: string, ref: VerbatimAttachmentRefLike): string {
  return join(root, ref.attachmentId.slice('sha256:'.length))
}

async function persistFile(root: string, name: string, bytes: Uint8Array): Promise<VerbatimAttachmentRefLike> {
  const ref = { attachmentId: `sha256:${hash(bytes)}`, name, bytes: bytes.byteLength }
  await writeFile(filePath(root, ref), bytes)
  return ref
}

/** Structural implementation of the newer verbatim-file seam over actual disk. */
class DiskAttachments extends Service {
  readonly reads: string[] = []
  readonly closedReads: string[] = []
  imageReads = 0
  onChunk?: () => void

  constructor(ctx: Context, private readonly options: { root: string }) {
    super(ctx, 'attachments')
  }

  async *readFileStream(ref: VerbatimAttachmentRefLike, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    this.reads.push(ref.attachmentId)
    try {
      for await (const chunk of createReadStream(filePath(this.options.root, ref), { highWaterMark: 7, signal })) {
        this.onChunk?.()
        yield chunk as Buffer
      }
    } finally {
      this.closedReads.push(ref.attachmentId)
    }
  }

  async readImage(): Promise<never> {
    this.imageReads += 1
    throw new Error('The original-image path must not call the normalizing image reader.')
  }
}

class ImageOnlyAttachments extends Service {
  imageReads = 0

  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  async readImage(): Promise<never> {
    this.imageReads += 1
    throw new Error('An absent verbatim-file reader must not fall back to normalized images.')
  }
}

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(options: { imageOnly?: boolean; modalities?: ModelCardConfig['modalities'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'volcengine-media-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const fake = await startFakeArk()
  cleanups.push(() => fake.close())
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemoryCredentials, { TEST_VOLCENGINE_MEDIA_KEY: 'media-key' })
  if (options.imageOnly) await ctx.plugin(ImageOnlyAttachments)
  else await ctx.plugin(DiskAttachments, { root })
  await ctx.plugin(VolcenginePlugin, { routes: { standard: {
    kind: 'standard', baseURL: `${fake.baseUrl}/api/v3`, apiKeyEnv: 'TEST_VOLCENGINE_MEDIA_KEY',
    models: [{
      id: 'unknown-future-model',
      ...(options.modalities === undefined ? {} : { modalities: options.modalities }),
    }],
  } } })
  return { root, fake, ctx, attachments: ctx.get('attachments') as unknown as DiskAttachments }
}

/** Persist and reload the message before the actual runtime reads its attachments. */
async function dispatch(
  harness: Awaited<ReturnType<typeof boot>>,
  content: ContentBlock[],
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const message = createUserMessage({ content, source: { kind: 'user' } })
  const messagePath = join(harness.root, 'message.json')
  await writeFile(messagePath, JSON.stringify(message))
  const reloaded = JSON.parse(await readFile(messagePath, 'utf8')) as Message
  const chunks: StreamChunk[] = []
  for await (const chunk of harness.ctx.llm.stream({
    provider: 'volcengine-standard', model: 'unknown-future-model', messages: [reloaded], signal,
  })) chunks.push(chunk)
  return chunks
}

function parts(fake: FakeArk): WireUserPart[] {
  return (fake.requests[0]!.json as { messages: [{ content: WireUserPart[] }] }).messages[0].content
}

function fromDataUrl(url: string, mediaType: string): Buffer {
  const prefix = `data:${mediaType};base64,`
  expect(url.startsWith(prefix)).toBe(true)
  return Buffer.from(url.slice(prefix.length), 'base64')
}

function stereoWav(): Buffer {
  const samples = [1000, -1000, 2000, -2000, 3000, -3000, 4000, -4000]
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(48000, 24)
  wav.writeUInt32LE(48000 * 4, 28)
  wav.writeUInt16LE(4, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * 2))
  return wav
}

describe('persisted media through the real Harness runtime and Ark HTTP boundary', () => {
  it('does not auto-fill modality settings and preserves mixed original media bytes', async () => {
    const harness = await boot()
    const image = await persistFile(harness.root, 'original-alpha.png', PNG)
    const video = await persistFile(harness.root, 'one-frame.mp4', MP4)
    const audio = await persistFile(harness.root, 'stereo.mp3', MP3)
    enqueueCompletion(harness.fake)

    expect((await dispatch(harness, [
      { type: 'text', text: 'before image' },
      { type: 'volcengine-image', attachment: image, mediaType: 'image/png' },
      { type: 'text', text: 'between image and video' },
      { type: 'volcengine-video', attachment: video, mediaType: 'video/mp4' },
      { type: 'volcengine-audio', attachment: audio, mediaType: 'audio/mpeg' },
      { type: 'text', text: 'after audio' },
    ])).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    expect(harness.fake.requests).toHaveLength(1)
    expect(harness.fake.requests[0]!.method).toBe('POST')
    expect(harness.fake.requests[0]!.path).toBe('/api/v3/chat/completions')
    const sent = parts(harness.fake)
    expect(sent.map(part => part.type)).toEqual(['text', 'image_url', 'text', 'video_url', 'input_audio', 'text'])
    expect([sent[0], sent[2], sent[5]]).toEqual([
      { type: 'text', text: 'before image' },
      { type: 'text', text: 'between image and video' },
      { type: 'text', text: 'after audio' },
    ])
    const imageBytes = fromDataUrl((sent[1] as Extract<WireUserPart, { type: 'image_url' }>).image_url.url, 'image/png')
    const videoBytes = fromDataUrl((sent[3] as Extract<WireUserPart, { type: 'video_url' }>).video_url.url, 'video/mp4')
    const sentAudio = (sent[4] as Extract<WireUserPart, { type: 'input_audio' }>).input_audio
    expect(sentAudio.format).toBe('mp3')
    expect(sentAudio.data).not.toContain('data:')
    expect(hash(imageBytes)).toBe(hash(PNG))
    expect(hash(videoBytes)).toBe(hash(MP4))
    expect(hash(Buffer.from(sentAudio.data, 'base64'))).toBe(hash(MP3))
    expect(imageBytes[25]).toBe(6) // PNG IHDR color type: RGBA.
    expect(inflateSync(imageBytes.subarray(41, 41 + imageBytes.readUInt32BE(33)))[8]).toBe(64)
    expect(harness.attachments.reads).toEqual([image.attachmentId, video.attachmentId, audio.attachmentId])
    expect(harness.attachments.closedReads).toEqual(harness.attachments.reads)
    expect(harness.attachments.imageReads).toBe(0)
  })

  it('sends the original 48 kHz stereo WAV without resampling, mixing or replacing PCM samples', async () => {
    const harness = await boot()
    const wav = stereoWav()
    const attachment = await persistFile(harness.root, 'stereo-48000.wav', wav)
    enqueueCompletion(harness.fake)
    expect((await dispatch(harness, [{ type: 'volcengine-audio', attachment, mediaType: 'audio/wav' }])).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const sent = (parts(harness.fake)[0] as Extract<WireUserPart, { type: 'input_audio' }>).input_audio
    expect(sent.format).toBe('wav')
    const decoded = Buffer.from(sent.data, 'base64')
    expect(hash(decoded)).toBe(hash(wav))
    expect(decoded.readUInt32LE(24)).toBe(48000)
    expect(decoded.readUInt16LE(22)).toBe(2)
    expect(decoded.readUInt16LE(34)).toBe(16)
    expect(decoded.subarray(44)).toEqual(wav.subarray(44))
  })

  it('passes a manual vendor audio format to an unknown force-enabled model without discovery', async () => {
    const harness = await boot({ modalities: { audio: 'force_enable' } })
    const bytes = Buffer.from([0, 255, 32, 64, 128, 253, 0, 7])
    const attachment = await persistFile(harness.root, 'experimental.audio', bytes)
    const block: VolcengineAudioBlock = {
      type: 'volcengine-audio', attachment, mediaType: 'application/octet-stream', format: 'vendor-96k-planar-float',
    }
    enqueueCompletion(harness.fake)
    expect((await dispatch(harness, [block])).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(harness.fake.requests).toHaveLength(1)
    expect(harness.fake.requests[0]!.method).toBe('POST')
    expect(harness.fake.requests[0]!.json).toMatchObject({ model: 'unknown-future-model' })
    const sent = (parts(harness.fake)[0] as Extract<WireUserPart, { type: 'input_audio' }>).input_audio
    expect(sent.format).toBe(block.format)
    expect(hash(Buffer.from(sent.data, 'base64'))).toBe(hash(bytes))
  })

  it('does not auto-disable media after a provider rejection', async () => {
    const harness = await boot()
    const attachment = await persistFile(harness.root, 'retry.mp3', MP3)
    const content: ContentBlock[] = [{
      type: 'volcengine-audio', attachment, mediaType: 'audio/mpeg',
    }]
    harness.fake.enqueueResponse({
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'audio_not_supported', message: 'controlled rejection' } }),
    })

    expect((await dispatch(harness, content)).at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error' },
    })
    enqueueCompletion(harness.fake, 'second attempt reached Ark')
    expect((await dispatch(harness, content)).at(-1)).toEqual({
      type: 'finish', reason: { kind: 'stop' },
    })
    expect(harness.fake.requests).toHaveLength(2)
    expect(harness.attachments.reads).toEqual([attachment.attachmentId, attachment.attachmentId])
  })

  it('reports a missing verbatim-file reader without normalizing the image or sending a text substitute', async () => {
    const harness = await boot({ imageOnly: true })
    const attachment = await persistFile(harness.root, 'original.png', PNG)
    const result = await dispatch(harness, [{ type: 'volcengine-image', attachment, mediaType: 'image/png' }])
    expect(result.at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: 'MEDIA_RESOLVER_UNAVAILABLE' } },
    })
    expect(harness.attachments.imageReads).toBe(0)
    expect(harness.fake.requests).toHaveLength(0)
  })

  it('closes an interrupted file read and sends no HTTP request after cancellation', async () => {
    const harness = await boot()
    const attachment = await persistFile(harness.root, 'cancelled.mp4', MP4)
    const controller = new AbortController()
    harness.attachments.onChunk = () => controller.abort()
    const result = await dispatch(harness, [{
      type: 'volcengine-video', attachment, mediaType: 'video/mp4',
    }], controller.signal)
    expect(result.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(harness.attachments.reads).toEqual([attachment.attachmentId])
    expect(harness.attachments.closedReads).toEqual([attachment.attachmentId])
    expect(harness.fake.requests).toHaveLength(0)
  })

  it('rejects each explicitly disabled media modality before reading attachments or sending HTTP', async () => {
    const harness = await boot({ modalities: {
      image: 'force_disable', video: 'force_disable', audio: 'force_disable',
    } })
    const image = await persistFile(harness.root, 'disabled.png', PNG)
    const video = await persistFile(harness.root, 'disabled.mp4', MP4)
    const audio = await persistFile(harness.root, 'disabled.mp3', MP3)
    const blocks: ContentBlock[] = [
      { type: 'volcengine-image', attachment: image, mediaType: 'image/png' },
      { type: 'volcengine-video', attachment: video, mediaType: 'video/mp4' },
      { type: 'volcengine-audio', attachment: audio, mediaType: 'audio/mpeg' },
    ]
    for (const block of blocks) {
      expect((await dispatch(harness, [block])).at(-1)).toMatchObject({
        type: 'finish', reason: { kind: 'error', failure: { code: 'MODALITY_DISABLED' } },
      })
    }
    expect(harness.attachments.reads).toEqual([])
    expect(harness.fake.requests).toHaveLength(0)
  })
})
