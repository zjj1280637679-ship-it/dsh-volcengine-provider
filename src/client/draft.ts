import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

import type { ModelCardConfig, RouteConfig } from '../config.js'

export type DraftModelCard = ModelCardConfig
export type DraftRouteConfig = RouteConfig

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Read settings objects without treating arrays, null, or scalars as records. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** The input is namespace.value or namespace.user; the path is namespace-relative. */
export function routeAt(value: unknown, path: readonly string[]): DraftRouteConfig | undefined {
  let current = value
  for (const key of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined
    current = current[key]
  }
  return isRecord(current) ? current as unknown as DraftRouteConfig : undefined
}

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value)
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber)
  if (isRecord(value)) return Object.values(value).some(hasNonFiniteNumber)
  return false
}

export function parseCustomBody(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('自定义请求体不是有效的 JSON，请检查引号、逗号和括号。')
  }
  if (!isRecord(value)) throw new Error('自定义请求体必须是 JSON 对象，例如 {"temperature": 0.7}。')
  if (hasNonFiniteNumber(value)) {
    throw new Error('自定义请求体中的数字必须为有限数，请检查是否使用了过大的指数。')
  }
  return value
}

export function validateModels(models: readonly DraftModelCard[]): string | undefined {
  const ids = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) return `第 ${index + 1} 个模型必须填写模型 ID。`
    if (ids.has(id)) return `模型 ID 重复：${id}。`
    ids.add(id)
    for (const [field, label] of [['contextWindow', '上下文容量'], ['maxTokens', '输出上限']] as const) {
      const value = model[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        return `第 ${index + 1} 个模型的${label}必须为正整数。`
      }
    }
    const fallbackMB = model.agentMediaFallbackMB
    if (fallbackMB !== undefined && (!Number.isFinite(fallbackMB) || fallbackMB < 0
      || fallbackMB * 1_000_000 > Number.MAX_SAFE_INTEGER)) {
      return `第 ${index + 1} 个模型的智能体媒体续链预算必须是非负有限十进制 MB；0 表示关闭。`
    }
  }
  return undefined
}

/** Compare JSON-shaped settings without depending on object member order. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined)
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined)
  return leftKeys.length === rightKeys.length && leftKeys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]),
  )
}

const ROUTE_FIELDS = new Set(['kind', 'name', 'enabled', 'baseURL', 'apiKeyEnv', 'models'])
type SettingsJsonValue = Extract<SettingsPathOpView, { op: 'set' }>['value']

/**
 * Only the fields the editor actually touched belong in editedKnownFields.
 * Undefined clears an override. Models must retain the original unknown fields
 * when cloned by the editor: settings operations replace the complete array.
 */
export function routeChanges(
  path: readonly string[],
  beforeEffective: unknown,
  editedKnownFields: Partial<DraftRouteConfig>,
): SettingsPathOpView[] {
  const before = asRecord(beforeEffective)
  const changes: SettingsPathOpView[] = []
  for (const [key, value] of Object.entries(editedKnownFields)) {
    if (!ROUTE_FIELDS.has(key) || jsonEqual(before[key], value)) continue
    const fieldPath = [...path, key]
    if (value === undefined) {
      changes.push({ op: 'unset', path: fieldPath })
    } else {
      // The transport accepts JSON. Copying here also isolates queued operations
      // from later edits and drops undefined optional properties from model rows.
      const jsonValue = JSON.parse(JSON.stringify(value)) as SettingsJsonValue
      changes.push({ op: 'set', path: fieldPath, value: jsonValue })
    }
  }
  return changes
}
