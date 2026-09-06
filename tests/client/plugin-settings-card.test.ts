// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { pluginSettingsProviders, VolcenginePluginSettingsCard } from '../../src/client/PluginSettingsCard.js'
import type { CardOperations, SettingsDescribeValue } from '../../src/client/operations.js'

function description(routes: Record<string, unknown>): SettingsDescribeValue {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [{
      ns: 'llm-volcengine', schema: {}, value: { routes }, applies: 'live', secrets: [], revision: 1,
    }],
  }
}

it('maps the three built-in Ark routes to advanced cards on the rc.2 Plugins page', () => {
  expect(pluginSettingsProviders(description({
    standard: { kind: 'standard' },
    'agent-plan': { kind: 'agent-plan' },
    'coding-plan': { kind: 'coding-plan' },
  })).map(card => ({
    provider: card.provider,
    path: card.settingsPath,
  }))).toEqual([
    { provider: 'volcengine-standard', path: ['routes', 'standard'] },
    { provider: 'volcengine-agent-plan', path: ['routes', 'agent-plan'] },
    { provider: 'volcengine-coding-plan', path: ['routes', 'coding-plan'] },
  ])
})

it('shows only the routes present in a partial rc.2 profile', () => {
  expect(pluginSettingsProviders(description({
    'coding-plan': { kind: 'coding-plan', name: 'Coding only', enabled: true },
  }))).toEqual([expect.objectContaining({
    provider: 'volcengine-coding-plan',
    displayName: 'Coding only',
    settingsPath: ['routes', 'coding-plan'],
  })])
})

