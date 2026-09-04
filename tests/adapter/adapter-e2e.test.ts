import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

import { VolcengineChatAdapter } from '../../src/chat/adapter.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'

let fake: FakeArk | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
})

function user(text: string): Message {
  return {
    id: 'msg-user',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as Message
}

function request(provider: string, model = 'unknown-model'): GenerateOptions {
  return {
    provider,
    model,
    messages: [user('hello')],
  } as GenerateOptions
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of input) values.push(value)
  return values
}

function sse(...payloads: unknown[]): string {
  return payloads.map(payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`).join('')
}

describe('step 3 VolcengineChatAdapter against Fake Ark', () => {
  it('performs one real Chat request and translates an SSE completion', async () => {
    fake = await startFakeArk()
    fake.enqueueResponse({
      headers: { 'content-type': 'text/event-stream' },
      body: sse(
        { choices: [{ delta: { content: 'hello' }, finish_reason: null }], usage: null },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        },
        '[DONE]',
      ),
    })
    const adapter = new VolcengineChatAdapter({
      providerNames: { coding: 'Volcengine Coding Plan' },
      resolveConnection: () => ({
        route: {
          kind: 'coding-plan',
          baseUrl: `${fake!.baseUrl}/api/coding/v3`,
          apiKeyEnv: 'TEST',
        },
        apiKey: 'coding-secret',
        customBody: {
          service_tier: 'auto',
          future_nested: { opaque: true },
        },
      }),
    })

    const chunks = await collect(adapter.stream(request('coding')))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.path).toBe('/api/coding/v3/chat/completions')
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer coding-secret')
    expect(fake.requests[0]!.headers['user-agent']).toBeTruthy()
    expect(fake.requests[0]!.json).toMatchObject({
      model: 'unknown-model',
      stream: true,
      service_tier: 'auto',
      future_nested: { opaque: true },
    })
  })

  it('keeps a Coding Plan 429 as one failed attempt and preserves structured facts', async () => {
    fake = await startFakeArk()
    fake.enqueueResponse({
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-429',
        'retry-after': '2',
      },
      body: JSON.stringify({ error: { code: 'rate_limit', message: 'slow down' } }),
    })
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({
        route: {
          kind: 'coding-plan',
          baseUrl: `${fake!.baseUrl}/api/coding/v3`,
          apiKeyEnv: 'TEST',
        },
        apiKey: 'coding-secret',
      }),
    })

    let thrown: unknown
    try {
      await collect(adapter.stream(request('coding')))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'RATE_LIMIT',
      failure: {
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 2000,
        requestId: 'req-429',
      },
    })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.path).toBe('/api/coding/v3/chat/completions')
  })

  it('supports stream:false through custom body instead of forcing SSE', async () => {
    fake = await startFakeArk()
    fake.enqueueResponse({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        choices: [{ message: { content: 'whole response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    })
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({
        route: {
          kind: 'standard',
          baseUrl: `${fake!.baseUrl}/api/v3`,
          apiKeyEnv: 'TEST',
        },
        apiKey: 'standard-secret',
        customBody: { stream: false },
      }),
    })

    const chunks = await collect(adapter.stream(request('standard')))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'whole response' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect((fake.requests[0]!.json as { stream: boolean }).stream).toBe(false)
  })

  it('treats a truncated SSE response as a protocol failure', async () => {
    fake = await startFakeArk()
    fake.enqueueResponse({
      headers: { 'content-type': 'text/event-stream' },
      body: sse({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }),
    })
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({
        route: {
          kind: 'agent-plan',
          baseUrl: `${fake!.baseUrl}/api/plan/v3`,
          apiKeyEnv: 'TEST',
        },
        apiKey: 'agent-secret',
      }),
    })

    await expect(collect(adapter.stream(request('agent')))).rejects.toMatchObject({
      code: 'STREAM_CLOSED',
    })
  })

  it('stores rich model-list fields as feedback without turning them into DSH gates', async () => {
    fake = await startFakeArk()
    fake.enqueueResponse({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        object: 'list',
        data: [{
          id: 'model-x',
          name: 'Model X',
          supports_video: false,
          input_modalities: ['text'],
          context_window: 999999,
          reasoning: { efforts: ['high'] },
          vendor_new_field: { x: 1 },
        }],
      }),
    })
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({
        route: {
          kind: 'standard',
          baseUrl: `${fake!.baseUrl}/api/v3`,
          apiKeyEnv: 'TEST',
        },
        apiKey: 'standard-secret',
      }),
    })

    const models = await adapter.listModels('standard')
    expect(models).toEqual([{ provider: 'standard', id: 'model-x', name: 'Model X' }])
    expect(Object.hasOwn(models[0]!, 'inputModalities')).toBe(false)
    const feedback = adapter.feedback.get('standard', 'model-x')
    expect(feedback?.raw).toMatchObject({
      supports_video: false,
      context_window: 999999,
      vendor_new_field: { x: 1 },
    })
    const resolved = await adapter.resolveModel('standard', 'model-x')
    expect(resolved).toMatchObject({ provider: 'standard', id: 'model-x', name: 'Model X' })
    expect(Object.hasOwn(resolved, 'context')).toBe(false)
    expect(Object.hasOwn(resolved, 'reasoning')).toBe(false)
    expect(Object.hasOwn(resolved, 'inputModalities')).toBe(false)
  })
})
