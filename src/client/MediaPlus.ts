import { createElement as h, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import { ARK_CHAT_MEDIA_ACCEPT } from '../media-file-types.js'
import type { NativeMediaDraftBundle, NativeMediaDraftOperations } from './native-media-upload.js'
import type { MediaDirectoryState } from './media-operations.js'
import { describeUiError, ErrorNotice, type UiError } from './ui-feedback.js'

export interface MediaPlusProps {
  readonly operations: NativeMediaDraftOperations
  readonly session: { readonly removed: boolean; readonly subagent: unknown | null }
  readonly input: { readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' }
}

const button: CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  border: 0,
  borderRadius: '50%',
  color: '#fff',
  background: 'linear-gradient(135deg, #ff7a18 0%, #af2cff 52%, #1677ff 100%)',
  boxShadow: '0 1px 4px color-mix(in srgb, #7c3aed 38%, transparent)',
  font: '600 21px/1 system-ui, sans-serif',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flex: '0 0 auto',
}

const secondary: CSSProperties = { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: 1.45 }
const action: CSSProperties = {
  color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #8886)',
  borderRadius: '6px', padding: '4px 8px', font: 'inherit', fontSize: '12px', cursor: 'pointer',
}

function canAddMedia(selection: MediaDirectoryState): boolean {
  return selection.routable !== false && selection.current !== null
    && selection.current.provider.startsWith('volcengine-') && selection.current.model.length > 0
}

function targetLabel(bundle: NativeMediaDraftBundle): string {
  const routes: Record<string, string> = {
    'volcengine-standard': '普通 API', 'volcengine-agent-plan': 'Agent Plan', 'volcengine-coding-plan': 'Coding Plan',
  }
  return `${routes[bundle.expected.provider] ?? bundle.expected.provider} / ${bundle.expected.model}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One compact picker beside Harness's resident plus; native composer owns the text and send action. */
export function MediaPlus({ operations, session, input }: MediaPlusProps): ReactNode {
  const picker = useRef<HTMLInputElement>(null)
  const statusId = useId()
  const [failure, setFailure] = useState<UiError>()
  const uploadState = useSyncExternalStore(operations.state.subscribe, operations.state.getSnapshot)
  const selection = useSyncExternalStore(operations.selection.subscribe, operations.selection.getSnapshot)
  useEffect(() => {
    if (session.removed || session.subagent !== null) return
    let active = true
    setFailure(undefined)
    void operations.load().catch(error => {
      if (active) setFailure(describeUiError(error, '附件状态暂时无法加载，请重新打开会话。'))
    })
    return () => { active = false }
  }, [operations, session.removed, session.subagent])
  const eligible = canAddMedia(selection)
  const disabled = session.removed || session.subagent !== null || input.phase !== 'plain' || !eligible
  const selected = eligible ? `${selection.current!.provider} / ${selection.current!.model}` : '请先选择已启用的方舟模型'
  const title = session.removed ? '此会话已移除'
    : session.subagent !== null ? '请在主会话中添加方舟媒体附件'
      : input.phase !== 'plain' ? '请先完成或取消当前输入操作'
        : !eligible ? selected
          : `${uploadState.uploads > 0 ? '方舟媒体正在上传，点击可继续添加' : '添加方舟媒体附件'} · ${selected}`
  return h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minWidth: 0 } },
    h('input', {
      ref: picker,
      type: 'file',
      hidden: true,
      multiple: true,
      accept: ARK_CHAT_MEDIA_ACCEPT,
      'aria-label': '选择方舟媒体附件',
      disabled,
      onChange: (event: { target: HTMLInputElement }) => {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ''
        if (files.length === 0) return
        setFailure(undefined)
        void operations.addFiles(files).catch(error => setFailure(describeUiError(error, '附件未添加，请检查文件后重试。')))
      },
    }),
    h('button', {
      type: 'button',
      style: { ...button, ...(disabled ? { cursor: 'not-allowed', opacity: 0.45 } : {}),
        ...(uploadState.uploads > 0 ? { filter: 'saturate(0.75)' } : {}) },
      disabled,
      'aria-label': '添加方舟媒体附件',
      'aria-describedby': statusId,
      title,
      onClick: () => picker.current?.click(),
    }, '+'),
    h('span', { id: statusId, role: 'status', 'aria-live': 'polite',
      style: { position: 'absolute', width: 1, height: 1, padding: 0, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' } },
      uploadState.uploads > 0 ? `${uploadState.uploads} 组上传中` : ''),
    failure === undefined ? null : h(ErrorNotice, { error: failure }))
}

/** Native chips own ready attachments. This dock only supplies transient progress and actionable failures. */
export function MediaAttachments({ operations, session, input }: MediaPlusProps): ReactNode {
  const state = useSyncExternalStore(operations.state.subscribe, operations.state.getSnapshot)
  const selection = useSyncExternalStore(operations.selection.subscribe, operations.selection.getSnapshot)
  const pending = state.bundles.filter(bundle => bundle.state !== 'ready'
    || bundle.expected.provider !== selection.current?.provider || bundle.expected.model !== selection.current?.model)
  if (pending.length === 0 || session.removed || session.subagent !== null) return null
  return h('div', { 'aria-label': '附件状态',
    style: { display: 'grid', gap: '8px', minWidth: 0, width: '100%', maxHeight: '160px', overflowY: 'auto' } },
    ...pending.map(bundle => {
      const mismatch = bundle.expected.provider !== selection.current?.provider || bundle.expected.model !== selection.current?.model
      const label = bundle.state === 'uploading' ? '上传中' : bundle.state === 'ready' ? '模型已改变'
        : bundle.state === 'cancelled' ? '已取消' : '上传失败'
      return h('section', { key: bundle.bundleId, 'aria-label': `方舟附件组：${bundle.label}`,
        style: { display: 'grid', gap: '6px', minWidth: 0, padding: '8px 10px',
          border: '1px solid var(--dsw-alias-border-l2, #8886)', borderRadius: '8px', fontSize: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'start', gap: '8px', flexWrap: 'wrap' } },
        h('strong', { style: { flex: '1 1 160px', overflowWrap: 'anywhere' } }, bundle.label),
        h('span', { style: secondary }, label),
        bundle.state === 'uploading' ? h('button', {
          type: 'button', style: action, disabled: input.phase !== 'plain',
          'aria-label': `取消整组上传：${bundle.label}`,
          onClick: () => operations.cancelUpload(bundle.bundleId),
        }, '取消上传') : null),
      mismatch ? h('div', { role: 'alert', style: { ...secondary, color: 'var(--dsw-alias-state-warn-label, #9b6400)' } },
        `附件属于 ${targetLabel(bundle)}。请切回该模型，或移除后重新添加。`) : null,
      bundle.error === undefined ? null : h(ErrorNotice, {
        error: describeUiError(bundle.error, '上传失败，请移除对应附件后重新添加。'),
      }),
      bundle.state !== 'uploading' || bundle.files === undefined ? null
        : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '6px' } },
          ...bundle.files.map((file, index) => h('li', { key: index, style: { display: 'grid', gap: '3px', minWidth: 0 } },
            bundle.files!.length > 1 ? h('div', { style: { overflowWrap: 'anywhere' } }, file.name) : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('progress', { max: file.bytes, value: file.uploadedBytes,
                'aria-label': `${file.name} 上传进度`, style: { flex: '1 1 100px', minWidth: 0, height: '6px' } }),
              h('span', { style: secondary }, `${formatBytes(file.uploadedBytes)} / ${formatBytes(file.bytes)}`))))))
    }))
}
