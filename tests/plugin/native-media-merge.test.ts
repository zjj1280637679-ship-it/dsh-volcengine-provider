import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatNativeMediaMarker } from '../../src/native-media-marker.js'
import {
  NativeMediaMessageMerger,
  registerNativeMediaMerge,
  type NativeMediaMergeAgent,
  type NativeMediaMergeStaging,
} from '../../src/native-media-merge.js'
import type {
  MaterializedNativeMediaBundle,
  MaterializedNativeMediaFile,
  NativeMediaBundleStatus,
} from '../../src/native-media-staging.js'
import { NativeMediaStaging } from '../../src/native-media-staging.js'
import { OriginalMediaStore } from '../../src/original-media-store.js'

const SESSION = 'session-one'
const PROVIDER = 'volcengine-coding-plan'
const MODEL = 'doubao-seed-2.0-lite'
const FIRST = '1'.repeat(32)
const SECOND = '2'.repeat(32)

const contexts: Context[] = []
const durableStagings: NativeMediaStaging[] = []
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const staging of durableStagings.splice(0)) await staging.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function context(): Context {
  const ctx = new Context()
  ctx.provide('sessions', { flush: async () => true })
  contexts.push(ctx)
  return ctx
}

function file(
  fileId: string,
  modality: 'image' | 'video' | 'audio',
  mediaType: string,
  name: string,
  format?: 'mp3' | 'wav' | 'aac' | 'm4a',
): MaterializedNativeMediaFile {
  const sha256 = fileId.padEnd(64, fileId[0] ?? 'a').slice(0, 64)
  return {
    fileId: fileId.padEnd(32, fileId[0] ?? 'a').slice(0, 32),
    name,
    bytes: 7,
    modality,
    mediaType,
    ...(format === undefined ? {} : { format }),
    sha256,
    attachment: {
      attachmentId: `volcengine-original:v1:sha256:${sha256}`,
      name,
      bytes: 7,
    },
  }
}

function bundle(
  bundleId: string,
  messageId: string,
  files: readonly MaterializedNativeMediaFile[],
): MaterializedNativeMediaBundle {
  return {
    bundleId,
    marker: formatNativeMediaMarker(bundleId),
    sessionId: SESSION,
    messageId,
    expectedProvider: PROVIDER,
    expectedModel: MODEL,
    files,
  }
}

function status(bundleId: string): NativeMediaBundleStatus {
  return {
    bundleId,
    marker: formatNativeMediaMarker(bundleId),
    label: `${bundleId}.media`,
    state: 'ready',
    expectedProvider: PROVIDER,
    expectedModel: MODEL,
    phase: 'armed',
    files: [{ fileId: bundleId, receivedBytes: 7, bytes: 7 }],
  }
}

function stagingFixture(): NativeMediaMergeStaging {
  const content = new Map<string, readonly MaterializedNativeMediaFile[]>([
    [FIRST, [
      file('a', 'image', 'image/png', 'screen.png'),
      file('b', 'video', 'video/quicktime', 'clip.mov'),
      file('c', 'audio', 'audio/x-m4a', 'voice.m4a', 'm4a'),
    ]],
    [SECOND, [file('d', 'video', 'video/mp4', 'second.mp4')]],
  ])
  return {
    status: vi.fn(async (sessionId: string, bundleId: string) => (
      sessionId === SESSION && content.has(bundleId) ? status(bundleId) : undefined
    )),
    claimMany: vi.fn(async (sessionId: string, bundleIds: readonly string[], messageId: string) => (
      sessionId === SESSION && bundleIds.every(bundleId => content.has(bundleId))
        ? bundleIds.map(bundleId => ({
          bundleId, marker: formatNativeMediaMarker(bundleId), sessionId, messageId,
        }))
        : undefined
    )),
    materialize: vi.fn(async (
      sessionId: string, bundleId: string, messageId: string, provider: string, model: string,
    ) => (
      sessionId === SESSION && provider === PROVIDER && model === MODEL && content.has(bundleId)
        ? bundle(bundleId, messageId, content.get(bundleId)!)
        : undefined
    )),
    confirm: vi.fn(async () => true),
    discard: vi.fn(async () => true),
    discardClaim: vi.fn(async () => false),
  }
}

function agent(selection: () => { provider: string; model: string } = () => ({
  provider: PROVIDER, model: MODEL,
}), cwd?: string): NativeMediaMergeAgent {
  return {
    id: SESSION,
    session: {
      id: SESSION,
      ...(cwd === undefined ? {} : { header: { cwd } }),
      requestHeader: () => ({ config: selection() }),
    },
    steer: vi.fn(),
  }
}

