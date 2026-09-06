import { createElement as h, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { RouteKind } from '../routes.js'
import { VolcengineCard } from './Card.js'
import type { ProviderCardDescriptor, ProviderCardState } from './Card.js'
import type { CardOperations, SettingsDescribeValue } from './operations.js'
import { describeUiError, ErrorNotice } from './ui-feedback.js'
import type { UiError } from './ui-feedback.js'

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
  const [failure, setFailure] = useState<UiError>()
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<string>()
  const [states, setStates] = useState<Record<string, ProviderCardState>>({})
  const updateState = useCallback((provider: string, state: ProviderCardState) => {
    setStates(current => ({ ...current, [provider]: state }))
  }, [])
  useEffect(() => {
    let active = true
    setFailure(undefined)
    setProviders(undefined)
    setStates({})
    void operations.read().then(description => {
      if (active) setProviders(pluginSettingsProviders(description))
    }).catch(error => {
      if (active) setFailure(describeUiError(error, '方舟配置加载失败，请重试。'))
    })
    return () => { active = false }
  }, [operations, reload])

  if (failure !== undefined) return h('div', null,
    h(ErrorNotice, { error: failure }),
    h('button', { type: 'button', onClick: () => setReload(current => current + 1) }, '重新加载方舟配置'))
  if (providers === undefined) return h('p', null, '正在加载方舟配置…')
  if (providers.length === 0) return h('p', null, '当前没有可配置的方舟通道。')
  const current = providers.some(provider => provider.provider === selected) ? selected : providers[0]!.provider
  return h('div', { 'aria-label': '火山方舟供应商配置', style: { display: 'grid', gap: '16px', minWidth: 0 } },
    h('nav', { 'aria-label': '方舟通道', style: { display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '8px' } },
    ...providers.map(provider => {
      const state = states[provider.provider]
      const active = provider.provider === current
      return h('button', { key: provider.provider, type: 'button', 'aria-pressed': active,
        'aria-label': `选择通道 ${state?.name ?? provider.displayName}`,
        onClick: () => setSelected(provider.provider), style: { display: 'grid', gap: '6px',
          minWidth: 0, padding: '12px', textAlign: 'start', cursor: 'pointer', font: 'inherit', borderRadius: '10px',
          border: `1px solid ${active ? 'var(--dsw-alias-brand-primary, #6366f1)' : 'var(--dsw-alias-border-l2, #cbd5e1)'}`,
          background: active ? 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, CanvasText 6%, Canvas))' : 'var(--dsw-alias-bg-layer-1, Canvas)',
          color: 'var(--dsw-alias-label-primary, CanvasText)' } },
        h('span', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, state?.name ?? provider.displayName),
        h('span', { style: { fontSize: '12px', lineHeight: 1.5 } }, state === undefined ? '正在载入…'
          : `${state.modelCount} 个模型 · ${state.busy ? '处理中…' : state.dirty ? '有未保存修改' : state.status}`))
    })),
    // Keep every visited route mounted: switching sources must not discard JSON,
    // credential drafts, expansion state, or an already accepted save transaction.
    ...providers.map(provider => h('div', { key: provider.provider, hidden: provider.provider !== current,
      'data-ark-route': provider.provider }, h(VolcengineCard, {
      provider, operations, showHeader: true, visible: provider.provider === current, onStateChange: updateState,
    }))))
}
