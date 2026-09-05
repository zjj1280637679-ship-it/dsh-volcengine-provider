import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
        failure: { code: 'PROVIDER_ERROR', message: expect.stringContaining('ark_after_partial generation failed') },
      },
    }])
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.json).toMatchObject({ n: 2, future_unknown: { untouched: true } })
  })
})