function direct(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function textOf(message: UserMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function durableStaging(): Promise<NativeMediaStaging> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-merge-ownership-'))
  roots.push(root)
  const staging = new NativeMediaStaging(new OriginalMediaStore(root))
  durableStagings.push(staging)
  const handle = await staging.begin({
    sessionId: SESSION, bundleId: FIRST, expectedProvider: PROVIDER, expectedModel: MODEL,
    files: [{ name: 'original.png', bytes: 3, modality: 'image', mediaType: 'image/png' }],
  })
  await staging.append({
    sessionId: SESSION, bundleId: FIRST, fileId: handle.files[0]!.fileId,
    offset: 0, data: Uint8Array.of(1, 2, 3),
  })
  await staging.commit(SESSION, FIRST)
  return staging
}

describe('native composer media merge', () => {
  it.each(['claim-conflict', 'duplicate', 'untrusted', 'malformed'] as const)(
    'keeps the original message’s durable media when another message fails with %s', async failure => {
      const staging = await durableStaging()
      const merger = new NativeMediaMessageMerger(context(), staging, provider => provider === PROVIDER)
      const marker = formatNativeMediaMarker(FIRST)
      const original = direct(`${marker} original question`)
      await staging.claim(SESSION, FIRST, original.id)
      const text = failure === 'duplicate' ? `${marker} ${marker} other question`
        : failure === 'malformed' ? `other question ${marker}` : `${marker} other question`
      const competing = createUserMessage({
        content: [{ type: 'text', text }],
        source: failure === 'untrusted' ? { kind: 'plugin', plugin: 'fixture' } : { kind: 'user' },
      })

      const rejected = (await merger.merge(agent(), [competing], new AbortController().signal))[0]!
      await merger.whenConfirmationsIdle()
      expect(textOf(rejected)).toContain('本条附件未发送：')
      expect(textOf(rejected)).toContain('请重新添加。')
      expect(textOf(rejected)).not.toContain('VOLCENGINE_MEDIA_OMITTED')
      expect(textOf(rejected)).toContain('other question')
      expect(await staging.status(SESSION, FIRST)).toMatchObject({ state: 'claimed', messageId: original.id })
      const materialized = await staging.materialize(SESSION, FIRST, original.id, PROVIDER, MODEL)
      expect(materialized).toBeDefined()
      expect(await staging.store.read(materialized!.files[0]!.attachment)).toEqual(Uint8Array.of(1, 2, 3))
      expect(await staging.confirm(SESSION, FIRST, original.id)).toBe(true)
    },
  )

  it.each([false, true])('still cleans a failed message’s own bundle (claimed: %s)', async claimed => {
    const staging = await durableStaging()
    const merger = new NativeMediaMessageMerger(context(), staging, provider => provider === PROVIDER)
    const message = direct(`malformed placement ${formatNativeMediaMarker(FIRST)}`)
    if (claimed) await staging.claim(SESSION, FIRST, message.id)
    await merger.merge(agent(), [message], new AbortController().signal)
    await merger.whenConfirmationsIdle()
    expect(await staging.status(SESSION, FIRST)).toBeUndefined()
  })

  it('reuses the accepted native message and inserts every bundle at its marker position', async () => {
    const ctx = context()
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(ctx, staging, provider => provider === PROVIDER)
    const markerOne = formatNativeMediaMarker(FIRST)
    const markerTwo = formatNativeMediaMarker(SECOND)
    const source = direct(`${markerOne} ${markerTwo} explain both files`)
    const signal = new AbortController().signal

    const result = await merger.merge(agent(), [source], signal)

    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe(source.id)
    expect(result[0]!.source).toEqual(source.source)
    expect(result[0]!.content).toEqual([
      expect.objectContaining({ type: 'volcengine-image', mediaType: 'image/png' }),
      expect.objectContaining({ type: 'volcengine-video', mediaType: 'video/quicktime' }),
      expect.objectContaining({ type: 'volcengine-audio', mediaType: 'audio/x-m4a', format: 'm4a' }),
      { type: 'text', text: ' ' },
      expect.objectContaining({ type: 'volcengine-video', mediaType: 'video/mp4' }),
      { type: 'text', text: ' explain both files' },
    ])
    expect(JSON.stringify(result)).not.toContain('__dsh_volc_media_v1_')
    expect(Object.isFrozen(result[0])).toBe(true)
    expect(staging.claimMany).toHaveBeenCalledOnce()
    expect(staging.claimMany).toHaveBeenCalledWith(
      SESSION, [FIRST, SECOND], String(source.id), signal,
    )

    merger.observeSessionEvent({ id: SESSION }, { type: 'user/message', data: result[0] })
    await merger.whenConfirmationsIdle()
    expect(staging.confirm).toHaveBeenCalledTimes(2)
    expect(staging.confirm).toHaveBeenCalledWith(SESSION, FIRST, String(source.id))
    expect(staging.confirm).toHaveBeenCalledWith(SESSION, SECOND, String(source.id))
  })

  it('removes duplicate and unavailable references while preserving accepted text', async () => {
    const ctx = context()
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true)
    const marker = formatNativeMediaMarker(FIRST)
    const duplicate = direct(`${marker} ${marker} keep this question`)

    const duplicateResult = (await merger.merge(
      agent(), [duplicate], new AbortController().signal,
    ))[0]!
    expect(textOf(duplicateResult)).toContain(' keep this question')
    expect(textOf(duplicateResult)).toBe('[本条附件未发送：附件重复。请重新添加。]  keep this question')
    expect(JSON.stringify(duplicateResult)).not.toContain(marker)
    expect(staging.status).not.toHaveBeenCalled()

    const unknown = 'f'.repeat(32)
    const unavailable = direct(`${formatNativeMediaMarker(unknown)} question remains`)
    const unavailableResult = (await merger.merge(
      agent(), [unavailable], new AbortController().signal,
    ))[0]!
    expect(textOf(unavailableResult)).toContain(' question remains')
    expect(textOf(unavailableResult)).toBe('[本条附件未发送：附件已失效。请重新添加。] question remains')
    expect(JSON.stringify(unavailableResult)).not.toContain('__dsh_volc_media_v1_')
    expect(staging.claimMany).not.toHaveBeenCalled()
  })

  it('never consumes a media marker moved behind user text', async () => {
    const ctx = context()
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true)
    const marker = formatNativeMediaMarker(FIRST)
    const message = direct(`ordinary text before ${marker} remains`)

    const result = (await merger.merge(
      agent(), [message], new AbortController().signal,
    ))[0]!

    expect(textOf(result)).toContain('ordinary text before ')
    expect(textOf(result)).toContain(' remains')
    expect(textOf(result)).toBe('ordinary text before [本条附件未发送：附件位置或引用无效。请重新添加。] remains')
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(staging.status).not.toHaveBeenCalled()
    expect(staging.claimMany).not.toHaveBeenCalled()
  })

  it('preserves accepted content when the route and diagnostic sink are unavailable', async () => {
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { throw new Error('logger unavailable') })
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(ctx, staging, provider => provider === PROVIDER)
    const unchanged = { type: 'text' as const, text: '\n第二段\t原文' }
    const message = createUserMessage({
      content: [{ type: 'text', text: `\t${formatNativeMediaMarker(FIRST)}\n  原文\t` }, unchanged],
      source: { kind: 'user' },
    })

    const result = (await merger.merge(
      agent(() => ({ provider: 'another-provider', model: MODEL })),
      [message], new AbortController().signal,
    ))[0]!

    expect(result.id).toBe(message.id)
    expect(result.source).toEqual(message.source)
    expect(result.content).toEqual([
      { type: 'text', text: '\t[本条附件未发送：方舟模型不可用。请重新添加。]\n  原文\t' },
      unchanged,
    ])
    expect(warn).toHaveBeenCalledExactlyOnceWith('dsh-volcengine-provider: native media omitted (ROUTE_UNAVAILABLE)')
    expect(staging.status).not.toHaveBeenCalled()
    await merger.whenConfirmationsIdle()
    expect(staging.discard).toHaveBeenCalledWith(SESSION, FIRST, expect.any(AbortSignal))
  })

  it('contains materialization errors and never exposes their paths, bytes, or marker', async () => {
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const staging = stagingFixture()
    vi.mocked(staging.materialize).mockRejectedValueOnce(
      new Error('C:\\private\\movie.mp4 secret-provider-byte-sequence'),
    )
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true)
    const message = direct(`${formatNativeMediaMarker(FIRST)} keep this accepted text`)

    const result = (await merger.merge(agent(), [message], new AbortController().signal))[0]!

    expect(textOf(result)).toContain(' keep this accepted text')
    expect(textOf(result)).toContain('[本条附件未发送：无法读取附件。请重新添加。]')
    expect(warn).toHaveBeenCalledWith('dsh-volcengine-provider: native media omitted (MEDIA_UNAVAILABLE)')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret-provider|byte-sequence|__dsh_volc/u)
    expect(JSON.stringify(result)).not.toMatch(/private|secret-provider|byte-sequence|__dsh_volc/u)
    expect(staging.discardClaim).toHaveBeenCalledWith(
      SESSION, FIRST, String(message.id), expect.any(AbortSignal),
    )
    expect(result.content.some(block => block.type.startsWith('volcengine-'))).toBe(false)
  })

  it('rechecks live routing after materialization and drops media on a model switch', async () => {
    const ctx = context()
    const staging = stagingFixture()
    let model = MODEL
    const original = staging.materialize
    vi.mocked(staging.materialize).mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      model = 'changed-after-claim'
      return result
    })
    const merger = new NativeMediaMessageMerger(ctx, staging, provider => provider === PROVIDER)
    const message = direct(`${formatNativeMediaMarker(FIRST)} explain this please`)

    const result = (await merger.merge(
      agent(() => ({ provider: PROVIDER, model })),
      [message],
      new AbortController().signal,
    ))[0]!

    expect(textOf(result)).toContain('[本条附件未发送：所选模型已改变。请重新添加。]')
    expect(textOf(result)).toContain(' explain this please')
    expect(result.content.some(block => block.type.startsWith('volcengine-'))).toBe(false)
    expect(staging.discardClaim).toHaveBeenCalledWith(
      SESSION, FIRST, String(message.id), expect.any(AbortSignal),
    )
  })

  it('never holds accepted text behind a stalled fallback cleanup', async () => {
    vi.useFakeTimers()
    const ctx = context()
    const staging = stagingFixture()
    vi.mocked(staging.status).mockResolvedValueOnce(undefined)
    vi.mocked(staging.discardClaim).mockImplementationOnce(async (
      _sessionId, _bundleId, _messageId, signal,
    ) => await new Promise<boolean>((_resolve, reject) => {
      const aborted = (): void => reject(signal?.reason ?? new Error('aborted'))
      if (signal?.aborted) aborted()
      else signal?.addEventListener('abort', aborted, { once: true })
    }))
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true)
    const message = direct(`${formatNativeMediaMarker(FIRST)} keep text moving`)

    const result = (await merger.merge(
      agent(), [message], new AbortController().signal,
    ))[0]!

    expect(textOf(result)).toContain('[本条附件未发送：附件已失效。请重新添加。]')
    expect(textOf(result)).toContain(' keep text moving')
    await vi.advanceTimersByTimeAsync(2_000)
    await merger.whenConfirmationsIdle()
  })

  it('does not let a non-user source claim a composer bundle or leak its marker', async () => {
    const ctx = context()
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true)
    const marker = formatNativeMediaMarker(FIRST)
    const message = createUserMessage({
      content: [{ type: 'text', text: `plugin text ${marker} survives` }],
      source: { kind: 'plugin', plugin: 'fixture' },
    })

    const result = (await merger.merge(agent(), [message], new AbortController().signal))[0]!

    expect(textOf(result)).toContain('plugin text ')
    expect(textOf(result)).toContain(' survives')
    expect(textOf(result)).toContain('[本条附件未发送：附件不属于当前输入。请重新添加。]')
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(staging.status).not.toHaveBeenCalled()
    expect(staging.claimMany).not.toHaveBeenCalled()
  })

  it('does not confirm if another middleware replaces the augmented content before commit', async () => {
    const ctx = context()
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true)
    const original = direct(`${formatNativeMediaMarker(FIRST)} question`)
    const accepted = (await merger.merge(
      agent(), [original], new AbortController().signal,
    ))[0]!
    expect(accepted.id).toBe(original.id)

    merger.observeSessionEvent({ id: SESSION }, { type: 'user/message', data: original })
    await merger.whenConfirmationsIdle()

    expect(staging.confirm).not.toHaveBeenCalled()
    expect(staging.discardClaim).toHaveBeenCalledWith(
      SESSION, FIRST, String(original.id), undefined,
    )
  })

  it('retains distinct verified paths when identical bytes have different source names', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dsh-native-copy-store-'))
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-native-copy-workspace-'))
    roots.push(storeRoot, workspace)
    const store = new OriginalMediaStore(storeRoot)
    const bytes = Uint8Array.of(1, 2, 3, 4)
    const original = await store.persistVideo(bytes)
    const first = { ...original, name: 'first.mp4' }
    const second = { ...original, name: 'second.mp4' }
    const staging = stagingFixture()
    const ctx = context()
    const message = direct(`${formatNativeMediaMarker(FIRST)} compare both names`)
    vi.mocked(staging.materialize).mockResolvedValueOnce(bundle(FIRST, message.id, [
      { ...file('a', 'video', 'video/mp4', first.name), sha256: store.hashOf(first), attachment: first },
      { ...file('b', 'video', 'video/mp4', second.name), sha256: store.hashOf(second), attachment: second },
    ]))
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true, store)

    const accepted = (await merger.merge(
      agent(undefined, workspace), [message], new AbortController().signal,
    ))[0]!
    const media = accepted.content.filter(block => block.type === 'volcengine-video')

    expect(media).toHaveLength(2)
    expect(media[0]!.sourcePath).not.toBe(media[1]!.sourcePath)
    expect(media[0]!.sourcePath).toMatch(/[\\/]first\.mp4$/u)
    expect(media[1]!.sourcePath).toMatch(/[\\/]second\.mp4$/u)
    expect(await readFile(join(workspace, media[0]!.sourcePath!))).toEqual(Buffer.from(bytes))
    expect(await readFile(join(workspace, media[1]!.sourcePath!))).toEqual(Buffer.from(bytes))
  })

  it('keeps accepted media but omits a working-copy path under read-only policy', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dsh-native-readonly-store-'))
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-native-readonly-workspace-'))
    roots.push(storeRoot, workspace)
    const ctx = context()
    ctx.provide('sandboxPolicy', {
      resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }),
    })
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(
      ctx, staging, () => true, new OriginalMediaStore(storeRoot),
    )
    const message = direct(`${formatNativeMediaMarker(FIRST)} keep this request`)

    const accepted = (await merger.merge(
      agent(undefined, workspace), [message], new AbortController().signal,
    ))[0]!

    expect(accepted.content.some(block => block.type.startsWith('volcengine-'))).toBe(true)
    expect(accepted.content.filter(block => block.type.startsWith('volcengine-'))
      .every(block => !('sourcePath' in block))).toBe(true)
    expect(textOf(accepted)).toContain(' keep this request')
  })

  it('retains the durable bundle receipt until session persistence confirms the message', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const staging = stagingFixture()
    const merger = new NativeMediaMessageMerger(ctx, staging, () => true)
    const original = direct(`${formatNativeMediaMarker(FIRST)} question`)
    const accepted = (await merger.merge(
      agent(), [original], new AbortController().signal,
    ))[0]!

    merger.observeSessionEvent({ id: SESSION }, { type: 'user/message', data: accepted })
    await merger.whenConfirmationsIdle()

    expect(staging.confirm).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'dsh-volcengine-provider: no session durability backend confirmed the media message; native media receipt retained',
    )
  })

  it('awaits the downstream pre-step decision before merging and confirms only post-commit', async () => {
    const handlers = new Map<string, unknown>()
    const fakeContext = {
      get: (name: string) => name === 'sessions' ? { flush: async () => true } : undefined,
      logger: { warn: vi.fn() },
      on: (name: string, listener: unknown) => { handlers.set(name, listener) },
    } as unknown as Context
    const staging = stagingFixture()
    let downstreamFinished = false
    vi.mocked(staging.status).mockImplementationOnce(async (_sessionId, bundleId) => {
      expect(downstreamFinished).toBe(true)
      return status(bundleId)
    })
    const merger = registerNativeMediaMerge(fakeContext, staging, () => true)
    const message = direct(`${formatNativeMediaMarker(FIRST)} native send`)
    type Decision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
    type PreStep = (
      payload: { agent: NativeMediaMergeAgent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<Decision>,
    ) => Promise<Decision>
    type SessionEvent = (
      session: { id: string }, event: { type: string; data: unknown },
    ) => void
    const preStep = handlers.get('agent/pre-step') as PreStep
    const published = handlers.get('session/event') as SessionEvent

    const decision = await preStep({
      agent: agent(), messages: [message], turn: 1, step: 1,
      signal: new AbortController().signal,
    }, async () => {
      downstreamFinished = true
      return { kind: 'enter', messages: [message] }
    })

    expect(decision.kind).toBe('enter')
    expect(staging.confirm).not.toHaveBeenCalled()
    const accepted = (decision as Extract<Decision, { kind: 'enter' }>).messages[0]!
    published({ id: SESSION }, { type: 'user/message', data: accepted })
    await merger.whenConfirmationsIdle()
    expect(staging.confirm).toHaveBeenCalledWith(SESSION, FIRST, String(message.id))
  })
})
