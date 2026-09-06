import { createElement as h, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import { ARK_CHAT_MEDIA_ACCEPT } from '../media-file-types.js'
import type { NativeMediaDraftOperations } from './native-media-upload.js'

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

/** One compact picker beside Harness's resident plus; native composer owns the text and send action. */
export function MediaPlus({ operations, session, input }: MediaPlusProps): ReactNode {
  const picker = useRef<HTMLInputElement>(null)
  const uploadState = useSyncExternalStore(operations.state.subscribe, operations.state.getSnapshot)
  const disabled = session.removed || session.subagent !== null || input.phase !== 'plain'
  const title = uploadState.uploads > 0 ? '方舟媒体正在上传' : '添加方舟媒体附件'
  return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
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
      'aria-label': title,
      title,
      onClick: () => picker.current?.click(),
    }, '+'))
}
