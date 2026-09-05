import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

import { providerResponseError } from './errors.js'
import { DONE } from './sse.js'
import type {
  WireChoice,
  WireCompletionChoice,
  WireCompletionMessage,
  WireErrorBody,
  WireUsage,
} from './types.js'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

/** Harness renamed this brand from ToolCallId to CallId without changing the block contract. */
type CompatibleToolCallId = Extract<ContentBlock, { type: 'tool-call' }>['id']

function toolCallId(value: string): CompatibleToolCallId {
  return value as CompatibleToolCallId
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

function malformed(detail: string): never {
  throw new LlmError(`Malformed Ark response: ${detail}`, 'MALFORMED_RESPONSE')
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    malformed(`${field} must be a string or null`)
  }
}

function responseObject(value: unknown): Record<string, unknown> {
  const response = object(value, 'response')
  if (response.error !== undefined && response.error !== null) {
    const error = object(response.error, 'error')
    optionalString(error.message, 'error.message')
    optionalString(error.type, 'error.type')
    optionalString(response.message, 'message')
    for (const code of [error.code, response.code]) {
      if (code !== undefined && code !== null && typeof code !== 'string' && typeof code !== 'number') {
        malformed('provider error code must be a string or number')
      }
    }
    throw providerResponseError(response as WireErrorBody)
  }
  if (!Array.isArray(response.choices)) malformed('choices must be an array')
  if (response.usage !== undefined && response.usage !== null) {
    const usage = object(response.usage, 'usage')
    for (const field of ['prompt_tokens_details', 'completion_tokens_details']) {
      if (usage[field] !== undefined && usage[field] !== null) object(usage[field], `usage.${field}`)
    }
  }
  return response
}

/** Harness assembles one answer. Project choice 0 without changing the user's n. */
function firstChoice(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = response.choices as unknown[]
  let first: Record<string, unknown> | undefined
  const indices = new Set<number>()
  for (const value of choices) {
    const choice = object(value, 'choice')
    // Some compatible providers omit the index for their sole candidate.
    const index = choice.index === undefined && choices.length === 1 ? 0 : choice.index
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || indices.has(index)) {
      malformed('choice indices must be distinct non-negative integers')
    }
    indices.add(index)
    if (index === 0) first = choice
  }
  if (first !== undefined) {
    optionalString(first.finish_reason, 'finish_reason')
    if (first.finish_reason === '') malformed('finish_reason must not be empty')
  }
  return first
}

/** Validate only the wire fields consumed by this single-answer translator. */
function contentFields(value: unknown, field: string, streaming: boolean): void {
  const content = object(value, field)
  optionalString(content.content, `${field}.content`)
  optionalString(content.reasoning_content, `${field}.reasoning_content`)
  if (content.tool_calls === undefined || content.tool_calls === null) return
  if (!Array.isArray(content.tool_calls)) malformed(`${field}.tool_calls must be an array`)
  for (const value of content.tool_calls) {
    const call = object(value, `${field}.tool_calls[]`)
    if (streaming) {
      if (typeof call.index !== 'number' || !Number.isSafeInteger(call.index) || call.index < 0) {
        malformed('tool call index must be a non-negative integer')
      }
      optionalString(call.id, 'tool call id')
      if (call.function === undefined || call.function === null) continue
    } else if (typeof call.id !== 'string') malformed('tool call id must be a string')
    const fn = object(call.function, 'tool call function')
    for (const key of ['name', 'arguments']) {
      if (streaming) optionalString(fn[key], `tool call function.${key}`)
      else if (typeof fn[key] !== 'string') malformed(`tool call function.${key} must be a string`)
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
      if (pendingFinish === undefined) {
        malformed('stream ended without finish_reason for choice 0')
      }
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish
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

    let value: unknown
    try {
      value = JSON.parse(payload) as unknown
    } catch {
      throw new LlmError(
        `Malformed SSE payload: ${payload.slice(0, 120)}`,
        'MALFORMED_RESPONSE',
      )
    }

    const chunk = responseObject(value)
    const selected = firstChoice(chunk)
    if (selected !== undefined) {
      if (selected.delta !== undefined && selected.delta !== null) {
        contentFields(selected.delta, 'delta', true)
      }
      const choice = selected as WireChoice
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
      pendingUsage = mapUsage(chunk.usage as WireUsage) ?? pendingUsage
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
  completion: unknown,
): AsyncGenerator<StreamChunk> {
  const response = responseObject(completion)
  const selected = firstChoice(response)
  if (selected === undefined) malformed('response has no choice 0')
  contentFields(selected.message, 'message', false)
  const choice = selected as WireCompletionChoice
  if (typeof choice.finish_reason !== 'string') malformed('response has no finish_reason for choice 0')
  const blocks = completionBlocks(choice.message!)
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

  if (response.usage !== undefined && response.usage !== null) {
    const usage = mapUsage(response.usage as WireUsage)
    if (usage !== undefined) yield { type: 'usage', usage }
  }

  const reason = mapFinishReason(choice.finish_reason)
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
