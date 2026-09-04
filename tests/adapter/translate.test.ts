import { describe, expect, it } from 'vitest'

import { translateCompletion, translateSsePayloads } from '../../src/chat/translate.js'

async function* payloads(values: string[]) {
  for (const value of values) yield value
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of input) values.push(value)
  return values
}

describe('step 3 stream translation', () => {
  it('translates reasoning, text, tool calls, usage and terminal reason in order', async () => {
    const chunks = await collect(translateSsePayloads(payloads([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'world' } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"x":' },
      }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0,
        function: { arguments: '1}' },
      }] }, finish_reason: 'tool_calls' }], usage: null }),
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          total_tokens: 17,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      }),
      '[DONE]',
    ])))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'think ' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'hello ' })
    expect(chunks).toContainEqual({
      type: 'tool-call-delta',
      index: 2,
      id: 'call-1',
      name: 'lookup',
      argumentsDelta: '{"x":',
    })
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 17,
        cacheReadTokens: 2,
        reasoningTokens: 1,
      },
    })
  })

  it('rejects malformed streaming JSON instead of silently dropping it', async () => {
    await expect(collect(translateSsePayloads(payloads(['not-json', '[DONE]']))))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('translates non-streaming Chat responses into the same Harness vocabulary', async () => {
    const chunks = await collect(translateCompletion({
      choices: [{
        message: {
          reasoning_content: 'r',
          content: 'answer',
          tool_calls: [{
            id: 'call-x',
            type: 'function',
            function: { name: 'tool', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toHaveLength(3)
  })
})
