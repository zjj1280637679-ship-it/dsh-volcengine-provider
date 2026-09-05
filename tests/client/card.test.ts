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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
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
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe('配置已保存，但密钥未保存。请保留当前页面并重试保存密钥。')
    expect(container.querySelector('[role="status"]')).toBeNull()
    await change('模型 ID', 'second-edit')
    await click('保存方舟配置')
    expect(fixture.saveSettings.mock.calls[1][2]).toBe(8)
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
      expect(fixture.saveCredential).not.toHaveBeenCalled()
      expect(input('模型 ID').value).toBe(kind === 'path' ? 'coding-model' : 'my-model')
      expect(input('密钥引用名称').value).toBe(kind === 'path' ? 'ARK_CODING_PLAN_API_KEY' : 'ARK_STANDARD_API_KEY')
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.querySelector('[role="status"]')).toBeNull()
    },
  )

  it('does not start a settings or credential write after unmount during credential validation', async () => {
    const fixture = setup()
    await act(async () => { root.render(createElement(VolcengineCard, fixture.props)) })
    await change('API Key', 'temporary-test-key')
    await change('模型 ID', 'pending-edit')
    const pending = deferred<Awaited<ReturnType<CardOperations['describeCredential']>>>()
    vi.mocked(fixture.operations.describeCredential).mockImplementationOnce(() => pending.promise)
    await click('保存方舟配置')
    await act(async () => { root.unmount() })
    await act(async () => pending.resolve(undefined))
    expect(fixture.saveSettings).not.toHaveBeenCalled()
    expect(fixture.saveCredential).not.toHaveBeenCalled()
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
    expect(fixture.saveSettings.mock.calls[0][1]).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'my-model', futureModelOption: { keep: true }, modalities: { video: 'force_disable' },
    }] }])
    await change('API Key', 'temporary-test-key')
    await change('视频输入', 'inherit')
    await click('保存方舟配置')
    expect(fixture.saveSettings.mock.calls[1][1]).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'my-model', futureModelOption: { keep: true },
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
    expect(fixture.saveSettings.mock.calls[0][1]).toEqual([{ op: 'set', path: ['routes', 'standard', 'models'], value: [{
      id: 'renamed-model', modalities: { image: 'inherit', audio: 'force_enable' },
    }] }])
  })
})
