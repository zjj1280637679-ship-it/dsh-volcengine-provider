import {
  LlmError,
  type ContentBlock,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'

import {
  createDefaultModelConfig,
  DEFAULT_AGENT_MEDIA_FALLBACK_MB,
  isModalityEnabled,
  type ModelConfig,
  type Modality,
} from '../domain.js'
import { audioFormatOf, toVerbatimDataUrl } from '../media.js'
import {
  composeRequestBody,
  type RequestBody,
  type RequestBodyMode,
} from '../request-body.js'
import type { MediaRequestFootprint } from './media-runtime.js'
import type {
  WireAssistantMessage,
  WireMessage,
  WireTool,
  WireUserPart,
} from './types.js'

export type MediaInputBlock =
  | Extract<ContentBlock, { type: 'image' }>
  | Extract<ContentBlock, { type: 'volcengine-image' }>
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

/** Optional bridge from an Ark-visible media part to an agent-usable source file. */
export interface MediaSourceBridge {
  readonly toolName: string
  describe(block: MediaInputBlock): string | undefined
}

export interface ChatSerializationOptions {
  modelConfig?: ModelConfig
  customBody?: RequestBody
  customBodyMode?: RequestBodyMode
  resolveMediaBytes?: ResolveMediaBytes
  encodeMediaPart?: EncodeMediaPart
  mediaSourceBridge?: MediaSourceBridge
}

type BudgetedToolMediaBlock =
  | Extract<ContentBlock, { type: 'image' }>
  | Extract<ContentBlock, { type: 'volcengine-image' }>
  | Extract<ContentBlock, { type: 'volcengine-video' }>

interface AgentMediaBudget {
  readonly limitBytes: number
  usedBytes: number
}

interface ToolMediaContext {
  readonly budget: AgentMediaBudget | undefined
  readonly diagnostics: string[]
}

interface ToolMediaFootprintCandidates {
  readonly limitBytes: number
  mediaCount: number
  declaredBytes: bigint
  base64Bytes: bigint
}

const DECIMAL_MB_BYTES = 1_000_000

function createAgentMediaBudget(config: ModelConfig): AgentMediaBudget | undefined {
  const megabytes = config.agentMediaFallbackMB ?? DEFAULT_AGENT_MEDIA_FALLBACK_MB
  if (!Number.isFinite(megabytes) || megabytes < 0
    || megabytes * DECIMAL_MB_BYTES > Number.MAX_SAFE_INTEGER) {
    throw new LlmError('The agent media fallback budget is invalid.', 'INVALID_AGENT_MEDIA_FALLBACK_BUDGET')
  }
  if (megabytes === 0) return undefined
  return { limitBytes: Math.floor(megabytes * DECIMAL_MB_BYTES), usedBytes: 0 }
}

function isBudgetedToolMedia(block: ContentBlock): block is BudgetedToolMediaBlock {
  return block.type === 'image' || block.type === 'volcengine-image' || block.type === 'volcengine-video'
}

function omittedToolMediaDiagnostic(
  block: BudgetedToolMediaBlock,
  budget: AgentMediaBudget,
): string | undefined {
  const declaredBytes = block.attachment.bytes
  const media = block.type === 'volcengine-video' ? 'video' : 'image'
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
    return `[VOLCENGINE_AGENT_MEDIA_FALLBACK_ERROR code=TOOL_MEDIA_SIZE_INVALID media=${media} action=omitted_from_this_request source_file_deleted=false automatic_retry=false next=choose_strategy]`
  }
  if (declaredBytes <= budget.limitBytes - budget.usedBytes) {
    budget.usedBytes += declaredBytes
    return undefined
  }
  return `[VOLCENGINE_AGENT_MEDIA_FALLBACK_ERROR code=TOOL_MEDIA_BUDGET_EXCEEDED media=${media} declared_bytes=${declaredBytes} used_bytes=${budget.usedBytes} budget_bytes=${budget.limitBytes} action=omitted_from_this_request source_file_deleted=false automatic_retry=false next=choose_strategy]`
}