it('selects one route at a time while preserving hidden drafts, expanded models and independent saves', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const current = description({
    standard: { kind: 'standard', models: [{ id: 'standard-model' }] },
    'agent-plan': { kind: 'agent-plan', models: [{ id: 'agent-model' }] },
    'coding-plan': { kind: 'coding-plan', models: [{ id: 'coding-model' }] },
  })
  const revisions: number[] = []
  const operations: CardOperations = {
    read: async () => structuredClone(current),
    describeCredential: async () => ({ configured: true, writable: true }),
    saveCredential: vi.fn(async () => {}),
    saveSettings: async (_ns, ops, revision) => {
      const namespace = current.namespaces[0]
      expect(revision).toBe(namespace.revision)
      revisions.push(revision)
      const value = namespace.value as { routes: Record<string, Record<string, unknown>> }
      for (const op of ops) {
        const target = value.routes[op.path[1]]
        if (op.op === 'set') target[op.path[2]] = op.value
        else delete target[op.path[2]]
      }
      namespace.revision++
      return structuredClone(namespace)
    },
  }
  try {
    await act(async () => root.render(createElement(VolcenginePluginSettingsCard, { operations })))
    const cards = [...container.querySelectorAll('section')]
    const panels = [...container.querySelectorAll<HTMLDivElement>('[data-ark-route]')]
    const choices = [...container.querySelectorAll<HTMLButtonElement>('nav button')]
    expect(panels.map(panel => panel.hidden)).toEqual([false, true, true])
    expect(choices.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    expect([...container.querySelectorAll('h3')].map(node => node.textContent)).toEqual([
      '火山方舟 · 普通 API', '火山方舟 · Agent Plan', '火山方舟 · Coding Plan',
    ])
    expect(cards.map(card => card.querySelector<HTMLInputElement>('[aria-label="API 地址"]')!.value)).toEqual([
      'https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/plan/v3',
      'https://ark.cn-beijing.volces.com/api/coding/v3',
    ])
    for (const [index, id] of ['standard-edited', 'agent-edited'].entries()) {
      await act(async () => choices[index]!.click())
      expect(panels.filter(panel => !panel.hidden)).toEqual([panels[index]])
      await act(async () => {
        cards[index].querySelector<HTMLElement>('.ark-model-summary')!.click()
        const model = cards[index].querySelector<HTMLInputElement>('[aria-label="模型 ID"]')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(model, id)
        model.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(choices[index]!.textContent).toContain('有未保存修改')
    }
    for (const [index, card] of cards.slice(0, 2).entries()) {
      await act(async () => choices[index]!.click())
      expect(card.querySelector<HTMLDetailsElement>('.ark-model-row')!.open).toBe(true)
      expect(card.querySelector<HTMLInputElement>('[aria-label="模型 ID"]')!.value)
        .toBe(['standard-edited', 'agent-edited'][index])
      expect(card.textContent).toContain('有未保存修改')
      await act(async () => [...card.querySelectorAll('button')]
        .find(button => button.textContent === '保存方舟配置')!.click())
      expect(card.querySelector('[role="alert"]')).toBeNull()
      expect(card.textContent).toContain('已保存，后续请求使用新配置。')
      expect(card.querySelector<HTMLDetailsElement>('.ark-model-row')!.open).toBe(true)
      expect(choices[index]!.textContent).not.toContain('有未保存修改')
    }
    expect(revisions).toEqual([1, 2])
    expect(current.namespaces[0].value).toMatchObject({ routes: {
      standard: { models: [{ id: 'standard-edited' }] },
      'agent-plan': { models: [{ id: 'agent-edited' }] },
    } })
    expect(operations.saveCredential).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('keeps load diagnostics behind disclosure and provides a retry on the outer Plugins card', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  const root = createRoot(container)
  const operations: CardOperations = {
    read: vi.fn().mockRejectedValueOnce(new Error('{"code":"Unavailable","internal_path":"settings.read"}'))
      .mockResolvedValue(description({ 'coding-plan': { kind: 'coding-plan', models: [] } })),
    describeCredential: async () => undefined,
    saveSettings: vi.fn(), saveCredential: vi.fn(),
  }
  try {
    await act(async () => root.render(createElement(VolcenginePluginSettingsCard, { operations })))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('方舟配置加载失败，请重试。')
    expect(container.textContent).not.toContain('internal_path')
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    await act(async () => details.querySelector('summary')!.click())
    expect(details.open).toBe(true)
    expect(details.textContent).toContain('internal_path')
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('h3')?.textContent).toBe('火山方舟 · Coding Plan')
    expect(container.textContent).toContain('尚未添加模型')
  } finally {
    await act(async () => root.unmount())
  }
})

it('keeps a hidden validation failure from stealing focus and retains its credential draft', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const operations: CardOperations = {
    read: async () => description({
      standard: { kind: 'standard', models: [{ id: 'standard-model' }] },
      'coding-plan': { kind: 'coding-plan', models: [{ id: 'coding-model' }] },
    }),
    describeCredential: async () => undefined,
    saveSettings: vi.fn(), saveCredential: vi.fn(),
  }
  try {
    await act(async () => root.render(createElement(VolcenginePluginSettingsCard, { operations })))
    const cards = [...container.querySelectorAll('section')]
    const choices = [...container.querySelectorAll<HTMLButtonElement>('nav button')]
    const model = cards[0]!.querySelector<HTMLInputElement>('[aria-label="模型 ID"]')!
    const credential = cards[0]!.querySelector<HTMLInputElement>('[aria-label="API Key"]')!
    await act(async () => {
      cards[0]!.querySelector<HTMLElement>('.ark-model-summary')!.click()
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(model, '')
      model.dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(credential, 'temporary-unsaved-test-key')
      credential.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...cards[0]!.querySelectorAll('button')].find(button => button.textContent === '保存方舟配置')!.click()
      choices[1]!.focus()
      choices[1]!.click()
    })
    expect(document.activeElement).toBe(choices[1])
    expect(cards[0]!.querySelector('[role="alert"]')?.textContent).toContain('必须填写模型 ID')
    expect(operations.saveSettings).not.toHaveBeenCalled()
    expect(operations.saveCredential).not.toHaveBeenCalled()
    await act(async () => choices[0]!.click())
    expect(document.activeElement).toBe(model)
    expect(credential.value).toBe('temporary-unsaved-test-key')
    expect(model.closest<HTMLDetailsElement>('.ark-model-row')!.open).toBe(true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
