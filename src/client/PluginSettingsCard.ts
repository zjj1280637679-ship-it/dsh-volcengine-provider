import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { RouteKind } from '../routes.js'
import { VolcengineCard } from './Card.js'
import type { ProviderCardDescriptor } from './Card.js'
import type { CardOperations, SettingsDescribeValue } from './operations.js'

export interface VolcenginePluginSettingsCardProps {
  operations: CardOperations
}

const DISPLAY_NAMES: Record<RouteKind, string> = {
  standard: '火山方舟 · 普通 API',
  'agent-plan': '火山方舟 · Agent Plan',
  'coding-plan': '火山方舟 · Coding Plan',
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function displayName(key: string, route: Record<string, unknown>): string {
  if (typeof route.name === 'string' && route.name.trim().length > 0) return route.name
  const kind = route.kind
  if (kind === 'standard' || kind === 'agent-plan' || kind === 'coding-plan') return DISPLAY_NAMES[kind]
  return `火山方舟 · ${key}`
}

/** Build only the configured route cards; partial profiles must not show phantom failures. */
export function pluginSettingsProviders(description: SettingsDescribeValue): ProviderCardDescriptor[] {
  const namespace = description.namespaces.find(item => item.ns === 'llm-volcengine')
  if (!object(namespace?.value)) return []
  const routes = namespace.value.routes
  if (!object(routes)) return []
  return Object.entries(routes).flatMap(([key, value]) => object(value) ? [{
    provider: `volcengine-${key}`,
    displayName: displayName(key, value),
    settingsNs: 'llm-volcengine',
    settingsPath: ['routes', key],
    active: value.enabled !== false,
  }] : [])
}

/** rc.2 has no Models extension seat, so expose its configured routes under Plugins. */
export function VolcenginePluginSettingsCard(
  { operations }: VolcenginePluginSettingsCardProps,
): ReactNode {
  const [providers, setProviders] = useState<ProviderCardDescriptor[]>()
  const [failure, setFailure] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setFailure(undefined)
    setProviders(undefined)
    void operations.read().then(description => {
      if (active) setProviders(pluginSettingsProviders(description))
    }).catch(error => {
      if (active) setFailure(error instanceof Error ? error.message : '方舟配置加载失败，请重试。')
    })
    return () => { active = false }
  }, [operations, reload])

  if (failure !== undefined) return h('div', null,
    h('p', { role: 'alert' }, failure),
    h('button', { type: 'button', onClick: () => setReload(current => current + 1) }, '重新加载方舟配置'))
  if (providers === undefined) return h('p', null, '正在加载方舟配置…')
  if (providers.length === 0) return h('p', null, '当前没有可配置的方舟通道。')
  return h('div', { 'aria-label': '火山方舟供应商配置', style: { display: 'grid', gap: '20px', minWidth: 0 } }, ...providers.map(provider => h(VolcengineCard, {
    key: provider.provider,
    provider,
    operations,
    showHeader: true,
  })))
}
