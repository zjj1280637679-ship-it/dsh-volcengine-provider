// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { describeUiError, ErrorNotice } from '../../src/client/ui-feedback.js'

it('keeps technical payloads out of alerts and bounds diagnostics even after opening them', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  const root = createRoot(container)
  const raw = '错误：provider=volcengine-standard model_id=manual-id\n'
    + 'Authorization: Bearer fake-secret\n{"api_key":"fake-key","issues":[' + '"invalid_field",'.repeat(5000) + ']}'
  const error = describeUiError(new Error(raw), '上传失败，请重新添加附件。')
  try {
    await act(async () => root.render(createElement(ErrorNotice, { error })))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('上传失败，请重新添加附件。')
    expect(container.textContent).not.toMatch(/provider|issues|fake-secret|fake-key/u)
    expect(container.querySelector('pre')).toBeNull()
    await act(async () => container.querySelector('summary')!.click())
    expect(container.querySelector('pre')?.textContent).toContain('invalid_field')
    expect(container.querySelector('pre')?.textContent?.length).toBeLessThan(2050)
    expect(container.textContent).not.toMatch(/fake-secret|fake-key/u)
    const next = describeUiError(new Error('other protocol failure'), '连接已断开，请重新打开会话。')
    await act(async () => root.render(createElement(ErrorNotice, { error: next })))
    expect(container.querySelector('pre')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(next.message)
  } finally {
    await act(async () => root.unmount())
  }
})

it('keeps validation actionable without repeating its implementation language', () => {
  expect(describeUiError(new Error('Each Ark media attachment must contain at least one byte.'), '添加失败'))
    .toEqual({ message: '文件为空，请重新选择。' })
  expect(describeUiError(new DOMException('上传已取消。', 'AbortError'), '添加失败'))
    .toEqual({ message: '上传已取消。' })
  expect(describeUiError(new Error('自定义请求体不是有效的 JSON，请检查引号、逗号和括号。'), '保存失败').message)
    .toContain('请检查引号')
  expect(describeUiError(new Error('错误：provider=volcengine-standard model_id=abc max_tokens=12'), '操作失败').message)
    .toBe('操作失败')
})
