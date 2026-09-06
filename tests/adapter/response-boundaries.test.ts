import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'

import { VolcengineChatAdapter } from '../../src/chat/adapter.js'
import { translateCompletion, translateSsePayloads } from '../../src/chat/translate.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'

async function* payloads(values: unknown[]) {
  for (const value of values) yield value === '[DONE]' ? value : JSON.stringify(value)
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of input) chunks.push(chunk)
  return chunks
}

const streamChoice = (delta: unknown, finish_reason: string | null = null, index = 0) => ({
  index, delta, finish_reason,
})
const completionChoice = (content: string, index = 0) => ({
  index, message: { content }, finish_reason: 'stop',
})

describe('basic response boundary contracts', () => {
  it.each([
    null, [], 1, 'text', {}, { choices: null }, { choices: {} }, { choices: [null] },
    { error: { message: {} } }, { error: { code: { toString: null, valueOf: null } } },
  ])(
    'classifies malformed envelope %j in both response modes', async value => {
      for (const response of [translateCompletion(value), translateSsePayloads(payloads([value, '[DONE]']))]) {
        await expect(collect(response)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      }
    },
  )

  it.each([
    { content: {} },
    { reasoning_content: [] },
    { tool_calls: {} },
    { tool_calls: [null] },
    { tool_calls: [{ index: '0' }] },
    { tool_calls: [{ index: 0, function: { arguments: {} } }] },
  ])('classifies malformed consumed stream fields %j', async delta => {
    await expect(collect(translateSsePayloads(payloads([
      { choices: [streamChoice(delta, 'stop')] }, '[DONE]',
    ])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it.each([
    null,
    { content: [] },
    { tool_calls: [null] },
    { tool_calls: [{ id: 'call', function: null }] },
    { tool_calls: [{ id: 'call', function: { name: 'tool', arguments: {} } }] },
  ])('classifies malformed completion message %j', async message => {
    await expect(collect(translateCompletion({
      choices: [{ index: 0, message, finish_reason: 'stop' }],
    }))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('does not use transport DONE or completion JSON as evidence of model completion', async () => {
    const chunks: StreamChunk[] = []
    let failure: unknown
    try {
      for await (const chunk of translateSsePayloads(payloads([
        { choices: [streamChoice({ content: 'partial answer' })] }, '[DONE]',
      ]))) chunks.push(chunk)
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(LlmError)
    expect(failure).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'partial answer' })
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
    await expect(collect(translateCompletion({
      choices: [{ message: { content: 'unconfirmed answer' } }],
    }))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('preserves in-band error detail before any content, including HTTP-200 JSON errors', async () => {
    const errorBody = { error: { code: 'ark_test_rejection', type: 'test', message: 'request rejected' } }
    for (const response of [translateCompletion(errorBody), translateSsePayloads(payloads([errorBody, '[DONE]']))]) {
      await expect(collect(response)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        message: expect.stringContaining('ark_test_rejection test request rejected'),
      })
    }
  })

  it('projects index 0 for streaming reasoning, text, tool identity, arguments and finish', async () => {
    const chunks = await collect(translateSsePayloads(payloads([
      { choices: [
        streamChoice({ reasoning_content: 'other reasoning', content: 'other answer', tool_calls: [
          { index: 0, id: 'other', function: { name: 'other_tool', arguments: '{"other":' } },
        ] }, null, 1),
        streamChoice({ reasoning_content: 'chosen reasoning', content: 'chosen answer', tool_calls: [
          { index: 0, id: 'chosen', function: { name: 'chosen_tool', arguments: '{"chosen":' } },
        ] }),
      ] },
      { choices: [streamChoice({ tool_calls: [
        { index: 0, function: { arguments: 'true}' } },
      ] }, 'length', 1)] },
      { choices: [streamChoice({ tool_calls: [
        { index: 0, function: { arguments: 'true}' } },
      ] }, 'tool_calls')] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
      '[DONE]',
    ])))
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual([
      { type: 'reasoning', text: 'chosen reasoning' },
      { type: 'text', text: 'chosen answer' },
      { type: 'tool-call', id: 'chosen', name: 'chosen_tool', arguments: '{"chosen":true}' },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
    expect(JSON.stringify(chunks)).not.toContain('other')
  })

  it('uses the same index-0 projection in non-streaming responses regardless of array order', async () => {
    const chunks = await collect(translateCompletion({
      choices: [completionChoice('other', 1), completionChoice('chosen', 0)],
      vendor_new_field: { retained_by_provider: true },
    }))
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['chosen'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not borrow completion evidence from an unselected candidate', async () => {
    await expect(collect(translateSsePayloads(payloads([
      { choices: [streamChoice({ content: 'partial' })] },
      { choices: [streamChoice({ content: 'other' }, 'stop', 1)] },
      '[DONE]',
    ])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it.each([
    { choices: [{ delta: {} }, { delta: {} }] },
    { choices: [streamChoice({}, 'stop', 0), streamChoice({}, 'stop', 0)] },
    { choices: [streamChoice({}, 'stop', -1)] },
  ])('rejects ambiguous or invalid candidate indices %j', async ({ choices }) => {
    await expect(collect(translateSsePayloads(payloads([{ choices }, '[DONE]']))))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('keeps explicit empty-response failure distinct from malformed response', async () => {
    for (const response of [
      translateSsePayloads(payloads([{ choices: [streamChoice({}, 'stop')] }, '[DONE]'])),
      translateCompletion({ choices: [completionChoice('')] }),
    ]) {
      expect((await collect(response)).at(-1)).toMatchObject({
        type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } },
      })
    }
  })

  it.each([
    { name: 'empty identity', calls: [{ index: 0, id: '', function: { name: '', arguments: '{}' } }] },
    { name: 'whitespace identity', calls: [{ index: 0, id: ' ', function: { name: 'tool', arguments: '{}' } }] },
    { name: 'duplicate id', calls: [
      { index: 0, id: 'same', function: { name: 'first', arguments: '{}' } },
      { index: 1, id: 'same', function: { name: 'second', arguments: '{}' } },
    ] },
    { name: 'tool finish without a call', calls: [] },
  ])('rejects a successful $name before closing tools in either response mode', async ({ calls }) => {
    for (const response of [
      translateSsePayloads(payloads([{ choices: [streamChoice({ tool_calls: calls }, 'tool_calls')] }, '[DONE]'])),
      translateCompletion({ choices: [{ index: 0, message: { tool_calls: calls }, finish_reason: 'tool_calls' }] }),
    ]) {
      const chunks: StreamChunk[] = []
      await expect((async () => {
        for await (const chunk of response) chunks.push(chunk)
      })()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      expect(chunks.some(chunk => chunk.type === 'block-end' || chunk.type === 'finish')).toBe(false)
    }
  })

  it('rejects a streamed tool whose identity never arrives, including a stop terminal', async () => {
    await expect(collect(translateSsePayloads(payloads([
      { choices: [streamChoice({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'stop')] },
      '[DONE]',
    ])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it.each(['id', 'name'] as const)('rejects a conflicting tool %s within the same index', async field => {
    await expect(collect(translateSsePayloads(payloads([
      { choices: [streamChoice({ tool_calls: [{
        index: 0, id: 'call-one', function: { name: 'first', arguments: '{"x":' },
      }] })] },
      { choices: [streamChoice({ tool_calls: [{
        index: 0, id: field === 'id' ? 'call-two' : 'call-one',
        function: { name: field === 'name' ? 'second' : 'first', arguments: '1}' },
      }] }, 'tool_calls')] },
      '[DONE]',
    ])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('preserves delayed identities, repeated identities and interleaved argument fragments', async () => {
    const chunks = await collect(translateSsePayloads(payloads([
      { choices: [streamChoice({ tool_calls: [
        { index: 0, function: { arguments: '{"a":' } },
        { index: 1, id: 'call-two', function: { name: 'second', arguments: '{"b":' } },
      ] })] },
      { choices: [streamChoice({ tool_calls: [
        { index: 1, id: 'call-two', function: { name: 'second', arguments: '2}' } },
        { index: 0, id: '', function: { name: null, arguments: '1' } },
      ] })] },
      { choices: [streamChoice({ tool_calls: [
        { index: 0, id: 'call-one', function: { name: 'first', arguments: '}' } },
      ] }, 'tool_calls')] },
      '[DONE]',
    ])))
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual([
      { type: 'tool-call', id: 'call-one', name: 'first', arguments: '{"a":1}' },
      { type: 'tool-call', id: 'call-two', name: 'second', arguments: '{"b":2}' },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('leaves max-token truncation of an unfinished call to the Harness assembler', async () => {
    const assembler = new BlockAssembler()
    const chunks = await collect(translateSsePayloads(payloads([
      { choices: [streamChoice({ content: 'partial answer', tool_calls: [{ index: 0, function: { arguments: '{' } }] }, 'length')] },
      '[DONE]',
    ])))
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'partial answer' }])
  })
})

let fake: FakeArk | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  await fake?.close()
  ctx = undefined
  fake = undefined
})

describe('actual Harness failure boundary over local HTTP', () => {
  it('keeps partial output and lets Harness turn a subsequent provider error into one terminal failure', async () => {
    fake = await startFakeArk()
    fake.enqueueResponse({
      headers: { 'content-type': 'text/event-stream' },
      body: [
        { choices: [streamChoice({ content: 'partial answer' })] },
        { error: { code: 'ark_after_partial', message: 'generation failed' } },
        '[DONE]',
      ].map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''),
    })
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['ark-response-test'], new VolcengineChatAdapter({
      resolveConnection: () => ({
        route: { kind: 'coding-plan', baseUrl: `${fake!.baseUrl}/api/coding/v3`, apiKeyEnv: 'TEST' },
        apiKey: 'synthetic-test-key',
        customBody: { n: 2, future_unknown: { untouched: true } },
      }),
    }))
    const chunks = await collect(ctx.llm.stream({
      provider: 'ark-response-test', model: 'manual-model',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    }))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'partial answer' })
    expect(chunks.filter(chunk => chunk.type === 'finish')).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'PROVIDER_ERROR', status: 200, message: expect.stringContaining('ark_after_partial generation failed') },
      },
    }])
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.json).toMatchObject({ n: 2, future_unknown: { untouched: true } })
  })

  it.each([
    { code: 'context_length_exceeded', message: 'maximum context length exceeded', status: 400, expected: 'CONTEXT_WINDOW_EXCEEDED' },
    { code: 'insufficient_quota', message: 'account quota exhausted', status: 429, expected: 'QUOTA' },
    { code: 'RateLimitExceeded.EndpointRPMExceeded', message: 'endpoint request limit reached', status: 429, expected: 'RATE_LIMIT' },
  ])('keeps $code diagnostic facts consistent for HTTP errors, JSON and SSE', async ({ code, message, status, expected }) => {
    fake = await startFakeArk()
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({
        route: { kind: 'coding-plan', baseUrl: fake!.baseUrl, apiKeyEnv: 'TEST' },
        apiKey: 'synthetic-test-key',
      }),
    })
    for (const mode of ['http', 'json', 'sse']) {
      const errorBody = JSON.stringify({ error: { code, message } })
      fake.enqueueResponse({
        status: mode === 'http' ? status : 200,
        headers: {
          'content-type': mode === 'sse' ? 'text/event-stream' : 'application/json',
          'x-request-id': 'known-request', 'retry-after': '2',
        },
        body: mode === 'sse' ? `data: ${errorBody}\n\n` : errorBody,
      })
      await expect(collect(adapter.stream({ provider: 'ark-test', model: 'manual', messages: [] })))
        .rejects.toMatchObject({
          code: expected,
          failure: {
            code: expected, status: mode === 'http' ? status : 200,
            requestId: 'known-request', providerRetryAfterMs: 2000,
            message: expect.stringContaining(message),
          },
        })
    }
    expect(fake.requests).toHaveLength(3)
  })

  it('retains the log-id fallback for an unknown in-band failure without inventing an error category', async () => {
    fake = await startFakeArk()
    fake.enqueueResponse({
      headers: { 'content-type': 'application/json', 'x-request-id': '', 'x-tt-logid': 'fallback-log-id' },
      body: JSON.stringify({ error: { code: 'future_vendor_error', message: 'opaque provider diagnostic' } }),
    })
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({ route: { kind: 'standard', baseUrl: fake!.baseUrl, apiKeyEnv: 'TEST' }, apiKey: 'synthetic' }),
    })
    await expect(collect(adapter.stream({ provider: 'ark-test', model: 'manual', messages: [] })))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', failure: { status: 200, requestId: 'fallback-log-id' } })
  })
})
