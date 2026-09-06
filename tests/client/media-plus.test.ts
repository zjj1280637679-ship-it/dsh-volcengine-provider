// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MediaAttachments, MediaPlus } from '../../src/client/MediaPlus.js'
import type {
  NativeMediaDraftOperations,
  NativeMediaDraftState,
} from '../../src/client/native-media-upload.js'
import type { MediaDirectoryState } from '../../src/client/media-operations.js'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function operations(initial: Partial<NativeMediaDraftState> = {}) {
  const listeners = new Set<() => void>()
  const selectionListeners = new Set<() => void>()
  let state: NativeMediaDraftState = { uploads: 0, bundles: [], ...initial }
  let selection: MediaDirectoryState = {
    current: { provider: 'volcengine-coding-plan', model: 'doubao-seed-2.0-lite' }, routable: true,
  }
  return {
    state: {
      getSnapshot: () => state,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    selection: {
      getSnapshot: () => selection,
      subscribe: (listener: () => void) => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } },
    },
    load: vi.fn(async () => {}),
    addFiles: vi.fn(async () => {}),
    cancelUpload: vi.fn(),
    notify: vi.fn(),
    select(next: MediaDirectoryState) { selection = next; for (const listener of [...selectionListeners]) listener() },
    publish(next: NativeMediaDraftState) { state = next; for (const listener of [...listeners]) listener() },
  } satisfies NativeMediaDraftOperations & {
    select(next: MediaDirectoryState): void
    publish(next: NativeMediaDraftState): void
  }
}

const session = { removed: false, subagent: null }
const input = { phase: 'plain' as const }

it('renders only one colored plus and one multi-format hidden picker', async () => {
  const ops = operations()
  await act(async () => root.render(createElement(MediaPlus, { operations: ops, session, input })))
  const picker = container.querySelector('input[type=file]') as HTMLInputElement
  const plus = container.querySelector('button') as HTMLButtonElement
  expect(container.querySelectorAll('button')).toHaveLength(1)
  expect(plus.textContent).toBe('+')
  expect(plus.title).toBe('添加方舟媒体附件 · volcengine-coding-plan / doubao-seed-2.0-lite')
  expect(plus.style.background).toContain('linear-gradient')
  expect(picker.hidden).toBe(true)
  expect(picker.multiple).toBe(true)
  expect(picker.accept).toContain('.mp4')
  expect(picker.accept).toContain('.png')
  expect(picker.accept).toContain('.m4a')
  expect(picker.accept).not.toContain('.pdf')
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.textContent).toContain('方舟媒体')
  expect(container.textContent).toContain('doubao-seed-2.0-lite')
  expect(ops.load).toHaveBeenCalledOnce()
})

it('passes original files together and leaves text submission to Harness', async () => {
  const ops = operations()
  await act(async () => root.render(createElement(MediaPlus, { operations: ops, session, input })))
  const picker = container.querySelector('input[type=file]') as HTMLInputElement
  const plus = container.querySelector('button') as HTMLButtonElement
  const click = vi.spyOn(picker, 'click')
  plus.click()
  expect(click).toHaveBeenCalledOnce()
  const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' })
  const audio = new File(['audio'], 'voice.m4a', { type: 'audio/mp4' })
  Object.defineProperty(picker, 'files', { value: [video, audio], configurable: true })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  expect(ops.addFiles).toHaveBeenCalledWith([video, audio])
  expect(picker.value).toBe('')
  expect(container.querySelectorAll('button')).toHaveLength(1)
})

it('announces active upload groups while keeping the one attachment picker available', async () => {
  const ops = operations({ uploads: 2 })
  await act(async () => root.render(createElement(MediaPlus, { operations: ops, session, input })))
  const plus = container.querySelector('button') as HTMLButtonElement
  expect(plus.disabled).toBe(false)
  expect(plus.getAttribute('aria-label')).toBe('添加方舟媒体附件')
  expect(plus.title).toContain('点击可继续添加')
  const status = container.querySelector('[role="status"]')!
  expect(status.textContent).toContain('方舟媒体 · 2 组上传中')
  expect(plus.getAttribute('aria-describedby')).toBe(status.id)
  expect(container.querySelectorAll('button')).toHaveLength(1)
  expect(container.querySelector('textarea')).toBeNull()
})