function failedToolMediaDiagnostic(block: BudgetedToolMediaBlock): string {
  const media = block.type === 'volcengine-video' ? 'video' : 'image'
  // Never include the attachment id, filename or resolver error here: all can
  // contain a local path. The stable code tells the agent what happened while
  // leaving the original failure private to the local media boundary.
  return `[VOLCENGINE_AGENT_MEDIA_FALLBACK_ERROR code=TOOL_MEDIA_PROCESSING_FAILED media=${media} stage=resolve_integrity_or_encode action=omitted_from_this_request source_file_deleted=false automatic_retry=false next=choose_strategy]`
}

function isAbortFailure(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  try {
    return Reflect.get(cause, 'name') === 'AbortError'
  } catch {
    return false
  }
}

function blockType(block: ContentBlock): string {
  return (block as { type: string }).type
}

function modalityOf(block: MediaInputBlock): Modality {
  if (block.type === 'image' || block.type === 'volcengine-image') return 'image'
  if (block.type === 'volcengine-video') return 'video'
  return 'audio'
}

function mediaTypeOf(block: MediaInputBlock): string {
  if (block.type === 'image') return block.attachment.mediaType
  return block.mediaType
}

function assertModalityEnabled(config: ModelConfig, modality: Modality): void {
  if (!isModalityEnabled(config, modality)) {
    throw new LlmError(
      `${modality} input is disabled by the local model-card policy.`,
      'MODALITY_DISABLED',
    )
  }
}

function declaredMediaBytes(block: MediaInputBlock): number {
  const bytes = block.attachment.bytes
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new LlmError('The declared media byte length is invalid.', 'INVALID_MEDIA_REFERENCE')
  }
  return bytes
}

function generatedMessagesAreUsed(options: ChatSerializationOptions): boolean {
  if ((options.customBodyMode ?? 'merge') === 'raw') return false
  return options.customBody === undefined
    || !Object.prototype.propertyIsEnumerable.call(options.customBody, 'messages')
}

interface MutableMediaFootprint {
  mediaCount: number
  declaredBytes: bigint
  base64Bytes: bigint
}

function addMediaFootprint(
  block: MediaInputBlock,
  config: ModelConfig,
  footprint: MutableMediaFootprint,
): void {
  assertModalityEnabled(config, modalityOf(block))
  const bytes = BigInt(declaredMediaBytes(block))
  footprint.mediaCount++
  footprint.declaredBytes += bytes
  footprint.base64Bytes += 4n * ((bytes + 2n) / 3n)
  if (!Number.isSafeInteger(footprint.mediaCount)
    || footprint.declaredBytes > BigInt(Number.MAX_SAFE_INTEGER)
    || footprint.base64Bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LlmError('The declared media request size is invalid.', 'INVALID_MEDIA_SIZE')
  }
}

function inspectContentMedia(
  blocks: readonly ContentBlock[],
  config: ModelConfig,
  footprint: MutableMediaFootprint,
  toolMedia?: ToolMediaFootprintCandidates,
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) assertModalityEnabled(config, 'text')
        break
      case 'image':
      case 'volcengine-image':
      case 'volcengine-video':
      case 'volcengine-audio':
        if (toolMedia !== undefined && isBudgetedToolMedia(block)) {
          const declaredBytes = block.attachment.bytes
          // Invalid declarations and an item larger than the entire budget are
          // always omitted before resolution. Every other item could be the
          // one that succeeds after earlier resolution failures, so account
          // for all such candidates and cap their aggregate to a safe budget
          // upper bound after walking the request.
          if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0
            || declaredBytes > toolMedia.limitBytes) break
          const bytes = BigInt(declaredBytes)
          toolMedia.mediaCount++
          toolMedia.declaredBytes += bytes
          toolMedia.base64Bytes += 4n * ((bytes + 2n) / 3n)
          break
        }
        addMediaFootprint(block, config, footprint)
        break
      case 'tool-result':
        inspectContentMedia(block.content, config, footprint, toolMedia)
        break
      default:
        throw new LlmError(
          `Volcengine Chat cannot represent ${blockType(block)} in user content.`,
          'UNSUPPORTED_CONTENT',
        )
    }
  }
}

