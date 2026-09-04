import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createDefaultModelConfig,
  isModalityEnabled,
  type Modality,
  type ModelFeedback,
} from '../../src/domain.js'
import {
  parseVerbatimDataUrl,
  sha256Hex,
  toVerbatimDataUrl,
} from '../../src/media.js'
import { getDefaultRoute } from '../../src/routes.js'
import { sendArkBytes, sendArkJson } from '../../src/transport.js'
import { buildChatCompletionsBody } from '../../src/wire.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'

describe('fake ark: freedom-preserving media transport', () => {
  let fake!: FakeArk

  beforeEach(async () => {
    fake = await startFakeArk()
  })

  afterEach(async () => {
    await fake.close()
  })

  it('preserves binary upload bytes exactly', async () => {
    const bytes = Uint8Array.from(Array.from({ length: 513 }, (_, index) => (index * 73) % 256))
    const route = {
      ...getDefaultRoute('standard'),
      baseUrl: `${fake.baseUrl}/api/v3`,
    }

    const response = await sendArkBytes({
      route,
      operation: 'files/verbatim-test',
      apiKey: 'binary-secret',
      contentType: 'application/octet-stream',
      body: bytes,
    })

    expect(response.status).toBe(200)
    expect(fake.requests).toHaveLength(1)
    const captured = fake.requests[0]?.body as Uint8Array
    expect(sha256Hex(captured)).toBe(sha256Hex(bytes))
    expect(captured).toEqual(bytes)
  })

  it('preserves media bytes through transparent base64/data-url transport', async () => {
    const bytes = Uint8Array.from(Array.from({ length: 257 }, (_, index) => (255 - index * 29) & 0xff))
    const dataUrl = toVerbatimDataUrl('video/mp4', bytes)
    const body = buildChatCompletionsBody({
      model: 'experimental-video-model',
      messages: [{
        role: 'user',
        content: [{
          type: 'experimental_video',
          source: { url: dataUrl },
        }],
      }],
    })
    const route = {
      ...getDefaultRoute('standard'),
      baseUrl: `${fake.baseUrl}/api/v3`,
    }

    await sendArkJson({
      route,
      operation: 'chat/completions',
      apiKey: 'video-secret',
      body,
    })

    const captured = fake.requests[0]?.json as {
      messages: Array<{ content: Array<{ source: { url: string } }> }>
    }
    const parsed = parseVerbatimDataUrl(captured.messages[0]!.content[0]!.source.url)
    expect(parsed.mediaType).toBe('video/mp4')
    expect(sha256Hex(parsed.data)).toBe(sha256Hex(bytes))
    expect(parsed.data).toEqual(bytes)
  })

  it.each(['image', 'video', 'audio'] as const)(
    'still delivers force-enabled %s input when supplier feedback reports unsupported',
    async (modality: Modality) => {
      const feedback: ModelFeedback = {
        modalities: {
          [modality]: {
            reportedSupport: 'unsupported',
            source: 'volcengine',
          },
        },
        raw: { [`supports_${modality}`]: false },
      }
      const config = createDefaultModelConfig()
      config.modalities[modality].override = 'force_enable'
      expect(feedback.modalities?.[modality]?.reportedSupport).toBe('unsupported')
      expect(isModalityEnabled(config, modality)).toBe(true)

      const bytes = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff])
      const body = buildChatCompletionsBody({
        model: `unknown-${modality}-test-model`,
        messages: [{
          role: 'user',
          content: [{
            type: `experimental_${modality}`,
            data: toVerbatimDataUrl(`application/x-${modality}-test`, bytes),
          }],
        }],
      })
      const route = {
        ...getDefaultRoute('coding-plan'),
        baseUrl: `${fake.baseUrl}/api/coding/v3`,
      }

      await sendArkJson({
        route,
        operation: 'chat/completions',
        apiKey: 'coding-secret',
        body,
      })

      expect(fake.requests.at(-1)?.json).toEqual(body)
    },
  )
})
