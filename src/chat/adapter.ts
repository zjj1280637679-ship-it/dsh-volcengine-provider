import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import type { ModelConfig } from '../domain.js'
import type { RequestBody, RequestBodyMode } from '../request-body.js'
import type { RouteProfile } from '../routes.js'
import { sendArkJson } from '../transport.js'
import {
  discoverModels,
  ModelFeedbackStore,
} from './discovery.js'
import { parseJsonResponse, providerHttpError } from './errors.js'
import {
  serializeChatRequest,
  type EncodeMediaPart,
  type ResolveMediaBytes,
} from './serialize.js'
import { parseSse } from './sse.js'
import { translateCompletion, translateSsePayloads } from './translate.js'
import type { WireCompletion } from './types.js'

export interface VolcengineChatConnection {
  route: RouteProfile
  apiKey: string
  modelConfig?: ModelConfig
  customBody?: RequestBody
  customBodyMode?: RequestBodyMode
  headers?: HeadersInit
}

export type ResolveVolcengineChatConnection = (
  provider: string,
  model?: string,
  signal?: AbortSignal,
) => Promise<VolcengineChatConnection> | VolcengineChatConnection

export interface VolcengineChatAdapterOptions {
  /** Synchronous display labels for provider routes registered to this adapter. */
  providerNames?: Readonly<Record<string, string>>
  resolveConnection: ResolveVolcengineChatConnection
  resolveMediaBytes?: ResolveMediaBytes
  encodeMediaPart?: EncodeMediaPart
  feedback?: ModelFeedbackStore
  fetchImpl?: typeof fetch
}

function mandatoryHeaders(additional?: HeadersInit): Headers {
  const headers = new Headers(additional)
  // Application attribution is a Harness contract and therefore wins over
  // optional model-card/route diagnostic headers.
  const attribution = new Headers(attributionHeaders())
  for (const [name, value] of attribution) headers.set(name, value)
  return headers
}

function responseIsSse(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false
}

/**
 * First production adapter: OpenAI-compatible Chat Completions only. It owns no
 * retry/fallback policy; every `stream()` call creates exactly one Ark HTTP
 * attempt through the Step-2 transport.
 */
export class VolcengineChatAdapter extends LlmAdapter {
  readonly feedback: ModelFeedbackStore

  constructor(private readonly config: VolcengineChatAdapterOptions) {
    super()
    this.feedback = config.feedback ?? new ModelFeedbackStore()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: this.config.providerNames?.[provider] ?? `Volcengine Ark (${provider})`,
    }
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const connection = await this.config.resolveConnection(provider)
    return discoverModels({
      provider,
      route: connection.route,
      apiKey: connection.apiKey,
      headers: mandatoryHeaders(connection.headers),
      fetchImpl: this.config.fetchImpl,
      feedback: this.feedback,
    })
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const cached = this.feedback.get(provider, model)
    const rawName = cached?.raw.name ?? cached?.raw.display_name ?? cached?.raw.displayName
    return {
      provider,
      id: model,
      name: typeof rawName === 'string' && rawName.length > 0 ? rawName : model,
      // Deliberately omit context, defaultMaxTokens, reasoning and
      // inputModalities. Supplier feedback must not become a Harness gate.
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = await this.config.resolveConnection(
      options.provider,
      options.model,
      options.signal,
    )
    options.signal?.throwIfAborted()
    const body = await serializeChatRequest(options, {
      modelConfig: connection.modelConfig,
      customBody: connection.customBody,
      customBodyMode: connection.customBodyMode,
      resolveMediaBytes: this.config.resolveMediaBytes,
      encodeMediaPart: this.config.encodeMediaPart,
    })

    const response = await sendArkJson({
      route: connection.route,
      operation: 'chat/completions',
      apiKey: connection.apiKey,
      headers: mandatoryHeaders(connection.headers),
      body,
      signal: options.signal,
      fetchImpl: this.config.fetchImpl,
    })
    if (!response.ok) throw await providerHttpError(response)

    if (responseIsSse(response)) {
      if (response.body === null) {
        throw new LlmError('Volcengine Ark returned an empty SSE body.', 'EMPTY_RESPONSE_BODY')
      }
      yield* translateSsePayloads(parseSse(response.body))
      return
    }

    // Custom/raw request bodies are allowed to set stream:false or otherwise
    // select a non-SSE Chat response. Preserve that freedom and translate the
    // complete JSON response back into the same Harness chunk protocol.
    const completion = await parseJsonResponse<WireCompletion>(response)
    yield* translateCompletion(completion)
  }
}
