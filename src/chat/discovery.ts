import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'

import type { RouteProfile } from '../routes.js'
import { sendArkGet } from '../transport.js'
import { parseJsonResponse, providerHttpError } from './errors.js'
import type { WireModelList } from './types.js'

export interface ModelFeedbackSnapshot {
  provider: string
  id: string
  raw: Record<string, unknown>
  fetchedAt: string
}

function key(provider: string, id: string): string {
  return `${provider}\u0000${id}`
}

/** Provider feedback is cached as evidence only; this store has no configuration write API. */
export class ModelFeedbackStore {
  readonly #items = new Map<string, ModelFeedbackSnapshot>()

  put(snapshot: ModelFeedbackSnapshot): void {
    this.#items.set(key(snapshot.provider, snapshot.id), structuredClone(snapshot))
  }

  get(provider: string, id: string): ModelFeedbackSnapshot | undefined {
    const value = this.#items.get(key(provider, id))
    return value === undefined ? undefined : structuredClone(value)
  }

  list(provider: string): ModelFeedbackSnapshot[] {
    return [...this.#items.values()]
      .filter(item => item.provider === provider)
      .map(item => structuredClone(item))
  }
}

export interface DiscoverModelsOptions {
  provider: string
  route: RouteProfile
  apiKey: string
  headers?: HeadersInit
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  feedback: ModelFeedbackStore
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function displayName(record: Record<string, unknown>, id: string): string {
  for (const candidate of [record.name, record.display_name, record.displayName]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return id
}

function description(record: Record<string, unknown>): string | undefined {
  for (const candidate of [record.description, record.desc]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Interrogate the OpenAI-compatible `/models` directory. Only identity/display
 * fields are normalized into DSH's advisory catalog; every other field remains
 * raw feedback and therefore cannot become a request gate by accident.
 */
export async function discoverModels(
  options: DiscoverModelsOptions,
): Promise<LlmModelInfo[]> {
  const response = await sendArkGet({
    route: options.route,
    operation: 'models',
    apiKey: options.apiKey,
    headers: options.headers,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })
  if (!response.ok) throw await providerHttpError(response)
  const payload = await parseJsonResponse<WireModelList>(response)
  const records = Array.isArray(payload.data) ? payload.data : []
  const fetchedAt = new Date().toISOString()
  const models: LlmModelInfo[] = []

  for (const item of records) {
    const record = objectRecord(item)
    if (record === undefined || typeof record.id !== 'string' || record.id.length === 0) continue
    const id = record.id
    options.feedback.put({
      provider: options.provider,
      id,
      raw: record,
      fetchedAt,
    })
    const desc = description(record)
    models.push({
      provider: options.provider,
      id,
      name: displayName(record, id),
      ...(desc === undefined ? {} : { description: desc }),
      // Deliberately no inputModalities/context/reasoning here. Rich provider
      // feedback is evidence, not a DSH capability gate or configuration source.
    })
  }
  return models
}
