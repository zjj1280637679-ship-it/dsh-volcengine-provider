import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  type Message,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'

import { formatNativeMediaMarker } from '../../src/native-media-marker.js'
import * as VolcenginePlugin from '../../src/plugin.js'
import { enqueueCompletion, MemoryCredentials, MemorySettings } from './fixtures.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { message: string } }
type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>
type Decision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }

const SESSION = 'native-media-session'
const BUNDLE = '9'.repeat(32)
const PROVIDER = 'volcengine-standard'
const MODEL = 'seed-multimodal'

const contexts: Context[] = []
const roots: string[] = []
const servers: FakeArk[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const server of servers.splice(0).reverse()) await server.close()
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function value<T>(result: RpcResult): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

async function boot(root: string, fake: FakeArk): Promise<{
  ctx: Context
  rpc(endpoint: string, payload: unknown): Promise<RpcResult>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(MemoryCredentials, { TEST_NATIVE_MEDIA_KEY: 'fixture-key' })
  ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
  let handler: RpcHandler | undefined
  function handle(
    channel: string,
    candidate: RpcHandler,
    options: { authority: string },
  ): () => void {
    expect(channel).toBe('/volcengine-media')
    expect(options).toEqual({ authority: 'loopback' })
    handler = candidate
    return () => { if (handler === candidate) handler = undefined }
  }
  ctx.provide('connection', { rpc: { handle } })
  await ctx.plugin(VolcenginePlugin, { routes: { standard: {
    kind: 'standard',
    baseURL: `${fake.baseUrl}/api/v3`,
    apiKeyEnv: 'TEST_NATIVE_MEDIA_KEY',
    models: [{ id: MODEL }],
  } } })
  expect(handler).toBeDefined()
  return {
    ctx,
    rpc: (endpoint, payload) => handler!(endpoint, payload, new AbortController().signal),
  }
}

async function eventuallyNoBundles(rpc: (endpoint: string, payload: unknown) => Promise<RpcResult>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = value<{ bundles: unknown[] }>(await rpc('native-list', { sessionId: SESSION }))
    if (result.bundles.length === 0) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('The accepted native media bundle was not retired.')
}

describe('native composer media across restart and the real Ark adapter boundary', () => {
  it('keeps one user message and preserves every original media byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-native-e2e-'))
    roots.push(root)
    const fake = await startFakeArk()
    servers.push(fake)
    const image = await readFile(new URL('../fixtures/live-media/image.png', import.meta.url))
    const video = await readFile(new URL('../fixtures/live-media/video.mp4', import.meta.url))
    const audio = await readFile(new URL('../fixtures/live-media/audio.mp3', import.meta.url))
    const files = [
      { bytes: image.byteLength, mediaType: 'image/png', modality: 'image', name: 'image.png' },
      { bytes: video.byteLength, mediaType: 'video/mp4', modality: 'video', name: 'video.mp4' },
      { bytes: audio.byteLength, format: 'mp3', mediaType: 'audio/mpeg', modality: 'audio', name: 'audio.mp3' },
    ]
    const bytes = [image, video, audio]

    const first = await boot(root, fake)
    const begun = value<{ bundleId: string; files: { fileId: string }[] }>(await first.rpc('native-begin', {
      sessionId: SESSION,
      bundleId: BUNDLE,
      expectedProvider: PROVIDER,
      expectedModel: MODEL,
      files,
    }))
    expect(begun.bundleId).toBe(BUNDLE)
    for (let index = 0; index < bytes.length; index++) {
      const payload = bytes[index]!
      value(await first.rpc('native-append', {
        sessionId: SESSION,
        bundleId: BUNDLE,
        fileId: begun.files[index]!.fileId,
        offset: 0,
        data: payload.toString('base64'),
      }))
    }
    expect(value<{ state: string }>(await first.rpc('native-commit', {
      sessionId: SESSION, bundleId: BUNDLE,
    })).state).toBe('ready')
    expect(value<{ bundles: unknown[] }>(await first.rpc('native-list', {
      sessionId: SESSION,
    })).bundles).toHaveLength(1)

    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const restarted = await boot(root, fake)
    expect(value<{ bundles: unknown[] }>(await restarted.rpc('native-list', {
      sessionId: SESSION,
    })).bundles).toHaveLength(1)

    const source = createUserMessage({
      content: [{ type: 'text', text: `${formatNativeMediaMarker(BUNDLE)} describe all media` }],
      source: { kind: 'user' },
    })
    const agent = {
      id: SESSION,
      session: {
        id: SESSION,
        requestHeader: () => ({ config: { provider: PROVIDER, model: MODEL } }),
      },
      steer: () => {},
    }
    const decision = await (restarted.ctx as unknown as {
      waterfall(name: string, payload: unknown, next: () => Promise<Decision>): Promise<Decision>
    }).waterfall('agent/pre-step', {
      agent,
      messages: [source],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [source] }))
    expect(decision.kind).toBe('enter')
    const accepted = (decision as Extract<Decision, { kind: 'enter' }>).messages[0]!
    expect(accepted.id).toBe(source.id)
    expect(accepted.source).toEqual(source.source)
    expect(accepted.content.map(block => block.type)).toEqual([
      'volcengine-image', 'volcengine-video', 'volcengine-audio', 'text',
    ])
    expect(JSON.stringify(accepted)).not.toContain('__dsh_volc_media_v1_')

    ;(restarted.ctx as unknown as {
      emit(name: string, session: { id: string }, event: { type: string; data: unknown }): void
    }).emit('session/event', { id: SESSION }, { type: 'user/message', data: accepted })
    enqueueCompletion(fake, 'all media received')
    for await (const _chunk of restarted.ctx.llm.stream({
      provider: PROVIDER, model: MODEL, messages: [accepted as Message],
    })) { /* exhaust the production adapter stream */ }

    expect(fake.requests).toHaveLength(1)
    const body = fake.requests[0]!.json as {
      messages: [{ content: Array<{
        type: string
        image_url?: { url: string }
        video_url?: { url: string }
        input_audio?: { data: string; format: string }
        text?: string
      }> }]
    }
    const sent = body.messages[0].content
    expect(sent.map(part => part.type)).toEqual(['image_url', 'video_url', 'input_audio', 'text'])
    expect(sent[3]).toEqual({ type: 'text', text: ' describe all media' })
    const imagePrefix = 'data:image/png;base64,'
    const videoPrefix = 'data:video/mp4;base64,'
    expect(sent[0]!.image_url!.url.startsWith(imagePrefix)).toBe(true)
    expect(sent[1]!.video_url!.url.startsWith(videoPrefix)).toBe(true)
    expect(hash(Buffer.from(sent[0]!.image_url!.url.slice(imagePrefix.length), 'base64'))).toBe(hash(image))
    expect(hash(Buffer.from(sent[1]!.video_url!.url.slice(videoPrefix.length), 'base64'))).toBe(hash(video))
    expect(sent[2]!.input_audio!.format).toBe('mp3')
    expect(hash(Buffer.from(sent[2]!.input_audio!.data, 'base64'))).toBe(hash(audio))
    expect(JSON.stringify(fake.requests[0]!.json)).not.toContain('__dsh_volc_media_v1_')
    await eventuallyNoBundles(restarted.rpc)
  })
})
