import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OriginalVideoStaging } from '../../src/media-fallback-rpc.js'
import { registerLocalMediaCommand } from '../../src/media-command.js'
import { OriginalMediaStore } from '../../src/original-media-store.js'

type Invocation = {
  agent: {
    id: string
    session: { id: string; requestHeader(): { config: { provider: string; model: string } } | undefined }
    steer(message: UserMessage): void
  }
  rawInput: string
  attachments: readonly unknown[]
  signal: AbortSignal
}

type Result = { kind: 'success' | 'error'; text?: string }
type Definition = {
  name: string
  input?: { hint: string; attachments?: true; images?: boolean }
  recordInput?: boolean
  handler(invocation: Invocation): Result | Promise<Result>
}

class CommandRegistry {
  current: Definition | undefined
  register(definition: Definition): () => void {
    this.current = definition
    return () => { if (this.current === definition) this.current = undefined }
  }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function stage(staging: OriginalVideoStaging, bytes: Uint8Array, overrides: Record<string, unknown> = {}): Promise<string> {
  const begun = await staging.begin({
    sessionId: 'session-one', name: 'clip.mp4', mediaType: 'video/mp4', bytes: bytes.byteLength,
    prompt: 'Explain the complete video.', clientSubmissionId: '12345678-1234-4234-9234-123456789abc',
    expectedProvider: 'volcengine-coding-plan', expectedModel: 'seed-video',
    ...overrides,
  })
  await staging.append({
    sessionId: 'session-one', token: begun.token, offset: 0, data: Buffer.from(bytes).toString('base64'),
  })
  const committed = await staging.commit('session-one', begun.token)
  expect(committed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  return begun.token
}

function threeArgumentHandle(_channel: string, _handler: unknown, _options: unknown): () => Promise<void> {
  return async () => undefined
}

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-command-'))
  roots.push(root)
  const registry = new CommandRegistry()
  ctx.provide('commands', registry)
  ctx.provide('connection', { rpc: { handle: threeArgumentHandle } })
  const store = new OriginalMediaStore(root)
  const staging = new OriginalVideoStaging(store)
  const owns = vi.fn((provider: string) => provider === 'volcengine-coding-plan')
  const mounted = ctx.plugin((pluginCtx: Context) => registerLocalMediaCommand(pluginCtx, owns, staging))
  await mounted
  return { ctx, registry, staging, store, owns, mounted }
}

function invocation(token: string, options: {
  agentId?: string; sessionId?: string; provider?: string | null; model?: string
  attachments?: readonly unknown[]; signal?: AbortSignal
} = {}) {
  const agentId = options.agentId ?? 'session-one'
  const sessionId = options.sessionId ?? 'session-one'
  const provider = options.provider === undefined ? 'volcengine-coding-plan' : options.provider
  const model = options.model ?? 'seed-video'
  const steer = vi.fn<(message: UserMessage) => void>()
  const request: Invocation = {
    agent: {
      id: agentId,
      session: { id: sessionId, requestHeader: () => provider === null ? undefined : { config: { provider, model } } },
      steer,
    },
    rawInput: token,
    attachments: options.attachments ?? [],
    signal: options.signal ?? new AbortController().signal,
  }
  return { request, steer }
}

describe('token-only original MP4 command', () => {
  it('registers without attachment input and keeps the token out of command logs', async () => {
    const { registry } = await boot()
    expect(registry.current).toMatchObject({
      name: 'ark-media-local', recordInput: false, input: { hint: '<staging-token>' },
    })
    expect(registry.current?.input).not.toHaveProperty('attachments')
    expect(registry.current?.input).not.toHaveProperty('images')
  })

  it('persists and submits the exact original bytes, bound prompt, and no conversion artifacts', async () => {
    const { registry, staging, store } = await boot()
    const bytes = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 9, 8, 7, 6])
    const token = await stage(staging, bytes)
    const { request, steer } = invocation(token)
    await expect(registry.current!.handler(request)).resolves.toEqual({ kind: 'success' })
    expect(steer).toHaveBeenCalledTimes(1)
    const message = steer.mock.calls[0]![0]
    expect(message).toMatchObject({
      role: 'user', source: { kind: 'user' },
      content: [
        {
          type: 'volcengine-video', mediaType: 'video/mp4',
          attachment: {
            attachmentId: expect.stringMatching(/^volcengine-original:v1:sha256:[a-f0-9]{64}$/u),
            name: 'video.mp4', bytes: bytes.byteLength,
          },
        },
        { type: 'text', text: 'Explain the complete video.' },
      ],
    })
    const block = message.content[0] as { attachment: { attachmentId: string; name: string; bytes: number } }
    expect(await store.read(block.attachment)).toEqual(bytes)
    await expect(registry.current!.handler(invocation(token).request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('invalid or no longer available'),
    })
  })