function addToolMediaFootprintUpperBound(
  candidates: ToolMediaFootprintCandidates | undefined,
  footprint: MutableMediaFootprint,
): void {
  if (candidates === undefined || candidates.mediaCount === 0) return
  const limit = BigInt(candidates.limitBytes)
  footprint.mediaCount += candidates.mediaCount
  footprint.declaredBytes += candidates.declaredBytes < limit ? candidates.declaredBytes : limit
  // For every non-empty byte array, canonical base64 is at most four times
  // its raw length. Also retain the tighter sum of all candidate encodings.
  const encodedLimit = 4n * limit
  footprint.base64Bytes += candidates.base64Bytes < encodedLimit
    ? candidates.base64Bytes
    : encodedLimit
  if (!Number.isSafeInteger(footprint.mediaCount)
    || footprint.declaredBytes > BigInt(Number.MAX_SAFE_INTEGER)
    || footprint.base64Bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LlmError('The declared media request size is invalid.', 'INVALID_MEDIA_SIZE')
  }
}

/** Inspect attachment declarations only; no bytes are read or transformed. */
export function inspectChatMediaFootprint(
  options: GenerateOptions,
  serialization: ChatSerializationOptions = {},
): MediaRequestFootprint {
  if (!generatedMessagesAreUsed(serialization)) {
    return { mediaCount: 0, declaredBytes: 0, base64Bytes: 0 }
  }
  const config = serialization.modelConfig ?? createDefaultModelConfig()
  const budget = createAgentMediaBudget(config)
  const toolCandidates: ToolMediaFootprintCandidates | undefined = budget === undefined
    ? undefined
    : { limitBytes: budget.limitBytes, mediaCount: 0, declaredBytes: 0n, base64Bytes: 0n }
  const footprint: MutableMediaFootprint = { mediaCount: 0, declaredBytes: 0n, base64Bytes: 0n }
  for (const message of options.messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant') {
      for (const block of message.content) assertAssistantBlock(block)
      continue
    }
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    )
    inspectContentMedia(regular, config, footprint)
    for (const result of toolResults) {
      inspectContentMedia(result.content, config, footprint, toolCandidates)
    }
  }
  addToolMediaFootprintUpperBound(toolCandidates, footprint)
  return {
    mediaCount: footprint.mediaCount,
    declaredBytes: Number(footprint.declaredBytes),
    base64Bytes: Number(footprint.base64Bytes),
  }
}

/** Default Ark Chat wire shapes. Raw/custom-body mode remains available if a model needs a different experimental shape. */
export function defaultEncodeMediaPart(
  block: MediaInputBlock,
  dataUrl: string,
): WireUserPart {
  if (block.type === 'image' || block.type === 'volcengine-image') {
    return { type: 'image_url', image_url: { url: dataUrl } }
  }
  if (block.type === 'volcengine-video') {
    return { type: 'video_url', video_url: { url: dataUrl } }
  }
  // Chat uses bare base64 plus a format declaration. Responses uses a data
  // URL in a different field; never mix those two wire protocols.
  return {
    type: 'input_audio',
    input_audio: { data: dataUrl.slice(dataUrl.indexOf(',') + 1), format: audioFormatOf(block) },
  }
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

async function resolveAndEncodeMedia(
  block: MediaInputBlock,
  options: ChatSerializationOptions,
  signal?: AbortSignal,
): Promise<WireUserPart> {
  const modality = modalityOf(block)
  if (options.resolveMediaBytes === undefined) {
    throw new LlmError(
      `${modality} input needs a media-byte resolver.`,
      'MEDIA_RESOLVER_UNAVAILABLE',
    )
  }
  const bytes = await options.resolveMediaBytes(block, signal)
  signal?.throwIfAborted()
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== block.attachment.bytes) {
    throw new LlmError(
      'The resolved media bytes do not match the declared attachment length.',
      'MEDIA_INTEGRITY_FAILED',
    )
  }
  const dataUrl = toVerbatimDataUrl(mediaTypeOf(block), bytes)
  return (options.encodeMediaPart ?? defaultEncodeMediaPart)(block, dataUrl)
}

