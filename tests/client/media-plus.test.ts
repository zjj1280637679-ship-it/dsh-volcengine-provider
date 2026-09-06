// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MediaPlus } from '../../src/client/MediaPlus.js'
import type {
  NativeMediaDraftOperations,
  NativeMediaDraftState,
} from '../../src/client/native-media-upload.js'

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

function operations(initial: NativeMediaDraftState = { uploads: 0 }): NativeMediaDraftOperations {
  const listeners = new Set<() => void>()
  let state = initial
  return {
    state: {
      getSnapshot: () => state,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    addFiles: vi.fn(async () => {}),
    notify: vi.fn(),
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
  expect(plus.title).toBe('添加方舟媒体附件')
  expect(plus.style.background).toContain('linear-gradient')
  expect(picker.hidden).toBe(true)
  expect(picker.multiple).toBe(true)
  expect(picker.accept).toContain('.mp4')
  expect(picker.accept).toContain('.png')
  expect(picker.accept).toContain('.m4a')
  expect(picker.accept).not.toContain('.pdf')
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.textContent).toBe('+')
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
  expect((container.querySelector('input') as HTMLInputElement).disabled).toBe(true)
})