  it('checks exact Agent/Session and bound provider/model before consuming the token', async () => {
    const { ctx, registry, staging, owns } = await boot()
    const token = await stage(staging, Uint8Array.from([1, 2, 3]))
    await expect(registry.current!.handler(invocation(token, { sessionId: 'different' }).request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('identity'),
    })
    await expect(registry.current!.handler(invocation(token, { provider: 'other-provider' }).request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('enabled Volcengine'),
    })
    expect(owns).toHaveBeenLastCalledWith('other-provider')
    const changedModel = invocation(token, { model: 'another-seed-model' })
    await expect(registry.current!.handler(changedModel.request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('provider or model changed'),
    })
    expect(changedModel.steer).not.toHaveBeenCalled()
    const removeProjection = ctx.provide('sessionProjections', {
      stateOf: () => ({ pending: { provider: 'volcengine-coding-plan', model: 'pending-other-model' } }),
    })
    const staleHeader = invocation(token)
    await expect(registry.current!.handler(staleHeader.request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('provider or model changed'),
    })
    expect(staleHeader.steer).not.toHaveBeenCalled()
    removeProjection()
    await expect(registry.current!.handler(invocation(token).request)).resolves.toEqual({ kind: 'success' })

    const bound = await stage(staging, Uint8Array.from([4]), {
      clientSubmissionId: 'aaaaaaaa-1234-4234-9234-123456789abc',
    })
    await expect(registry.current!.handler(invocation(bound, { agentId: 'session-two', sessionId: 'session-two' }).request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('invalid or no longer available'),
    })
    await expect(registry.current!.handler(invocation(bound).request)).resolves.toEqual({ kind: 'success' })
  })

  it('rechecks the authoritative selection after take and immediately before steer', async () => {
    const { registry, staging } = await boot()
    const token = await stage(staging, Uint8Array.from([9, 9]))
    let currentModel = 'seed-video'
    const current = invocation(token)
    current.request.agent.session.requestHeader = () => ({
      config: { provider: 'volcengine-coding-plan', model: currentModel },
    })
    const take = staging.take.bind(staging)
    vi.spyOn(staging, 'take').mockImplementationOnce(async (...args) => {
      const result = await take(...args)
      currentModel = 'changed-during-publication'
      return result
    })

    await expect(registry.current!.handler(current.request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('changed before delivery'),
    })
    expect(current.steer).not.toHaveBeenCalled()
  })

  it('rejects composer attachments, cancellation, and malformed tokens without consuming valid staging', async () => {
    const { registry, staging } = await boot()
    const token = await stage(staging, Uint8Array.from([5, 6]))
    await expect(registry.current!.handler(invocation(token, { attachments: [{}] }).request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('does not accept'),
    })
    const controller = new AbortController()
    controller.abort()
    await expect(registry.current!.handler(invocation(token, { signal: controller.signal }).request)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('cancelled'),
    })
    await expect(registry.current!.handler(invocation('not-a-token').request)).resolves.toMatchObject({ kind: 'error' })
    await expect(registry.current!.handler(invocation(token).request)).resolves.toEqual({ kind: 'success' })
  })

  it('contains persistence and Agent failures without returning paths, bytes, keys, or causes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registry = new CommandRegistry()
    ctx.provide('commands', registry)
    ctx.provide('connection', { rpc: { handle: threeArgumentHandle } })
    const root = await mkdtemp(join(tmpdir(), 'dsh-volcengine-command-failure-'))
    roots.push(root)
    const store = new OriginalMediaStore(root)
    const staging = new OriginalVideoStaging(store)
    await ctx.plugin((pluginCtx: Context) => registerLocalMediaCommand(
      pluginCtx, () => true, staging,
    ))
    const token = await stage(staging, Uint8Array.from([7, 8]))
    vi.spyOn(store, 'commitStaging').mockImplementationOnce(async () => {
      throw new Error('C:\\secret\\clip.mp4 ark-secret raw-bytes')
    })
    const result = await registry.current!.handler(invocation(token).request)
    expect(result).toMatchObject({ kind: 'error' })
    expect(JSON.stringify(result)).not.toMatch(/secret|raw-bytes|ark-/u)
  })
})
