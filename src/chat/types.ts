/** OpenAI-compatible Chat wire vocabulary used by Volcengine Ark routes. */

import type { RequestBody } from '../request-body.js'

export interface WireTextPart {
  type: 'text'
  text: string
}

export interface WireImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export interface WireVideoPart {
  type: 'video_url'
  video_url: { url: string }
}

export interface WireAudioPart {
  type: 'audio'
  audio_url: string
}

/**
 * Known Ark multimodal parts. The final request body is still an open JSON
 * object, so Raw/custom-body mode remains the escape hatch for future wire
 * shapes that this version does not know yet.
 */
export type WireUserPart = WireTextPart | WireImagePart | WireVideoPart | WireAudioPart

export interface WireSystemMessage {
  role: 'system'
  content: string
}

export interface WireUserMessage {
  role: 'user'
  content: string | WireUserPart[]
}

export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export interface WireAssistantToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireAssistantMessage {
  role: 'assistant'
  content: string
  reasoning_content?: string
  tool_calls?: WireAssistantToolCall[]
}

export type WireMessage = WireSystemMessage | WireUserMessage | WireToolMessage | WireAssistantMessage

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface WireToolCallDelta {
  index: number
  id?: string | null
  type?: 'function'
  function?: {
    name?: string | null
    arguments?: string | null
  }
}

export interface WireDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage | null
}

export interface WireCompletionMessage {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireAssistantToolCall[]
}

export interface WireCompletionChoice {
  message?: WireCompletionMessage
  finish_reason?: string | null
}

export interface WireCompletion {
  choices?: WireCompletionChoice[]
  usage?: WireUsage | null
}

export interface WireErrorBody {
  error?: {
    message?: string
    type?: string
    code?: string | number
  }
  message?: string
  code?: string | number
}

export interface WireModelList {
  data?: unknown[]
  [key: string]: unknown
}

export type OpenJson = RequestBody
