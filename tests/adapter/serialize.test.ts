import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

import { createDefaultModelConfig } from '../../src/domain.js'
import { parseVerbatimDataUrl, sha256Hex } from '../../src/media.js'
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
    config.modalities.image.override = 'force_enable'
    config.modalities.video.override = 'force_enable'
    config.modalities.audio.override = 'force_enable'

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
      parts[3]!.audio_url as string,
    ]
    const expected = [imageBytes, videoBytes, audioBytes]
    for (const [index, url] of urls.entries()) {
      const parsed = parseVerbatimDataUrl(url!)
      expect(sha256Hex(parsed.data)).toBe(sha256Hex(expected[index]!))
    }
  })

  it('honors explicit local disable without consulting supplier feedback', async () => {
    const config = createDefaultModelConfig()
    config.modalities.video.override = 'force_disable'
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