it('shows unavailable selection before opening the picker and reacts to model changes', async () => {
  const ops = operations()
  ops.select({ current: { provider: 'other-provider', model: 'text-model' }, routable: true })
  await act(async () => root.render(createElement(MediaPlus, { operations: ops, session, input })))
  const plus = container.querySelector('button') as HTMLButtonElement
  const picker = container.querySelector('input') as HTMLInputElement
  const click = vi.spyOn(picker, 'click')
  expect(plus.disabled).toBe(true)
  expect(picker.disabled).toBe(true)
  expect(plus.title).toBe('请先选择已启用的方舟模型')
  expect(container.textContent).toContain('先选择方舟模型')
  plus.click()
  expect(click).not.toHaveBeenCalled()
  await act(async () => ops.select({ current: { provider: 'volcengine-standard', model: 'manual-id' }, routable: true }))
  expect(plus.disabled).toBe(false)
  expect(container.textContent).toContain('manual-id')
  expect(ops.addFiles).not.toHaveBeenCalled()
})

it('shows exact file details and a group cancellation action in the separate dock', async () => {
  const ops = operations({ uploads: 1, bundles: [{
    bundleId: 'bundle-a', label: 'clip.mp4 +1', state: 'uploading',
    expected: { provider: 'volcengine-coding-plan', model: 'doubao-seed-2.0-lite' },
    files: [
      { name: 'clip.mp4', modality: 'video', mediaType: 'video/mp4', bytes: 4096, uploadedBytes: 2048 },
      { name: 'voice.m4a', modality: 'audio', mediaType: 'audio/x-m4a', format: 'm4a', bytes: 100, uploadedBytes: 0 },
    ],
  }] })
  await act(async () => root.render(createElement(MediaAttachments, { operations: ops, session, input })))
  expect(container.querySelector('details')).not.toBeNull()
  expect(container.querySelectorAll('li')).toHaveLength(2)
  expect(container.querySelectorAll('progress')).toHaveLength(2)
  expect(container.querySelector('progress')!.getAttribute('value')).toBe('2048')
  expect(container.querySelector('progress')!.getAttribute('max')).toBe('4096')
  expect(container.textContent).toContain('video/mp4 · 4.0 KB · 上传中')
  expect(container.textContent).toContain('audio/x-m4a · 100 B · 等待上传')
  expect(container.textContent).toContain('删除输入框中的该引用会移除整组')
  expect(container.querySelectorAll('button')).toHaveLength(1)
  ;(container.querySelector('button') as HTMLButtonElement).click()
  expect(ops.cancelUpload).toHaveBeenCalledWith('bundle-a')
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('input')).toBeNull()
  await act(async () => root.render(createElement(MediaAttachments, { operations: ops, session, input: { phase: 'submitting' } })))
  expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
})

it('surfaces a changed target and failed or restored bundles without inventing file progress', async () => {
  const ops = operations({ bundles: [{
    bundleId: 'bundle-a', label: 'clip.mp4', state: 'ready',
    expected: { provider: 'volcengine-coding-plan', model: 'old-model' },
  }] })
  await act(async () => root.render(createElement(MediaAttachments, { operations: ops, session, input })))
  expect(container.textContent).toContain('需要处理')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('当前模型与附件不一致')
  expect(container.textContent).toContain('已恢复附件引用')
  expect(container.querySelector('progress')).toBeNull()
  expect(container.querySelector('button')).toBeNull()
  await act(async () => ops.publish({ uploads: 0, bundles: [{
    bundleId: 'bundle-a', label: 'clip.mp4', state: 'failed', error: 'disk unavailable',
    expected: { provider: 'volcengine-coding-plan', model: 'doubao-seed-2.0-lite' },
    files: [{ name: 'clip.mp4', modality: 'video', mediaType: 'video/mp4', bytes: 4, uploadedBytes: 2 }],
  }] }))
  expect(container.textContent).toContain('上传失败')
  expect(container.textContent).toContain('disk unavailable')
  expect(container.textContent).toContain('2 B / 4 B')
  expect(container.textContent).toContain('请删除输入框中对应的 Ark 引用，再重新选择这一组文件')
  expect(container.querySelector('button')).toBeNull()
})

it('surfaces picker failures through the native composer notice and respects its phase', async () => {
  const ops = operations()
  vi.mocked(ops.addFiles).mockRejectedValueOnce(new Error('unsupported media'))
  await act(async () => root.render(createElement(MediaPlus, { operations: ops, session, input })))
  const picker = container.querySelector('input[type=file]') as HTMLInputElement
  Object.defineProperty(picker, 'files', {
    value: [new File(['x'], 'bad.pdf', { type: 'application/pdf' })], configurable: true,
  })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  expect(ops.notify).toHaveBeenCalledWith('error', 'unsupported media')

  await act(async () => root.render(createElement(MediaPlus, {
    operations: ops, session, input: { phase: 'submitting' },
  })))
  expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
  expect((container.querySelector('button') as HTMLButtonElement).title).toBe('请先完成或取消当前输入操作')
  expect((container.querySelector('input') as HTMLInputElement).disabled).toBe(true)
})
