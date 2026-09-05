import { describe, expect, it, vi } from 'vitest'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

import { createDefaultModelConfig } from '../../src/domain.js'
import { decodeVerbatimBase64, parseVerbatimDataUrl, sha256Hex } from '../../src/media.js'
import { serializeChatRequest } from '../../src/chat/serialize.js'

type LooseMessage = Omit<Message, 'id' | 'source'> & { id: string; source: { kind: 'user' } }

function user(content: Message['content']): Message {
  return {
    id: 'msg-test',
    role: 'user',
    content,
    source: { kind: 'user' },
  } as unknown as Message
}

function options(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'volcengine-coding-plan',
    model: 'model-not-in-any-catalog',
    messages,
    ...extra,
  } as GenerateOptions
}

function attachment(id: string, bytes: number) {
  return { attachmentId: id, name: `${id}.bin`, bytes }
}

function toolResult(callId: string, content: ContentBlock[]): Message {
  return user([{
    type: 'tool-result', toolCallId: callId as never, content,
  }])
}

describe('step 3 serializer', () => {
  it('maps Harness-neutral controls but leaves thinking to custom body', async () => {
    const body = await serializeChatRequest(
      options([user([{ type: 'text', text: 'hello' }])], {
        temperature: 0.2,
        maxTokens: 1234,
        stop: ['END'],
        tools: [{
          name: 'lookup',
          description: 'lookup a value',
          parameters: { type: 'object', properties: {} },
        }],
      }),
      {
        customBody: {
          thinking: { type: 'enabled' },
          future_vendor_field: { opaque: 42 },
        },
      },
    )

    expect(body).toMatchObject({
      model: 'model-not-in-any-catalog',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 1234,
      stop: ['END'],
      thinking: { type: 'enabled' },
      future_vendor_field: { opaque: 42 },
    })
    expect(body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'lookup a value',
        parameters: { type: 'object', properties: {} },
      },
    }])
  })

  it('does not invent a cross-model reasoning mapping', async () => {
    await expect(serializeChatRequest(options([], {
      reasoningEffort: 'high' as GenerateOptions['reasoningEffort'],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('force-enables image/video/audio and preserves provider-boundary bytes', async () => {
    const imageBytes = Uint8Array.from([1, 2, 3, 4])
    const videoBytes = Uint8Array.from([9, 8, 7, 6, 5])
    const audioBytes = Uint8Array.from([10, 20, 30])
    const byId = new Map([
      ['sha256:image', imageBytes],
      ['sha256:video', videoBytes],
      ['sha256:audio', audioBytes],
    ])
    const config = createDefaultModelConfig()
    config.modalities.image = { override: 'force_enable' }
    config.modalities.video = { override: 'force_enable' }
    config.modalities.audio = { override: 'force_enable' }

    const body = await serializeChatRequest(
      options([user([
        { type: 'text', text: 'inspect all media' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:image',
            mediaType: 'image/png',
            bytes: imageBytes.byteLength,
            width: 1,
            height: 1,
          },
        },
        {
          type: 'volcengine-video',
          attachment: attachment('sha256:video', videoBytes.byteLength),
          mediaType: 'video/mp4',
        },
        {
          type: 'volcengine-audio',
          attachment: attachment('sha256:audio', audioBytes.byteLength),
          mediaType: 'audio/wav',
        },
      ] as Message['content'])]),
      {
        modelConfig: config,
        resolveMediaBytes: async block => byId.get(String(block.attachment.attachmentId))!,
      },
    )

    const messages = body.messages as Array<{ role: string; content: unknown }>
    const parts = messages[0]!.content as Array<Record<string, unknown>>
    const urls = [
      (parts[1]!.image_url as { url: string }).url,
      (parts[2]!.video_url as { url: string }).url,
    ]
    const expected = [imageBytes, videoBytes, audioBytes]
    for (const [index, url] of urls.entries()) {
      const parsed = parseVerbatimDataUrl(url!)
      expect(sha256Hex(parsed.data)).toBe(sha256Hex(expected[index]!))
    }
    expect(parts[3]).toEqual({
      type: 'input_audio',
      input_audio: { data: Buffer.from(audioBytes).toString('base64'), format: 'wav' },
    })
    const audio = parts[3]!.input_audio as { data: string }
    expect(sha256Hex(decodeVerbatimBase64(audio.data))).toBe(sha256Hex(audioBytes))
  })

  it('uses the default 45 decimal MB budget only for tool-result image/video and preserves tool text', async () => {
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const body = await serializeChatRequest(options([toolResult('call-default', [
      { type: 'text', text: 'original tool text' },
      {
        type: 'volcengine-video', attachment: attachment('too-large', 45_000_001), mediaType: 'video/mp4',
      },
    ])]), { resolveMediaBytes })

    expect(resolveMediaBytes).not.toHaveBeenCalled()
    const messages = body.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'tool', content: expect.stringMatching(/^original tool text\n/u) })
    expect(messages[0]!.content).toContain('code=TOOL_MEDIA_BUDGET_EXCEEDED')
    expect(messages[0]!.content).toContain('action=omitted_from_this_request')
    expect(messages[0]!.content).toContain('source_file_deleted=false')
  })

  it('applies one configurable cumulative budget in order and never reads an omitted block', async () => {
    const config = createDefaultModelConfig()
    config.agentMediaFallbackMB = 0.000005 // five bytes, using decimal MB
    const byId = new Map([
      ['first-image', Uint8Array.from([1, 2, 3])],
      ['skipped-video', Uint8Array.from([4, 5, 6])],
      ['last-image', Uint8Array.from([7, 8])],
    ])
    const resolveMediaBytes = vi.fn(async block => byId.get(String(block.attachment.attachmentId))!)
    const body = await serializeChatRequest(options([
      toolResult('call-one', [
        { type: 'text', text: 'first result text' },
        { type: 'volcengine-image', attachment: attachment('first-image', 3), mediaType: 'image/png' },
      ]),
      toolResult('call-two', [
        { type: 'text', text: 'second result text' },
        { type: 'volcengine-video', attachment: attachment('skipped-video', 3), mediaType: 'video/mp4' },
        { type: 'volcengine-image', attachment: attachment('last-image', 2), mediaType: 'image/png' },
      ]),
    ]), { modelConfig: config, resolveMediaBytes })

    expect(resolveMediaBytes.mock.calls.map(([block]) => block.attachment.attachmentId))
      .toEqual(['first-image', 'last-image'])
    const messages = body.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>
    expect(messages[0]).toEqual({ role: 'tool', tool_call_id: 'call-one', content: 'first result text' })
    expect(messages[1]).toMatchObject({
      role: 'tool', tool_call_id: 'call-two', content: expect.stringMatching(/^second result text\n/u),
    })
    expect(String(messages[1]!.content)).toContain('media=video')
    expect(String(messages[1]!.content)).toContain('budget_bytes=5')
    expect((messages[2]!.content as Array<{ type: string }>).map(part => part.type))
      .toEqual(['text', 'image_url', 'image_url'])
  })

  it('treats zero as disabled and never applies the tool fallback to direct user media', async () => {
    const config = createDefaultModelConfig()
    config.agentMediaFallbackMB = 0
    const resolveDisabled = vi.fn(async () => Uint8Array.of(9))
    const disabledBody = await serializeChatRequest(options([toolResult('call-disabled', [{
      type: 'volcengine-video', attachment: attachment('unlimited-tool-video', 900_000_000), mediaType: 'video/mp4',
    }])]), { modelConfig: config, resolveMediaBytes: resolveDisabled })
    expect(resolveDisabled).toHaveBeenCalledOnce()
    expect((disabledBody.messages as Array<{ role: string }>).map(message => message.role)).toEqual(['tool', 'user'])
    expect(JSON.stringify(disabledBody.messages)).not.toContain('VOLCENGINE_AGENT_MEDIA_FALLBACK_ERROR')

    const tiny = createDefaultModelConfig()
    tiny.agentMediaFallbackMB = 0.000001
    const resolveUser = vi.fn(async () => Uint8Array.of(8))
    const directBody = await serializeChatRequest(options([user([{
      type: 'volcengine-video', attachment: attachment('direct-user-video', 900_000_000), mediaType: 'video/mp4',
    }])]), { modelConfig: tiny, resolveMediaBytes: resolveUser })
    expect(resolveUser).toHaveBeenCalledOnce()
    expect(JSON.stringify(directBody.messages)).toContain('data:video/mp4;base64,CA==')
    expect(JSON.stringify(directBody.messages)).not.toContain('VOLCENGINE_AGENT_MEDIA_FALLBACK_ERROR')
  })

  it('does not count or omit tool-result audio under the image/video fallback budget', async () => {
    const config = createDefaultModelConfig()
    config.agentMediaFallbackMB = 0.000001
    const resolveMediaBytes = vi.fn(async block => block.type === 'volcengine-audio'
      ? Uint8Array.of(1, 2, 3)
      : Uint8Array.of(4))
    const body = await serializeChatRequest(options([toolResult('call-audio', [
      { type: 'volcengine-audio', attachment: attachment('audio', 99_000_000), mediaType: 'audio/wav' },
      { type: 'volcengine-image', attachment: attachment('image', 1), mediaType: 'image/png' },
    ])]), { modelConfig: config, resolveMediaBytes })
    expect(resolveMediaBytes).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(body.messages)).not.toContain('VOLCENGINE_AGENT_MEDIA_FALLBACK_ERROR')
  })

  it('honors explicit local disable without consulting supplier feedback', async () => {
    const config = createDefaultModelConfig()
    config.modalities.video = { override: 'force_disable' }
    await expect(serializeChatRequest(
      options([user([{
        type: 'volcengine-video',
        attachment: attachment('sha256:video', 1),
        mediaType: 'video/mp4',
      }] as Message['content'])]),
      {
        modelConfig: config,
        resolveMediaBytes: async () => Uint8Array.of(1),
      },
    )).rejects.toMatchObject({ code: 'MODALITY_DISABLED' })
  })
})
