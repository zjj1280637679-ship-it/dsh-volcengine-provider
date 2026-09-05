import z from '@deepseek-ai/schemastery'

import { createDefaultModelConfig, MODALITIES, type Modality, type ModalityOverride, type ModelConfig } from './domain.js'
import { DEFAULT_ROUTES, type RouteKind } from './routes.js'
import type { RequestBody, RequestBodyMode } from './request-body.js'

export const SETTINGS_NS = 'llm-volcengine'

/** User-owned model settings. Unknown fields survive settings/UI round trips. */
export interface ModelCardConfig {
  id: string
  name?: string
  modalities?: Partial<Record<Modality, ModalityOverride>>
  /** Text preserves arbitrary JSON keys across the host settings store. */
  customBody?: RequestBody | string
  customBodyMode?: RequestBodyMode
  contextWindow?: number
  maxTokens?: number
  [key: string]: unknown
}

export interface RouteConfig {
  kind: RouteKind
  name?: string
  enabled?: boolean
  baseURL?: string
  apiKeyEnv?: string
  models?: ModelCardConfig[]
  [key: string]: unknown
}

export interface Config {
  routes?: Record<string, RouteConfig>
  [key: string]: unknown
}

export interface ResolvedRouteConfig extends RouteConfig {
  name: string
  enabled: boolean
  baseURL: string
  apiKeyEnv: string
  models: ModelCardConfig[]
}

export interface ResolvedConfig extends Config {
  routes: Record<string, ResolvedRouteConfig>
}

const NAMES: Record<RouteKind, string> = {
  standard: '火山方舟 · 普通 API',
  'agent-plan': '火山方舟 · Agent Plan',
  'coding-plan': '火山方舟 · Coding Plan',
}

export function defaultRoutes(): Record<RouteKind, RouteConfig> {
  return Object.fromEntries(Object.entries(DEFAULT_ROUTES).map(([kind, route]) => [kind, {
    kind, name: NAMES[kind as RouteKind], enabled: true,
    baseURL: route.baseUrl, apiKeyEnv: route.apiKeyEnv, models: [],
  }])) as unknown as Record<RouteKind, RouteConfig>
}

const modalitySchema = z.union(['inherit', 'force_enable', 'force_disable'])
const modelSchema: z<ModelCardConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  modalities: z.object(Object.fromEntries(MODALITIES.map(key => [key, modalitySchema]))),
  customBody: z.union([z.string(), z.dict(z.any())]),
  customBodyMode: z.union(['merge', 'patch', 'raw']),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const routeSchema: z<RouteConfig> = z.object({
  kind: z.union(['standard', 'agent-plan', 'coding-plan']).required(),
  name: z.string(),
  enabled: z.boolean().default(true),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  models: z.array(modelSchema),
})

/** Same schema owns static composition and live settings; no model allowlist. */
export const Config: z<Config> = z.object({
  routes: z.dict(routeSchema).default(defaultRoutes()),
})

export function providerId(routeKey: string): string {
  return `volcengine-${routeKey}`
}

/** Resolve one configuration generation before publishing any route changes. */
export function resolveConfig(raw: Config): ResolvedConfig {
  const admitted = Config(structuredClone(raw))
  const routes: Record<string, ResolvedRouteConfig> = Object.create(null)
  for (const [key, route] of Object.entries(admitted.routes ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Invalid Volcengine route key: ${key}`)
    const defaults = DEFAULT_ROUTES[route.kind]
    const baseURL = route.baseURL ?? defaults.baseUrl
    const url = new URL(baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`Volcengine route ${key} needs an HTTP(S) base URL without credentials, query, or fragment.`)
    }
    const apiKeyEnv = route.apiKeyEnv ?? defaults.apiKeyEnv
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`Invalid credential reference for route ${key}.`)
    const models = route.models ?? []
    const ids = new Set<string>()
    for (const model of models) {
      if (!model.id.trim() || ids.has(model.id)) throw new Error(`Empty or duplicate model ID in route ${key}.`)
      ids.add(model.id)
      parseModelBody(model.customBody)
      for (const field of ['contextWindow', 'maxTokens'] as const) {
        const value = model[field]
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
          throw new Error(`${key}/${model.id}: ${field} must be a positive safe integer.`)
        }
      }
    }
    routes[key] = { ...route, enabled: route.enabled ?? true, name: route.name?.trim() ? route.name : NAMES[route.kind], baseURL, apiKeyEnv, models }
  }
  return { ...admitted, routes }
}

/** Parse custom JSON only at the provider boundary; never normalize the stored text. */
export function parseModelBody(body: ModelCardConfig['customBody']): RequestBody | undefined {
  if (body === undefined) return undefined
  const value: unknown = typeof body === 'string' ? JSON.parse(body) : body
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A model custom request body must be a JSON object.')
  }
  return value as RequestBody
}

/** Capabilities derive exclusively from the user's model card. */
export function modelPolicy(model?: ModelCardConfig): ModelConfig {
  const config = createDefaultModelConfig()
  for (const modality of MODALITIES) {
    const override = model?.modalities?.[modality]
    if (override !== undefined) config.modalities[modality] = { override }
  }
  return config
}
