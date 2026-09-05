// @vitest-environment jsdom
import { act, createElement } from 'react'
import type { ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { VolcengineCard } from '../../src/client/Card.js'
import type { CardOperations } from '../../src/client/operations.js'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

function input(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const element = container.querySelector(`[aria-label="${label}"]`)
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing control: ${label}`)
  }
  return element
}

async function change(label: string, value: string): Promise<void> {
  await act(async () => {
    const element = input(label)
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  if (button === undefined) throw new Error(`Missing button: ${text}`)
  await act(async () => { button.click() })
}

function setup(emptyModels = false) {
  let view: SettingsNamespaceView = {
    ns: 'llm-volcengine', schema: {}, revision: 7, applies: 'live', secrets: [],
    value: {
      futureNamespaceOption: 'keep',
      routes: { standard: {
        kind: 'standard', enabled: true, apiKeyEnv: 'ARK_STANDARD_API_KEY', futureRouteOption: 'keep',
        models: emptyModels ? [] : [{ id: 'my-model', futureModelOption: { keep: true } }],
      } },
    },
  }
  const saveSettings = vi.fn(async (_ns: string, ops: SettingsPathOpView[], revision: number) => {
    expect(revision).toBe(view.revision)
    const value = structuredClone(view.value) as Record<string, unknown>
    for (const op of ops) {
      let target = value
      for (const key of op.path.slice(0, -1)) target = target[key] as Record<string, unknown>
      const key = op.path.at(-1)!
      if (op.op === 'unset') delete target[key]
      else target[key] = op.value
    }
    view = { ...view, value: value as SettingsNamespaceView['value'], revision: view.revision + 1 }
    return structuredClone(view)
  })
  const saveCredential = vi.fn(async (_ref: string, _value: string) => {})
  const operations: CardOperations = {
    read: vi.fn(async () => ({ writable: true, hasDocument: true, namespaces: [structuredClone(view)] })),
    describeCredential: vi.fn(async () => undefined),
    saveSettings, saveCredential,
  }
  const props = {
    provider: { provider: 'volcengine-standard', displayName: '火山方舟 · 普通 API',
      settingsNs: 'llm-volcengine', settingsPath: ['routes', 'standard'], active: true },
    configured: true, keyConfigured: false, operations,
  } as unknown as ComponentProps<typeof VolcengineCard>
  return { props, operations, saveSettings, saveCredential, readView: () => view }
}

describe('Volcengine Models card', () => {
  it('creates the first model manually and preserves JSON member names as editable text', async () => {
    const fixture = setup(true)
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await click('添加模型')
    await change('模型 ID', 'user-chosen-model')
    const rawBody = '{ "__proto__": { "custom": true }, "thinking": { "type": "disabled" } }'
    await change('自定义请求体 JSON', rawBody)
    await click('保存方舟配置')
    expect(fixture.saveSettings.mock.calls[0][1]).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'user-chosen-model', customBody: rawBody,
    }] }])
    expect(input('自定义请求体 JSON').value).toBe(rawBody)
    expect(container.textContent).toContain('已保存')
  })

  it('edits models, force-enabled video and JSON through the DOM while preserving unknown settings', async () => {
    const fixture = setup()
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    expect(container.textContent).toContain('模型高级配置')
    expect(input('API Key').getAttribute('type')).toBe('password')
    expect(container.querySelector('details')!.open).toBe(false)
    await change('API Key', 'temporary-test-key')
    await change('模型 ID', 'manual-new-id')
    container.querySelector('details')!.open = true
    await change('视频输入', 'force_enable')
    await change('上下文容量', '131072')
    await change('自定义请求体 JSON', '{"thinking":{"type":"enabled"},"vendor_extra":true}')
    await click('保存方舟配置')
    expect(fixture.saveSettings).toHaveBeenCalledOnce()
    expect(fixture.saveSettings.mock.calls[0][1]).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'manual-new-id', futureModelOption: { keep: true }, modalities: { video: 'force_enable' },
      contextWindow: 131072, customBody: '{"thinking":{"type":"enabled"},"vendor_extra":true}',
    }] }])
    expect(fixture.saveCredential).toHaveBeenCalledWith('ARK_STANDARD_API_KEY', 'temporary-test-key')
    expect(fixture.readView().value).toMatchObject({
      futureNamespaceOption: 'keep', routes: { standard: { futureRouteOption: 'keep' } },
    })
    expect(input('API Key').value).toBe('')
    expect(container.innerHTML).not.toContain('temporary-test-key')
    expect(container.textContent).toContain('已保存，后续请求使用新配置。')
  })

  it('keeps invalid JSON editable and blocks both settings and credential writes', async () => {
    const fixture = setup()
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await change('自定义请求体 JSON', '[1,2]')
    await click('保存方舟配置')
    expect(input('自定义请求体 JSON').value).toBe('[1,2]')
    expect(container.textContent).toContain('必须是 JSON 对象')
    expect(fixture.saveSettings).not.toHaveBeenCalled()
    expect(fixture.saveCredential).not.toHaveBeenCalled()
  })

  it('retries a failed credential write using the committed settings revision and retaining the draft key', async () => {
    const fixture = setup()
    fixture.saveCredential.mockRejectedValueOnce(new Error('密钥未保存，请保留当前页面并重试。'))
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await change('模型 ID', 'first-edit')
    await click('保存方舟配置')
    expect(fixture.saveSettings).toHaveBeenCalledOnce()
    expect(input('API Key').value).toBe('temporary-test-key')
    await change('模型 ID', 'second-edit')
    await click('保存方舟配置')
    expect(fixture.saveSettings.mock.calls[1][2]).toBe(8)
    expect(fixture.saveCredential).toHaveBeenCalledTimes(2)
    expect(input('API Key').value).toBe('')
    expect(container.textContent).toContain('已保存')
  })
})