async function encodeMedia(
  block: MediaInputBlock,
  config: ModelConfig,
  options: ChatSerializationOptions,
  signal?: AbortSignal,
): Promise<WireUserPart> {
  assertModalityEnabled(config, modalityOf(block))
  declaredMediaBytes(block)
  return resolveAndEncodeMedia(block, options, signal)
}

async function contentParts(
  blocks: readonly ContentBlock[],
  config: ModelConfig,
  options: ChatSerializationOptions,
  signal?: AbortSignal,
  toolMedia?: ToolMediaContext,
  includeSourceHandles = false,
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
      case 'volcengine-image':
      case 'volcengine-video':
      case 'volcengine-audio':
        if (toolMedia !== undefined && isBudgetedToolMedia(block) && toolMedia.budget !== undefined) {
          const usedBytesBefore = toolMedia.budget.usedBytes
          const diagnostic = omittedToolMediaDiagnostic(block, toolMedia.budget)
          if (diagnostic !== undefined) {
            toolMedia.diagnostics.push(diagnostic)
            break
          }
          // Policy/declaration errors retain their normal strict behavior. Only
          // failures after this tool-owned media has been admitted are local to
          // that media part; text and other admitted parts remain usable.
          assertModalityEnabled(config, modalityOf(block))
          declaredMediaBytes(block)
          try {
            parts.push(await resolveAndEncodeMedia(block, options, signal))
          } catch (cause) {
            signal?.throwIfAborted()
            if (isAbortFailure(cause)) throw cause
            // A media part that never reaches the wire must not consume the
            // request budget or crowd out a later usable tool result.
            toolMedia.budget.usedBytes = usedBytesBefore
            toolMedia.diagnostics.push(failedToolMediaDiagnostic(block))
          }
          break
        }
        parts.push(await encodeMedia(block, config, options, signal))
        if (includeSourceHandles) {
          const handle = options.mediaSourceBridge?.describe(block)
          if (handle !== undefined && handle !== '') parts.push({ type: 'text', text: handle })
        }
        break
      case 'tool-result':
        parts.push(...await contentParts(block.content, config, options, signal, toolMedia, false))
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
  const agentMediaBudget = createAgentMediaBudget(config)
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
    const regularParts = await contentParts(
      regular,
      config,
      options,
      signal,
      undefined,
      message.source.kind === 'user',
    )
    if (regularParts.length > 0 || toolResults.length === 0) {
      flushToolMedia()
      wire.push({ role: 'user', content: compactUserContent(regularParts) })
    }

    for (const result of toolResults) {
      const diagnostics: string[] = []
      const resultParts = await contentParts(result.content, config, options, signal, {
        budget: agentMediaBudget,
        diagnostics,
      })
      const text = resultParts
        .filter((part): part is Extract<WireUserPart, { type: 'text' }> => part.type === 'text')
        .map(part => part.text)
        .join('')
      const diagnosticText = diagnostics.join('\n')
      const toolText = text.length === 0 ? diagnosticText : diagnosticText.length === 0 ? text : `${text}\n${diagnosticText}`
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: toolText || '(no output)',
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

  const customBody = config.customBody ?? {}
  const customBodyMode = config.customBodyMode ?? 'merge'
  if (customBodyMode === 'raw') return composeRequestBody({}, customBody, customBodyMode)

  const messages: WireMessage[] = []
  if (generatedMessagesAreUsed(config)) {
    if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
    messages.push(...await serializeMessages(options.messages, config, options.signal))
  }

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
    customBody,
    customBodyMode,
  )
}
