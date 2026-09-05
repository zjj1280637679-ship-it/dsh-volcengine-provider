import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

import {
  buildMediaCommandContent, buildMediaContent, MediaCommandInputError, registerMediaCommand,
  type AdmittedMediaAttachment,
} from '../../src/media-command.js'

const original = (name: string): AdmittedMediaAttachment => ({
  type: 'file', attachment: { attachmentId: `fixture:${name}`, name, bytes: 17 },
})
const normalizedImage: AdmittedMediaAttachment = {
  type: 'image',
  attachment: { attachmentId: 'fixture:normalized' as never, name: 'normalized.png', mediaType: 'image/png', width: 1, height: 1, bytes: 9 },
}

describe('explicit media command content', () => {
  it('preserves media order and attachment references without inferring from filenames', () => {
    const attachments = [original('audio.mp3'), original('movie.mp4'), original('source.png')]
    const before = structuredClone(attachments)
    const content = buildMediaContent(attachments, [
      { mediaType: 'video/mp4' }, { mediaType: 'audio/mpeg' }, { mediaType: 'image/png' },
    ], '分析 -- 保留此分隔符')

    expect(content).toEqual([
      { type: 'volcengine-video', attachment: attachments[0]!.attachment, mediaType: 'video/mp4' },
      { type: 'volcengine-audio', attachment: attachments[1]!.attachment, mediaType: 'audio/mpeg' },
      { type: 'volcengine-image', attachment: attachments[2]!.attachment, mediaType: 'image/png' },
      { type: 'text', text: '分析 -- 保留此分隔符' },
    ])
    expect(attachments).toEqual(before)
    expect((content[0] as { attachment: unknown }).attachment).toBe(attachments[0]!.attachment)
  })

  it('preserves normalized image blocks and allows attachment-only prompts', () => {
    const content = buildMediaCommandContent('image/png --', [normalizedImage])
    expect(content).toEqual([normalizedImage])
    expect(content[0]).toBe(normalizedImage)
    expect(() => buildMediaCommandContent('image/jpeg -- describe', [normalizedImage])).toThrow(/host-normalized/)
    expect(() => buildMediaCommandContent('video/mp4 -- describe', [normalizedImage])).toThrow(/admitted as image\/png/)
  })

  it('retains an explicit audio format override, including an experimental MIME', () => {
    expect(buildMediaCommandContent('audio/x-custom=VendorFormat -- listen', [original('anything')])[0]).toEqual({
      type: 'volcengine-audio', attachment: original('anything').attachment,
      mediaType: 'audio/x-custom', format: 'VendorFormat',
    })
  })

  it('preserves future MIME tokens and keeps a later delimiter in the question', () => {
    const mediaType = "audio/x-%*'`|~"
    expect(buildMediaCommandContent(`${mediaType}=VendorFormat -- listen -- again`, [original('anything')])).toEqual([
      { type: 'volcengine-audio', attachment: original('anything').attachment, mediaType, format: 'VendorFormat' },
      { type: 'text', text: 'listen -- again' },
    ])
  })

  it.each([
    ['video/mp4 describe', [original('x')], /Use \/ark-media/],
    ['video/mp4 -- describe', [], /at least one/],
    ['video/mp4,audio/wav -- describe', [original('x')], /one MIME type per attachment/],
    ['video/mp4 -- describe', [original('x'), original('y')], /one MIME type per attachment/],
    ['application/pdf -- describe', [original('x')], /explicit image, video, or audio/],
    ['video/* -- describe', [original('x')], /Invalid media declaration/],
    ['video/mp4, -- describe', [original('x'), original('y')], /Invalid media declaration/],
    ['image/png=jpeg -- describe', [original('x')], /only for audio/],
    ['audio/wav= -- describe', [original('x')], /Invalid media declaration/],
  ] as const)('refuses an unusable media declaration: %s', (input, attachments, message) => {
    expect(() => buildMediaCommandContent(input, attachments)).toThrow(MediaCommandInputError)
    expect(() => buildMediaCommandContent(input, attachments)).toThrow(message)
  })
})

type Invocation = {
  agent: { session: { requestHeader(): { config: { provider: string } } | undefined }; steer(message: UserMessage): void }
  rawInput: string
  attachments: readonly AdmittedMediaAttachment[]
  signal: AbortSignal
}
type Definition = {
  name: string
  input: { attachments: true }
  handler(invocation: Invocation): { kind: 'success' | 'error'; text?: string }
}

/** A Commands boundary double; Cordis injection and disposal remain real. */
class CommandRegistry {
  current: Definition | undefined
  removals = 0

