import {
  LlmError,
  type ContentBlock,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'

import {
  createDefaultModelConfig,
  isModalityEnabled,
  type ModelConfig,
  type Modality,
} from '../domain.js'
import { toVerbatimDataUrl } from '../media.js'
import {
  composeRequestBody,
  type RequestBody,
  type RequestBodyMode,
} from '../request-body.js'
import type {
  WireAssistantMessage,
  WireMessage,
  WireTool,
  WireUserPart,
} from './types.js'

export type MediaInputBlock =
  | Extract<ContentBlock, { type: 'image' }>
  | Extract<ContentBlock, { type: 'volcengine-video' }>
  | Extract<ContentBlock, { type: 'volcengine-audio' }>

export type ResolveMediaBytes = (
  block: MediaInputBlock,
  signal?: AbortSignal,
) => Promise<Uint8Array>

export type EncodeMediaPart = (
  block: MediaInputBlock,
  dataUrl: string,
) => WireUserPart

export interface ChatSerializationOptions {
  modelConfig?: ModelConfig
  customBody?: RequestBody
  customBodyMode?: RequestBodyMode
  resolveMediaBytes?: ResolveMediaBytes
  encodeMediaPart?: EncodeMediaPart
}

function blockType(block: ContentBlock): string {
  return (block as { type: string }).type
}

function modalityOf(block: MediaInputBlock): Modality {
  if (block.type === 'image') return 'image'
  if (block.type === 'volcengine-video') return 'video'
  return 'audio'
}

function mediaTypeOf(block: MediaInputBlock): string {
  if (block.type === 'image') return block.attachment.mediaType
  return block.mediaType
}

/** Default Ark Chat wire shapes. Raw/custom-body mode remains available if a model needs a different experimental shape. */
export function defaultEncodeMediaPart(
  block: MediaInputBlock,
  dataUrl: string,
): WireUserPart {
  if (block.type === 'image') {
    return { type: 'image_url', image_url: { url: dataUrl } }
  }
  if (block.type === 'volcengine-video') {
    return { type: 'video_url', video_url: { url: dataUrl } }
  }
  return { type: 'audio', audio_url: dataUrl }
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function assertAssistantBlock(block: ContentBlock): void {
  if (block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call') return
  throw new LlmError(
    `Volcengine Chat cannot represent ${blockType(block)} in assistant history.`,
    'UNSUPPORTED_CONTENT',
  )
}

function serializeAssistant(message: Message): WireAssistantMessage {
  for (const block of message.content) assertAssistantBlock(block)
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    .map(block => ({
      id: String(block.id),
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    content: text,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

async function encodeMedia(
  block: MediaInputBlock,
  config: ModelConfig,
  options: ChatSerializationOptions,
  signal?: AbortSignal,
): Promise<WireUserPart> {
  const modality = modalityOf(block)
  if (!isModalityEnabled(config, modality)) {
    throw new LlmError(
      `${modality} input is disabled by the local model-card policy.`,
      'MODALITY_DISABLED',
    )
  }
  if (options.resolveMediaBytes === undefined) {
    throw new LlmError(
      `${modality} input needs a media-byte resolver.`,
      'MEDIA_RESOLVER_UNAVAILABLE',
    )
  }
  const bytes = await options.resolveMediaBytes(block, signal)
  signal?.throwIfAborted()
  const dataUrl = toVerbatimDataUrl(mediaTypeOf(block), bytes)
  return (options.encodeMediaPart ?? defaultEncodeMediaPart)(block, dataUrl)
}

async function contentParts(
  blocks: readonly ContentBlock[],
  config: ModelConfig,
  options: ChatSerializationOptions,
  signal?: AbortSignal,
): Promise<WireUserPart[]> {
  const parts: WireUserPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0 && !isModalityEnabled(config, 'text')) {
          throw new LlmError('Text input is disabled by the local model-card policy.', 'MODALITY_DISABLED')
        }
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image':
      case 'volcengine-video':
      case 'volcengine-audio':
        parts.push(await encodeMedia(block, config, options, signal))
        break
      case 'tool-result':
        parts.push(...await contentParts(block.content, config, options, signal))
        break
      default:
        // Newer Harness versions project generic file blocks to text before
        // adapter invocation; older published versions do not define them at all.
        // Any other merge-extensible block must fail loudly rather than vanish.
        throw new LlmError(
          `Volcengine Chat cannot represent ${blockType(block)} in user content.`,
          'UNSUPPORTED_CONTENT',
        )
    }
  }
  return parts
}

function compactUserContent(parts: readonly WireUserPart[]): string | WireUserPart[] {
  if (parts.every((part): part is Extract<WireUserPart, { type: 'text' }> => part.type === 'text')) {
    return parts.map(part => part.text).join('')
  }
  return [...parts]
}

const TOOL_MEDIA_LABEL = 'Attached media from tool result:'

export async function serializeMessages(
  messages: readonly Message[],
  options: ChatSerializationOptions = {},
  signal?: AbortSignal,
): Promise<WireMessage[]> {
  const config = options.modelConfig ?? createDefaultModelConfig()
  const wire: WireMessage[] = []
  let pendingToolMedia: WireUserPart[] = []

  const flushToolMedia = (): void => {
    if (pendingToolMedia.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_MEDIA_LABEL }, ...pendingToolMedia],
    })
    pendingToolMedia = []
  }

  for (const message of messages) {
    signal?.throwIfAborted()
    if (message.role === 'system') {
      flushToolMedia()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolMedia()
      wire.push(serializeAssistant(message))
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    )
    const regularParts = await contentParts(regular, config, options, signal)
    if (regularParts.length > 0 || toolResults.length === 0) {
      flushToolMedia()
      wire.push({ role: 'user', content: compactUserContent(regularParts) })
    }

    for (const result of toolResults) {
      const resultParts = await contentParts(result.content, config, options, signal)
      const text = resultParts
        .filter((part): part is Extract<WireUserPart, { type: 'text' }> => part.type === 'text')
        .map(part => part.text)
        .join('')
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: text || '(no output)',
      })
      pendingToolMedia.push(...resultParts.filter(part => part.type !== 'text'))
    }
  }
  flushToolMedia()
  return wire
}

/**
 * Serialize one provider attempt. Thinking/reasoning knobs are deliberately not
 * inferred from model metadata; model-card custom JSON owns vendor-specific
 * reasoning fields.
 */
export async function serializeChatRequest(
  options: GenerateOptions,
  config: ChatSerializationOptions = {},
): Promise<RequestBody> {
  if (options.reasoningEffort !== undefined) {
    throw new LlmError(
      'Volcengine reasoning effort is configured through the model-card custom request body, not the Harness reasoning selector.',
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }

  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...await serializeMessages(options.messages, config, options.signal))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  const base: RequestBody = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }

  return composeRequestBody(
    base,
    config.customBody ?? {},
    config.customBodyMode ?? 'merge',
  )
}
