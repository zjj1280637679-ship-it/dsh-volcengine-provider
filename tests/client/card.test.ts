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

function input(label: string, scope: ParentNode = container): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const element = scope.querySelector(`[aria-label="${label}"]`)
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing control: ${label}`)
  }
  return element
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function change(label: string, value: string, scope: ParentNode = container): Promise<void> {
  await act(async () => {
    const element = input(label, scope)
    const details: HTMLDetailsElement[] = []
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open) details.unshift(parent)
    }
    for (const row of details) row.querySelector('summary')!.click()
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

function modelOps(fixture: ReturnType<typeof setup>, call = 0): SettingsPathOpView[] {
  return fixture.saveSettings.mock.calls[call][1].filter(op => op.path.at(-1) === 'models')
}

describe('Volcengine Models card', () => {
  it('keeps model details collapsed, searches by ID or name, and preserves the selected row when another row is removed', async () => {
    const fixture = setup()
    fixture.readView().value = { routes: { standard: { kind: 'standard', models: [
      { id: 'seed-one', name: '主模型' },
      { id: 'flash-two', modalities: { video: 'force_disable' } },
      { id: 'third' }, { id: 'fourth' }, { id: 'fifth' },
    ] } } }
    await act(async () => root.render(createElement(VolcengineCard, fixture.props)))
    expect(container.querySelector('h3')).toBeNull()
    const rows = [...container.querySelectorAll<HTMLDetailsElement>('.ark-model-row')]
    expect(rows).toHaveLength(5)
    expect(rows.every(row => !row.open)).toBe(true)
    expect(rows[0].querySelector('summary')?.textContent).toContain('主模型')
    expect(rows[0].querySelector('summary')?.textContent).toContain('seed-one')
    expect(rows[1].querySelector('summary')?.textContent).toContain('视频：强制关闭')
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存方舟配置')!
    expect(save.disabled).toBe(true)
    await change('搜索模型', '主模型')
    expect(container.querySelectorAll('.ark-model-row:not([hidden])')).toHaveLength(1)
    await change('搜索模型', 'FLASH')
    expect(container.querySelectorAll('.ark-model-row:not([hidden])')).toHaveLength(1)
    expect(container.querySelector('.ark-model-row:not([hidden]) > .ark-model-summary')?.textContent).toContain('flash-two')
    await change('搜索模型', '')
    const restored = [...container.querySelectorAll<HTMLDetailsElement>('.ark-model-row')]
    await act(async () => {
      restored[0].querySelector<HTMLElement>('summary')!.click()
      restored[1].querySelector<HTMLElement>('summary')!.click()
    })
    expect(restored[1].open).toBe(true)
    await click('移除模型 1')
    const remaining = container.querySelector<HTMLDetailsElement>('.ark-model-row:not([hidden])')!
    expect(remaining.querySelector('summary')?.textContent).toContain('flash-two')
    expect(remaining.open).toBe(true)
    expect(container.textContent).toContain('有未保存修改')
  })

  it('creates the first model manually and preserves JSON member names as editable text', async () => {
    const fixture = setup(true)
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await click('添加模型')
    expect(container.querySelector<HTMLDetailsElement>('.ark-model-row')?.open).toBe(true)
    await change('模型 ID', 'user-chosen-model')
    const rawBody = '{ "__proto__": { "custom": true }, "thinking": { "type": "disabled" } }'
    await change('自定义请求体 JSON', rawBody)
    await click('保存方舟配置')
    expect(modelOps(fixture)).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'user-chosen-model', customBody: rawBody,
    }] }])
    expect(input('自定义请求体 JSON').value).toBe(rawBody)
    expect(container.textContent).toContain('已保存')
  })

  it('preserves expanded rows and advanced editors across search and a successful save', async () => {
    const fixture = setup()
    fixture.readView().value = { routes: { standard: { kind: 'standard', models: [
      { id: 'first', name: '主模型' }, { id: 'second' }, { id: 'third' }, { id: 'fourth' }, { id: 'fifth' },
    ] } } }
    vi.mocked(fixture.operations.describeCredential).mockResolvedValue({ configured: true, writable: true })
    await act(async () => root.render(createElement(VolcengineCard, fixture.props)))
    const row = container.querySelector<HTMLDetailsElement>('.ark-model-row')!
    const advanced = row.querySelector<HTMLDetailsElement>('.ark-model-advanced')!
    expect(input('模型显示名称', row).closest('details')).toBe(row)
    const body = `{ "thinking": { "type": "enabled" }, "vendor_text": "${'长字段'.repeat(8000)}" }`
    await change('自定义请求体 JSON', body, row)
    expect(row.open).toBe(true)
    expect(advanced.open).toBe(true)
    await change('搜索模型', 'second')
    expect(row.hidden).toBe(true)
    await click('保存方舟配置')
    expect(row.isConnected).toBe(true)
    expect(row.open).toBe(true)
    expect(advanced.open).toBe(true)
    await change('搜索模型', '')
    expect(row.hidden).toBe(false)
    expect(container.querySelector('.ark-model-row')).toBe(row)
    expect(input('自定义请求体 JSON', row).value).toBe(body)
    const savedModels = (fixture.readView().value as { routes: { standard: { models: Array<{ id: string; customBody?: string }> } } }).routes.standard.models
    expect(savedModels.map(model => model.id)).toEqual(['first', 'second', 'third', 'fourth', 'fifth'])
    expect(savedModels[0]!.customBody).toBe(body)
  })

  it.each([
    ['模型 ID', '', false],
    ['模型 ID', 'first', false],
    ['上下文容量', '0', true],
    ['输出上限', '1.5', true],
    ['智能体媒体续链预算', '-1', true],
    ['自定义请求体 JSON', '{broken', true],
  ] as const)('reveals and focuses a hidden invalid %s field (%s)', async (label, value, advancedField) => {
    const fixture = setup()
    fixture.readView().value = { routes: { standard: { kind: 'standard', models: [
      { id: 'first' }, { id: 'second' }, { id: 'third' }, { id: 'fourth' }, { id: 'fifth' },
    ] } } }
    await act(async () => root.render(createElement(VolcengineCard, fixture.props)))
    const row = container.querySelectorAll<HTMLDetailsElement>('.ark-model-row')[1]!
    await change(label, value, row)
    const advanced = row.querySelector<HTMLDetailsElement>('.ark-model-advanced')!
    await act(async () => {
      if (advanced.open) advanced.querySelector<HTMLElement>('summary')!.click()
      row.querySelector<HTMLElement>('.ark-model-summary')!.click()
    })
    await change('搜索模型', 'third')
    expect(row.hidden).toBe(true)
    await click('保存方舟配置')
    expect(input('搜索模型').value).toBe('')
    expect(row.hidden).toBe(false)
    expect(row.open).toBe(true)
    expect(advanced.open).toBe(advancedField)
    expect(document.activeElement).toBe(input(label, row))
    expect(input(label, row).getAttribute('aria-invalid')).toBe('true')
    expect(row.querySelector('.ark-model-summary')!.textContent).toContain('待修正')
    expect(fixture.saveSettings).not.toHaveBeenCalled()
    expect(fixture.saveCredential).not.toHaveBeenCalled()
  })

  it('undoes individual removals in either order without losing JSON or edits to other models', async () => {
    const fixture = setup()
    fixture.readView().value = { routes: { standard: { kind: 'standard', models: [
      { id: 'first' }, { id: 'second', future: { preserve: true } }, { id: 'third' }, { id: 'fourth' },
    ] } } }
    vi.mocked(fixture.operations.describeCredential).mockResolvedValue({ configured: true, writable: true })
    await act(async () => root.render(createElement(VolcengineCard, fixture.props)))
    const rows = [...container.querySelectorAll<HTMLDetailsElement>('.ark-model-row')]
    const body = `{ "vendor_text": "${'长字段'.repeat(8000)}" }`
    await change('自定义请求体 JSON', body, rows[1])
    await change('模型显示名称', '第四个模型的新名称', rows[3])
    await act(async () => rows[1]!.querySelector<HTMLButtonElement>('[aria-label="移除模型 second"]')!.click())
    await act(async () => rows[2]!.querySelector<HTMLButtonElement>('[aria-label="移除模型 third"]')!.click())
    expect(rows[1]!.hidden).toBe(true)
    expect(rows[2]!.hidden).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="撤销移除 third"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="撤销移除 second"]')!.click())
    expect(rows[1]!.open).toBe(true)
    expect(rows[1]!.querySelector<HTMLDetailsElement>('.ark-model-advanced')!.open).toBe(true)
    await click('保存方舟配置')
    expect(fixture.readView().value).toMatchObject({ routes: { standard: { models: [
      { id: 'first' }, { id: 'second', customBody: body, future: { preserve: true } },
      { id: 'third' }, { id: 'fourth', name: '第四个模型的新名称' },
    ] } } })
    expect(container.querySelector('[aria-label="待保存的模型移除"]')).toBeNull()
  })

  it('saves a provider before adding models or credentials without silently disabling it', async () => {
    const fixture = setup(true)
    await act(async () => root.render(createElement(VolcengineCard, fixture.props)))
    await change('通道显示名称', '稍后配置模型的通道')
    await click('保存方舟配置')
    expect(fixture.readView().value).toMatchObject({ routes: { standard: {
      name: '稍后配置模型的通道', enabled: true, models: [], apiKeyEnv: 'ARK_STANDARD_API_KEY',
    } } })
    expect(container.textContent).toContain('未就绪：待添加模型和密钥')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('添加模型并配置密钥')
    expect(fixture.saveCredential).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).toBeNull()
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
    expect(modelOps(fixture)).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'manual-new-id', futureModelOption: { keep: true }, modalities: { video: 'force_enable' },
      contextWindow: 131072, customBody: '{"thinking":{"type":"enabled"},"vendor_extra":true}',
    }] }])
    const storedRef = fixture.saveCredential.mock.calls[0][0]
    expect(storedRef).toMatch(/^DSH_VOLCENGINE_KEY_[A-F0-9]{32}$/)
    expect(fixture.saveCredential).toHaveBeenCalledWith(storedRef, 'temporary-test-key')
    expect(fixture.readView().value).toMatchObject({ routes: { standard: { apiKeyEnv: storedRef } } })
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

  it('retains both drafts after a credential failure and publishes settings only after a successful retry', async () => {
    const fixture = setup()
    fixture.saveCredential.mockRejectedValueOnce(new Error('密钥未保存，请保留当前页面并重试。'))
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await change('模型 ID', 'first-edit')
    await click('保存方舟配置')
    expect(fixture.saveSettings).not.toHaveBeenCalled()
    expect(fixture.readView().value).toMatchObject({ routes: { standard: { models: [{ id: 'my-model' }] } } })
    expect(input('API Key').value).toBe('temporary-test-key')
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe('密钥未保存，请保留当前页面并重试。')
    expect(container.querySelector('[role="status"]')).toBeNull()
    await change('模型 ID', 'second-edit')
    await click('保存方舟配置')
    expect(fixture.saveSettings).toHaveBeenCalledOnce()
    expect(fixture.saveSettings.mock.calls[0][2]).toBe(7)
    expect(fixture.saveCredential).toHaveBeenCalledTimes(2)
    expect(input('API Key').value).toBe('')
    expect(container.textContent).toContain('已保存')
  })

  it('admits only one save for two activations in the same React batch', async () => {
    const fixture = setup()
    const pending = deferred<void>()
    fixture.saveCredential.mockImplementation(() => pending.promise)
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    const save = [...container.querySelectorAll('button')].find(item => item.textContent === '保存方舟配置')!
    await act(async () => { save.click(); save.click() })
    expect(fixture.saveCredential).toHaveBeenCalledOnce()
    expect(fixture.operations.describeCredential).toHaveBeenCalledTimes(2)
    expect(fixture.saveSettings).not.toHaveBeenCalled()
    await act(async () => pending.resolve())
    expect(input('API Key').value).toBe('')
    expect(container.textContent).toContain('已保存')
  })

  it.each(['provider', 'path', 'namespace'] as const)(
    'resets the draft immediately for a new %s binding and ignores an old pending save', async kind => {
      const fixture = setup()
      const pendingSave = deferred<SettingsNamespaceView>()
      const pendingRead = deferred<Awaited<ReturnType<CardOperations['read']>>>()
      fixture.saveSettings.mockImplementation(() => pendingSave.promise)
      await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
      await change('API Key', 'temporary-old-key')
      await change('模型 ID', 'old-unsaved-edit')
      await click('保存方舟配置')
      expect(fixture.saveSettings).toHaveBeenCalledOnce()

      const nextView = structuredClone(fixture.readView())
      const nextProps = { ...fixture.props, provider: { ...fixture.props.provider } }
      if (kind === 'provider') nextProps.provider.provider = 'volcengine-another-provider'
      if (kind === 'path') {
        nextProps.provider.settingsPath = ['routes', 'coding']
        nextView.value = { routes: { coding: {
          kind: 'coding-plan', models: [{ id: 'coding-model' }],
        } } }
      }
      if (kind === 'namespace') {
        nextProps.provider.settingsNs = 'llm-other-namespace'
        nextView.ns = 'llm-other-namespace'
      }
      vi.mocked(fixture.operations.read).mockImplementationOnce(() => pendingRead.promise)

      await act(async () => { root.render(createElement(VolcengineCard, nextProps)) })
      // While the new binding is loading, no previous route fields or draft key
      // are rendered under its title; an effect-only reset would leave them here.
      expect(container.querySelector('[aria-label="模型 ID"]')).toBeNull()
      expect(container.querySelector('[aria-label="API Key"]')).toBeNull()
      expect(container.querySelector('[role="alert"]')).toBeNull()
      await act(async () => pendingRead.resolve({ writable: true, hasDocument: true, namespaces: [nextView] }))
      expect(input('模型 ID').value).toBe(kind === 'path' ? 'coding-model' : 'my-model')
      expect(input('API Key').value).toBe('')

      const committed = structuredClone(fixture.readView())
      committed.revision = 8
      committed.value = { routes: { standard: {
        kind: 'standard', apiKeyEnv: 'ARK_STANDARD_API_KEY', models: [{ id: 'old-committed-edit' }],
      } } }
      await act(async () => pendingSave.resolve(committed))
      expect(fixture.saveCredential).toHaveBeenCalledOnce()
      expect(fixture.saveCredential.mock.calls[0][1]).toBe('temporary-old-key')
      expect(input('模型 ID').value).toBe(kind === 'path' ? 'coding-model' : 'my-model')
      expect(input('密钥引用名称').value).toBe(kind === 'path' ? 'ARK_CODING_PLAN_API_KEY' : 'ARK_STANDARD_API_KEY')
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.querySelector('[role="status"]')).toBeNull()
    },
  )

  it('finishes an accepted save after unmount during credential validation without updating the detached card', async () => {
    const fixture = setup()
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await change('模型 ID', 'pending-edit')
    const pending = deferred<Awaited<ReturnType<CardOperations['describeCredential']>>>()
    vi.mocked(fixture.operations.describeCredential).mockImplementationOnce(() => pending.promise)
    await click('保存方舟配置')
    await act(async () => { root.unmount() })
    await act(async () => pending.resolve(undefined))
    expect(fixture.saveSettings).toHaveBeenCalledOnce()
    expect(fixture.saveCredential).toHaveBeenCalledOnce()
    expect(fixture.readView().value).toMatchObject({ routes: { standard: { models: [{ id: 'pending-edit' }] } } })
    expect(container.textContent).toBe('')
    root = createRoot(container)
  })

  it('does not refill a new provider binding with an older credential-save failure', async () => {
    const fixture = setup()
    const pending = deferred<void>()
    fixture.saveCredential.mockImplementationOnce(() => pending.promise)
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-old-key')
    await click('保存方舟配置')
    fixture.readView().value = { routes: { coding: {
      kind: 'coding-plan', apiKeyEnv: 'ARK_CODING_PLAN_API_KEY', models: [{ id: 'coding-model' }],
    } } }
    await act(async () => { root.render(createElement(VolcengineCard, {
      ...fixture.props,
      provider: { ...fixture.props.provider, provider: 'volcengine-coding', displayName: 'Coding Plan',
        settingsPath: ['routes', 'coding'] },
    })) })
    await change('API Key', 'temporary-new-key')
    await act(async () => pending.reject(new Error('old-connection-failure')))
    expect(input('API Key').value).toBe('temporary-new-key')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('leaves all media unset until manual edits and removes a choice when returned to unset', async () => {
    const fixture = setup()
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    expect(input('图片输入').value).toBe('inherit')
    expect(input('视频输入').value).toBe('inherit')
    expect(input('音频输入').value).toBe('inherit')
    expect(input('视频输入').textContent).not.toContain('继承（关闭）')
    await change('API Key', 'temporary-test-key')
    await change('图片输入', 'force_enable')
    await change('视频输入', 'force_disable')
    await change('音频输入', 'force_enable')
    await change('图片输入', 'inherit')
    await change('音频输入', 'inherit')
    await click('保存方舟配置')
    expect(modelOps(fixture)).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'my-model', futureModelOption: { keep: true }, modalities: { video: 'force_disable' },
    }] }])
    await change('API Key', 'temporary-test-key')
    await change('视频输入', 'inherit')
    await click('保存方舟配置')
    expect(modelOps(fixture, 1)).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'my-model', futureModelOption: { keep: true },
    }] }])
  })

  it('shows and saves the tool-result-only agent media continuation budget', async () => {
    const fixture = setup()
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    expect(input('智能体媒体续链预算').value).toBe('45')
    expect(container.textContent).toContain('仅作用于 tool-result 中的图片和视频')
    expect(container.textContent).toContain('只从本次模型请求省略，不删除原文件')
    expect(container.textContent).toContain('0 表示关闭此降级')
    await change('API Key', 'temporary-test-key')
    await change('智能体媒体续链预算', '12.5')
    await click('保存方舟配置')
    expect(modelOps(fixture)).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'my-model', futureModelOption: { keep: true }, agentMediaFallbackMB: 12.5,
    }] }])
  })

  it('preserves already stored inherit fields when the user does not edit them', async () => {
    const fixture = setup()
    fixture.readView().value = { routes: { standard: {
      kind: 'standard', models: [{ id: 'legacy-model', modalities: { image: 'inherit', audio: 'force_enable' } }],
    } } }
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await change('模型 ID', 'renamed-model')
    await click('保存方舟配置')
    expect(modelOps(fixture)).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'renamed-model', modalities: { image: 'inherit', audio: 'force_enable' },
    }] }])
  })
})