  register(definition: Definition): () => void {
    if (this.current !== undefined) throw new Error('duplicate command')
    this.current = definition
    return () => {
      if (this.current === definition) {
        this.current = undefined
        this.removals++
      }
    }
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function boot(options: { fileReader?: boolean; commands?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const registry = new CommandRegistry()
  if (options.commands !== false) ctx.provide('commands', registry)
  ctx.provide('attachments', options.fileReader === false ? {} : { readFileStream: vi.fn() })
  const owns = vi.fn((provider: string) => provider === 'volcengine-standard')
  const mounted = ctx.plugin((pluginCtx: Context) => registerMediaCommand(pluginCtx, owns))
  await mounted
  return { ctx, registry, owns, mounted }
}

function invocation(provider: string | null = 'volcengine-standard') {
  const steer = vi.fn<(message: UserMessage) => void>()
  const controller = new AbortController()
  const request: Invocation = {
    agent: { session: { requestHeader: () => provider === null ? undefined : { config: { provider } } }, steer },
    rawInput: 'video/mp4 -- describe', attachments: [original('clip.mp4')], signal: controller.signal,
  }
  return { request, steer, controller }
}

describe('media command public service wiring', () => {
  it('does not register on the image-only attachment baseline', async () => {
    const { registry } = await boot({ fileReader: false })
    expect(registry.current).toBeUndefined()
  })

  it('waits for Commands and unregisters on service replacement and plugin disposal', async () => {
    const { ctx, registry, mounted } = await boot({ commands: false })
    expect(registry.current).toBeUndefined()
    const removeCommands = ctx.provide('commands', registry)
    await vi.waitFor(() => expect(registry.current?.name).toBe('ark-media'))
    expect(registry.current?.input.attachments).toBe(true)
    removeCommands()
    await vi.waitFor(() => expect(registry.current).toBeUndefined())
    ctx.provide('commands', registry)
    await vi.waitFor(() => expect(registry.current?.name).toBe('ark-media'))
    await mounted.dispose()
    expect(registry.current).toBeUndefined()
    expect(registry.removals).toBe(2)
  })

  it('submits a real immutable identified user message through Agent.steer', async () => {
    const { registry } = await boot()
    const { request, steer } = invocation()
    expect(registry.current!.handler(request)).toEqual({ kind: 'success' })
    expect(steer).toHaveBeenCalledTimes(1)
    const message = steer.mock.calls[0]![0]
    expect(message).toMatchObject({
      id: expect.any(String), role: 'user', source: { kind: 'user' },
      content: [
        { type: 'volcengine-video', attachment: request.attachments[0]!.attachment, mediaType: 'video/mp4' },
        { type: 'text', text: 'describe' },
      ],
    })
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })

  it('honors pending UI selection before the last header and default model', async () => {
    const { ctx, registry, owns } = await boot()
    ctx.provide('sessionProjections', { stateOf: () => ({ pending: { provider: 'another-provider' } }) })
    const currentSelection = vi.fn(() => ({ provider: 'volcengine-standard' }))
    ctx.provide('agentDefaultModel', { currentSelection })
    const { request, steer } = invocation()
    expect(registry.current!.handler(request)).toMatchObject({ kind: 'error', text: expect.stringContaining('enabled Volcengine') })
    expect(owns).toHaveBeenLastCalledWith('another-provider')
    expect(steer).not.toHaveBeenCalled()
    expect(currentSelection).not.toHaveBeenCalled()
  })

  it('uses the recorded header before a default and uses the default for a blank session', async () => {
    const { ctx, registry, owns } = await boot()
    ctx.provide('sessionProjections', { stateOf: () => ({ pending: null }) })
    const currentSelection = vi.fn(() => ({ provider: 'another-provider' }))
    ctx.provide('agentDefaultModel', { currentSelection })
    expect(registry.current!.handler(invocation().request)).toEqual({ kind: 'success' })
    expect(owns).toHaveBeenLastCalledWith('volcengine-standard')
    expect(currentSelection).not.toHaveBeenCalled()
    expect(registry.current!.handler(invocation(null).request)).toMatchObject({ kind: 'error' })
    expect(owns).toHaveBeenLastCalledWith('another-provider')
    expect(currentSelection).toHaveBeenCalledTimes(1)
  })

  it('reports an unknown selection without guessing from Agent.options', async () => {
    const { registry, owns } = await boot()
    const { request, steer } = invocation(null)
    Object.assign(request.agent, { options: { provider: 'volcengine-standard' } })
    expect(registry.current!.handler(request)).toMatchObject({ kind: 'error', text: expect.stringContaining('selection is unavailable') })
    expect(owns).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
  })

  it('reports cancellation and declaration errors before scheduling any model work', async () => {
    const { registry } = await boot()
    const { request, steer, controller } = invocation()
    controller.abort(new Error('user cancelled'))
    expect(registry.current!.handler(request)).toMatchObject({ kind: 'error', text: expect.stringContaining('cancelled') })
    expect(steer).not.toHaveBeenCalled()
    const invalid = invocation()
    invalid.request.rawInput = 'video/mp4,audio/wav -- describe'
    expect(registry.current!.handler(invalid.request)).toMatchObject({ kind: 'error', text: expect.stringContaining('one MIME type per attachment') })
    expect(invalid.steer).not.toHaveBeenCalled()
  })

  it('uses current route ownership and lets the Commands owner handle an Agent failure', async () => {
    const { registry, owns } = await boot()
    const { request, steer } = invocation()
    owns.mockReturnValueOnce(false)
    expect(registry.current!.handler(request)).toMatchObject({ kind: 'error' })
    expect(steer).not.toHaveBeenCalled()
    const failure = new Error('Agent was disposed')
    steer.mockImplementationOnce(() => { throw failure })
    expect(() => registry.current!.handler(request)).toThrow(failure)
  })
})
