import {
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
} from '@deepseek-ai/dsh-llm'

import { VolcengineChatAdapter, type VolcengineChatConnection } from './chat/adapter.js'
import { type ModelCardConfig, type ResolvedRouteConfig, modelPolicy, parseModelBody } from './config.js'
import { isModalityEnabled, MODALITIES } from './domain.js'
import type { ResolveMediaBytes } from './chat/serialize.js'

export interface ConfiguredAdapterOptions {
  route(provider: string): ResolvedRouteConfig
  resolveKey(reference: string): Promise<string>
  resolveMediaBytes: ResolveMediaBytes
}

function modelInfo(provider: string, id: string, card?: ModelCardConfig): LlmResolvedModelInfo {
  return {
    provider, id, name: card?.name?.trim() ? card.name : id,
    ...(card === undefined ? {} : {
      inputModalities: MODALITIES.filter(modality => isModalityEnabled(modelPolicy(card), modality)),
    }),
    ...(card?.contextWindow === undefined ? {} : { context: { contextWindow: card.contextWindow } }),
    ...(card?.maxTokens === undefined ? {} : { defaultMaxTokens: card.maxTokens }),
  }
}

/** Host-facing adapter: user configuration owns the catalog and request generations. */
export class ConfiguredVolcengineAdapter extends VolcengineChatAdapter {
  constructor(private readonly source: ConfiguredAdapterOptions) {
    super({
      resolveConnection: async (provider, model) => {
        const route = source.route(provider)
        return connection(route, route.models.find(card => card.id === model), await source.resolveKey(route.apiKeyEnv))
      },
      resolveMediaBytes: source.resolveMediaBytes,
    })
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.source.route(provider).name }
  }

  /** Opening a model selector must not probe endpoints or require credentials. */
  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    return this.source.route(provider).models.map(card => modelInfo(provider, card.id, card))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const route = this.source.route(provider)
    return modelInfo(provider, model, route.models.find(card => card.id === model))
  }

  /** Freeze endpoint, key, model policy, and body together before dispatch. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const route = this.source.route(provider)
    if (!route.enabled) throw new LlmError('This Volcengine route is disabled.', 'PROVIDER_DISABLED')
    const card = route.models.find(item => item.id === model)
    const resolved = modelInfo(provider, model, card)
    const snapshot = connection(route, card, await this.source.resolveKey(route.apiKeyEnv))
    signal?.throwIfAborted()
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => snapshot,
      resolveMediaBytes: this.source.resolveMediaBytes,
      feedback: this.feedback,
    })
    return {
      model: resolved,
      stream: options => adapter.stream({ ...options, maxTokens: options.maxTokens ?? card?.maxTokens }),
    }
  }

  override async *stream(options: GenerateOptions) {
    const call = await this.prepareCall(options.provider, options.model, options.signal)
    yield* call.stream(options)
  }
}

function connection(route: ResolvedRouteConfig, card: ModelCardConfig | undefined, apiKey: string): VolcengineChatConnection {
  return {
    route: { kind: route.kind, baseUrl: route.baseURL, apiKeyEnv: route.apiKeyEnv },
    apiKey,
    modelConfig: modelPolicy(card),
    customBody: parseModelBody(card?.customBody),
    customBodyMode: card?.customBodyMode,
  }
}
