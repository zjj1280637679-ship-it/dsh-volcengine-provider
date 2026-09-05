import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'

import * as VolcenginePlugin from '../../src/plugin.js'
import { enqueueCompletion, MemoryCredentials, MemorySettings } from './fixtures.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { message: string } }
type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>
type Invocation = {
  agent: {
    id: string
    session: { id: string; requestHeader(): { config: { provider: string; model: string } } }
    steer(message: UserMessage): void
  }
  rawInput: string
  attachments: readonly unknown[]
  signal: AbortSignal
}
type Definition = {
  name: string; recordInput?: boolean
  handler(invocation: Invocation): unknown
}

class Commands {
  readonly definitions = new Map<string, Definition>()
  register(definition: Definition): () => void {
    this.definitions.set(definition.name, definition)
    return () => { if (this.definitions.get(definition.name) === definition) this.definitions.delete(definition.name) }
  }
}

const contexts: Context[] = []
const roots: string[] = []
const servers: FakeArk[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('plugin-wired original MP4 fallback', () => {
  it('routes exact staged bytes through the owned resolver with no Host attachment provider', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-fallback-e2e-'))
    roots.push(root)
    const fake = await startFakeArk()
    servers.push(fake)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryCredentials, { TEST_FALLBACK_KEY: 'fixture-key' })
    const commands = new Commands()
    ctx.provide('commands', commands)
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    let rpcHandler: RpcHandler | undefined
    function handle(channel: string, handler: RpcHandler, options: { authority: string }): () => Promise<void> {
      expect(channel).toBe('/volcengine-media')
      expect(options).toEqual({ authority: 'loopback' })
      rpcHandler = handler
      return ctx.effect(() => async () => { rpcHandler = undefined })
    }
    ctx.provide('connection', { rpc: { handle } })
    await ctx.plugin(VolcenginePlugin, { routes: { standard: {
      kind: 'standard', baseURL: `${fake.baseUrl}/api/v3`, apiKeyEnv: 'TEST_FALLBACK_KEY',
      models: [{ id: 'seed-video', modalities: { video: 'force_enable' } }],
    } } })

    const video = await readFile(new URL('../fixtures/live-media/video.mp4', import.meta.url))
    const begun = await rpcHandler!('begin', {
      sessionId: 'session-one', name: 'video.mp4', mediaType: 'video/mp4', bytes: video.byteLength,
      prompt: 'Understand the complete video.',
      clientSubmissionId: '12345678-1234-4234-9234-123456789abc',
      expectedProvider: 'volcengine-standard', expectedModel: 'seed-video',
    }, new AbortController().signal)
    expect(begun.ok).toBe(true)
    const token = begun.ok ? (begun.value as { token: string }).token : ''
    await expect(rpcHandler!('append', {
      sessionId: 'session-one', token, offset: 0, data: video.toString('base64'),
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true })
    await expect(rpcHandler!('commit', {
      sessionId: 'session-one', token,
    }, new AbortController().signal)).resolves.toEqual({ ok: true, value: { token, sha256: sha256(video) } })
    let message: UserMessage | undefined
    const command = commands.definitions.get('ark-media-local')!
    expect(command.recordInput).toBe(false)
    await expect(command.handler({
      agent: {
        id: 'session-one', session: {
          id: 'session-one', requestHeader: () => ({
            config: { provider: 'volcengine-standard', model: 'seed-video' },
          }),
        },
        steer: value => { message = value },
      },
      rawInput: token, attachments: [], signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'success' })

    enqueueCompletion(fake, 'video understood')
    for await (const _chunk of ctx.llm.stream({
      provider: 'volcengine-standard', model: 'seed-video', messages: [message as Message],
    })) { /* exhaust the real adapter stream */ }
    expect(fake.requests).toHaveLength(1)
    const parts = (fake.requests[0]!.json as {
      messages: [{ content: Array<{ type: string; video_url?: { url: string } }> }]
    }).messages[0].content
    expect(parts.map(part => part.type)).toEqual(['video_url', 'text'])
    const url = parts[0]!.video_url!.url
    const prefix = 'data:video/mp4;base64,'
    expect(url.startsWith(prefix)).toBe(true)
    expect(sha256(Buffer.from(url.slice(prefix.length), 'base64'))).toBe(sha256(video))
  })
})
