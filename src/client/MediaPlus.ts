import { createElement as h, useEffect, useId, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import { ARK_CHAT_MEDIA_ACCEPT } from '../media-file-types.js'
import type { NativeMediaDraftBundle, NativeMediaDraftFile, NativeMediaDraftOperations } from './native-media-upload.js'
import type { MediaDirectoryState } from './media-operations.js'

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
  return `${bundle.expected.provider} / ${bundle.expected.model}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileStatus(file: NativeMediaDraftFile, bundle: NativeMediaDraftBundle): string {
  if (bundle.state === 'ready') return '已就绪'
  if (file.uploadedBytes === file.bytes) return bundle.state === 'uploading' ? '已上传，等待整组就绪' : '已上传，整组未就绪'
  if (bundle.state === 'cancelled') return '已取消'
  if (bundle.state === 'failed') return file.uploadedBytes > 0 ? '上传中断' : '未上传'
  return file.uploadedBytes > 0 ? '上传中' : '等待上传'
}

/** One compact picker beside Harness's resident plus; native composer owns the text and send action. */
export function MediaPlus({ operations, session, input }: MediaPlusProps): ReactNode {
  const picker = useRef<HTMLInputElement>(null)
  const statusId = useId()
  const uploadState = useSyncExternalStore(operations.state.subscribe, operations.state.getSnapshot)
  const selection = useSyncExternalStore(operations.selection.subscribe, operations.selection.getSnapshot)
  useEffect(() => {
    if (session.removed || session.subagent !== null) return
    let active = true
    void operations.load().catch(error => {
      if (active) operations.notify('error', error instanceof Error ? error.message : '方舟媒体状态暂时无法加载。')
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
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
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
        void operations.addFiles(files).catch(error => operations.notify(
          'error', error instanceof Error ? error.message : '方舟媒体附件未添加。',
        ))
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
    h('span', { id: statusId, role: 'status', 'aria-live': 'polite', title: selected,
      style: { ...secondary, display: 'grid', maxWidth: '120px', minWidth: 0, lineHeight: 1.2 } },
    h('span', null, uploadState.uploads > 0 ? `方舟媒体 · ${uploadState.uploads} 组上传中` : '方舟媒体'),
    h('span', { style: { fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.8 } },
      eligible ? selection.current!.model : '先选择方舟模型')))
}

/** Full-width public dock; the native attachment area and submit action stay owned by Harness. */
export function MediaAttachments({ operations, session, input }: MediaPlusProps): ReactNode {
  const state = useSyncExternalStore(operations.state.subscribe, operations.state.getSnapshot)
  const selection = useSyncExternalStore(operations.selection.subscribe, operations.selection.getSnapshot)
  if (state.bundles.length === 0 || session.removed || session.subagent !== null) return null
  const hasProblem = state.bundles.some(bundle => bundle.state === 'failed' || bundle.state === 'cancelled'
    || bundle.expected.provider !== selection.current?.provider || bundle.expected.model !== selection.current?.model)
  const status = hasProblem ? '需要处理' : state.uploads > 0 ? `${state.uploads} 组上传中` : '上传完成'
  return h('details', {
    style: { border: '1px solid var(--dsw-alias-border-l2, #8886)', borderRadius: '10px',
      padding: '8px 10px', minWidth: 0, width: '100%', boxSizing: 'border-box', fontSize: '13px', color: 'inherit' },
  },
  h('summary', { style: { cursor: 'pointer', overflowWrap: 'anywhere' } },
    `方舟媒体 · ${state.bundles.length} 组 · ${status}`),
  h('div', { style: { display: 'grid', gap: '12px', marginTop: '10px', maxHeight: 'min(40vh, 320px)', overflowY: 'auto' } },
    ...state.bundles.map(bundle => {
      const mismatch = bundle.expected.provider !== selection.current?.provider || bundle.expected.model !== selection.current?.model
      const label = bundle.state === 'uploading' ? '上传中' : bundle.state === 'ready' ? '上传完成'
        : bundle.state === 'cancelled' ? '已取消' : '上传失败'
      return h('section', { key: bundle.bundleId, 'aria-label': `方舟附件组：${bundle.label}`,
        style: { display: 'grid', gap: '6px', minWidth: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'start', gap: '8px', flexWrap: 'wrap' } },
        h('strong', { style: { flex: '1 1 160px', overflowWrap: 'anywhere' } }, bundle.label),
        h('span', { style: secondary }, label),
        bundle.state === 'uploading' ? h('button', {
          type: 'button', style: action, disabled: input.phase !== 'plain',
          'aria-label': `取消整组上传：${bundle.label}`,
          onClick: () => operations.cancelUpload(bundle.bundleId),
        }, '取消整组上传') : null),
      h('div', { style: { ...secondary, overflowWrap: 'anywhere' } }, `绑定模型：${targetLabel(bundle)}`),
      mismatch ? h('div', { role: 'alert', style: { ...secondary, color: 'var(--dsw-alias-state-warn-label, #9b6400)' } },
        '当前模型与附件不一致。请切回绑定模型；如要改用当前模型，请删除对应 Ark 引用后重新添加。') : null,
      bundle.error === undefined ? null : h('div', { role: 'alert', style: { ...secondary, overflowWrap: 'anywhere' } }, bundle.error),
      bundle.files === undefined ? h('div', { style: secondary },
        '已恢复附件引用；本次会话无法读取逐文件明细。')
        : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' } },
          ...bundle.files.map((file, index) => h('li', { key: index, style: { display: 'grid', gap: '3px', minWidth: 0 } },
            h('div', { style: { overflowWrap: 'anywhere' } }, file.name),
            h('div', { style: secondary },
              `${{ image: '图片', video: '视频', audio: '音频' }[file.modality]} · ${file.mediaType} · ${formatBytes(file.bytes)} · ${fileStatus(file, bundle)}`),
            bundle.state === 'ready' ? null : h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('progress', { max: file.bytes, value: file.uploadedBytes,
                'aria-label': `${file.name} 上传进度`, style: { flex: '1 1 100px', minWidth: 0, height: '6px' } }),
              h('span', { style: secondary }, `${formatBytes(file.uploadedBytes)} / ${formatBytes(file.bytes)}`))))),
      h('div', { style: secondary }, bundle.state === 'failed' || bundle.state === 'cancelled'
        ? '请删除输入框中对应的 Ark 引用，再重新选择这一组文件。'
        : '请将 Ark 引用保留在输入框开头；删除输入框中的该引用会移除整组。'))
    })))
}
