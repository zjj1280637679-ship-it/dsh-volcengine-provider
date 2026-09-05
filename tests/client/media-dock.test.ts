// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MediaDock } from '../../src/client/MediaDock.js'
import type { MediaOperations } from '../../src/client/media-operations.js'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

function operations(): MediaOperations {
  const state = { current: { provider: 'custom-ark-route', model: 'my-model' }, routable: true }
  return { sessionId: 'session-one', selection: { getSnapshot: () => state, subscribe: () => () => {} },
    check: vi.fn(async () => state.current), send: vi.fn(async () => {}) }
}
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  if (result === undefined) throw new Error(`Missing ${text}`)
  return result
}
async function change(label: string, value: string): Promise<void> {
  await act(async () => {
    const element = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function files(...files: File[]): Promise<void> {
  await act(async () => {
    const input = container.querySelector('input[type=file]')!
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const session = { removed: false, subagent: null, running: false }

it('edits explicit MIME and audio format and submits once on a same-tick double click', async () => {
  const ops = operations()
  let settle!: () => void
  vi.mocked(ops.send).mockImplementation(() => new Promise(resolve => { settle = resolve }))
  await act(async () => root.render(createElement(MediaDock, { operations: ops, session })))
  const original = new File(['raw bytes'], 'opaque.custom')
  await files(original)
  expect(button('发送媒体').disabled).toBe(true)
  await change('文件 1 MIME 类型', 'audio/x-custom')
  await change('文件 1 音频格式', 'futureformat')
  await change('媒体问题', '请转录')
  await act(async () => { button('发送媒体').click(); button('发送媒体').click() })
  expect(ops.send).toHaveBeenCalledOnce()
  const sent = vi.mocked(ops.send).mock.calls[0]!
  expect(sent[0]).toEqual([{ file: original, mediaType: 'audio/x-custom', format: 'futureformat' }])
  expect(sent[0][0]!.file).toBe(original)
  expect(sent[1]).toBe('请转录')
  await act(async () => { settle() })
  expect(container.textContent).not.toContain('opaque.custom')
  expect(container.textContent).toContain('媒体消息已送入当前会话')
})

it('retains files and text on handler failure and cancellation; unmount aborts in-flight work', async () => {
  const ops = operations()
  vi.mocked(ops.send).mockRejectedValueOnce(new Error('音频尚未启用'))
  await act(async () => root.render(createElement(MediaDock, { operations: ops, session })))
  const original = new File(['PNG'], 'keep.png', { type: 'image/png' })
  await files(original)
  await change('媒体问题', '保留这个问题')
  await act(async () => button('发送媒体').click())
  expect(container.textContent).toContain('keep.png')
  expect(container.textContent).toContain('音频尚未启用')
  expect((container.querySelector('[aria-label="媒体问题"]') as HTMLTextAreaElement).value).toBe('保留这个问题')
  vi.mocked(ops.send).mockImplementation(async (_files, _prompt, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
  }))
  await act(async () => button('发送媒体').click())
  await act(async () => button('取消').click())
  expect(container.textContent).toContain('文件和填写内容已保留')
  expect(container.textContent).toContain('keep.png')
  await act(async () => button('发送媒体').click())
  const signal = vi.mocked(ops.send).mock.calls.at(-1)![2]
  await act(async () => { root.render(null) })
  expect(signal.aborted).toBe(true)
})

it('keeps the media action disabled when unavailable and does not inspect subagent commands', async () => {
  const ops = operations()
  vi.mocked(ops.check).mockRejectedValue(new Error('请选择火山方舟模型'))
  await act(async () => root.render(createElement(MediaDock, { operations: ops, session })))
  expect(button('添加原始媒体').disabled).toBe(true)
  expect(button('发送媒体').disabled).toBe(true)
  vi.mocked(ops.check).mockClear()
  await act(async () => root.render(createElement(MediaDock, { operations: ops, session: { ...session, subagent: {} } })))
  expect(ops.check).not.toHaveBeenCalled()
  expect(button('重新检查').disabled).toBe(true)
})
