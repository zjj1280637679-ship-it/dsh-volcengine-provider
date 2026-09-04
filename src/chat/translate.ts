import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type StreamChunk,
  type TokenUsage,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'

import { DONE } from './sse.js'
import type {
  WireChunk,
  WireCompletion,
  WireCompletionMessage,
  WireUsage,
} from './types.js'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

function toolCallId(value: string): ToolCallId {
  return value as ToolCallId
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

function safeCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function mapUsage(usage: WireUsage): TokenUsage | undefined {
  const prompt = safeCounter(usage.prompt_tokens)
  const completion = safeCounter(usage.completion_tokens)
  if (prompt === undefined || completion === undefined) return undefined
  const cacheRead = safeCounter(
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
  )
  const reasoning = safeCounter(usage.completion_tokens_details?.reasoning_tokens)
  const inputTokens = Math.max(0, prompt - (cacheRead ?? 0))
  const combined = prompt + completion
  const wireTotal = safeCounter(usage.total_tokens)

  return {
    inputTokens,
    outputTokens: completion,
    ...(wireTotal === undefined || wireTotal === combined ? { totalTokens: combined } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

function acceptIdentity(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: toolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/** Stateful OpenAI-compatible streaming translator. */
export async function* translateSsePayloads(
  payloads: AsyncIterable<string>,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: {
              message: 'model returned a completed response with no content',
              code: 'EMPTY_RESPONSE',
            },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(
        `Malformed SSE payload: ${payload.slice(0, 120)}`,
        'MALFORMED_RESPONSE',
      )
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.callId = acceptIdentity(block.callId, call.id)
        block.name = acceptIdentity(block.name, call.function?.name)
        const fragment = typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: toolCallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    if (chunk.usage !== undefined && chunk.usage !== null) {
      pendingUsage = mapUsage(chunk.usage) ?? pendingUsage
    }
  }

  throw new LlmError('SSE payload source ended without [DONE].', 'STREAM_CLOSED')
}

function completionBlocks(message: WireCompletionMessage): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
    blocks.push({ type: 'reasoning', text: message.reasoning_content })
  }
  if (typeof message.content === 'string' && message.content.length > 0) {
    blocks.push({ type: 'text', text: message.content })
  }
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool-call',
      id: toolCallId(call.id),
      name: call.function.name,
      arguments: call.function.arguments,
    })
  }
  return blocks
}

/** Translate a non-streaming Chat completion into the same Harness chunk protocol. */
export async function* translateCompletion(
  completion: WireCompletion,
): AsyncGenerator<StreamChunk> {
  const choice = completion.choices?.[0]
  const blocks = choice?.message === undefined ? [] : completionBlocks(choice.message)
  let index = 0
  for (const block of blocks) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
    else if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text }
    else if (block.type === 'tool-call') {
      yield {
        type: 'tool-call-delta',
        index,
        id: block.id,
        name: block.name,
        argumentsDelta: block.arguments,
      }
    }
    yield { type: 'block-end', index, block }
    index += 1
  }

  if (completion.usage !== undefined && completion.usage !== null) {
    const usage = mapUsage(completion.usage)
    if (usage !== undefined) yield { type: 'usage', usage }
  }

  const reason = typeof choice?.finish_reason === 'string'
    ? mapFinishReason(choice.finish_reason)
    : { kind: 'stop' as const }
  yield {
    type: 'finish',
    reason: reason.kind === 'stop' && blocks.length === 0
      ? {
        kind: 'error',
        failure: {
          message: 'model returned a completed response with no content',
          code: 'EMPTY_RESPONSE',
        },
      }
      : reason,
  }
}
