import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { MediaDraftFile, MediaOperations } from './media-operations.js'
import { mediaCommandLine } from './media-operations.js'

export interface MediaDockProps {
  operations: MediaOperations
  session: { removed: boolean; subagent: unknown | null; running: boolean }
}

const field: CSSProperties = { display: 'grid', gap: 4, minWidth: 0 }
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', font: 'inherit', padding: '6px 8px',
  color: 'inherit', background: 'var(--dsw-bg-primary, transparent)',
  border: '1px solid var(--dsw-border-primary, currentColor)', borderRadius: 6 }
const button: CSSProperties = { font: 'inherit', padding: '6px 10px', cursor: 'pointer' }

/** A separate, optional media draft; the host composer and its attachment rail keep their own state. */
export function MediaDock({ operations, session }: MediaDockProps): ReactNode {
  const selection = useSyncExternalStore(operations.selection.subscribe, operations.selection.getSnapshot)
  const [files, setFiles] = useState<MediaDraftFile[]>([])
  const [prompt, setPrompt] = useState('')
  const [ready, setReady] = useState(false)
  const [availability, setAvailability] = useState('正在检查媒体入口…')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const pending = useRef<AbortController>()
  const picker = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const addressable = !session.removed && session.subagent === null
  const provider = selection.current?.provider
  const model = selection.current?.model

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort() }
  }, [operations])
  useEffect(() => {
    const controller = new AbortController()
    setReady(false)
    if (!addressable) {
      pending.current?.abort()
      setAvailability('当前会话不支持原始媒体发送。')
      return () => controller.abort()
    }
    setAvailability('正在检查媒体入口…')
    void operations.check(controller.signal).then(() => {
      if (!controller.signal.aborted) { setReady(true); setAvailability('') }
    }).catch(error => {
      if (!controller.signal.aborted) setAvailability(error instanceof Error ? error.message : '媒体入口暂不可用。')
    })
    return () => controller.abort()
  }, [operations, provider, model, selection.routable, addressable, retry])

  let invalid = ''
  if (files.length > 0) {
    try { mediaCommandLine(files, prompt) } catch (error) { invalid = error instanceof Error ? error.message : '请检查媒体类型。' }
  }
  const send = async (): Promise<void> => {
    if (pending.current !== undefined || !ready || invalid !== '' || files.length === 0) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setNotice('正在上传原始文件…')
    try {
      await operations.send(files, prompt, controller.signal, progress => {
        if (mounted.current && !controller.signal.aborted) {
          setNotice(`正在上传 ${progress.name}：${progress.loaded}${progress.total === undefined ? '' : ` / ${progress.total}`} 字节`)
        }
      })
      if (!mounted.current) return
      setFiles([])
      setPrompt('')
      setNotice('媒体消息已送入当前会话。')
    } catch (error) {
      if (!mounted.current) return
      setNotice(error instanceof Error && error.name !== 'AbortError'
        ? error.message : '上传已取消，文件和填写内容已保留。')
    } finally {
      if (pending.current === controller) pending.current = undefined
      if (mounted.current) setBusy(false)
    }
  }
  const update = (index: number, patch: Partial<MediaDraftFile>): void => {
    setFiles(current => current.map((value, item) => item === index ? { ...value, ...patch } : value))
  }

  return h('details', { style: { margin: '8px 0', fontSize: 13 }, 'aria-label': '火山方舟原始媒体' },
    h('summary', { style: { cursor: 'pointer' } }, '方舟原始媒体'),
    h('div', { style: { display: 'grid', gap: 10, padding: '10px 0' } },
      h('p', { style: { margin: 0 } }, '图片、音频和视频按原文件上传。请确认每个文件的 MIME 类型，并在模型配置中开启相应输入。'),
      h('p', { style: { margin: 0 } }, selection.current === null ? '尚未选择模型。' : `当前模型：${provider} / ${model}`),
      h('input', { ref: picker, type: 'file', multiple: true, hidden: true, 'aria-label': '选择原始媒体文件', disabled: busy || !ready,
        onChange: (event: { target: HTMLInputElement }) => {
          const selected = Array.from(event.target.files ?? [])
          setFiles(current => [...current, ...selected.map(file => ({ file,
            mediaType: /^(image|audio|video)\//iu.test(file.type) ? file.type : '' }))])
          event.target.value = ''
          setNotice('')
        } }),
      h('button', { type: 'button', style: button, disabled: busy || !ready, onClick: () => picker.current?.click() }, '添加原始媒体'),
      ...files.map((item, index) => h('fieldset', { key: index, disabled: busy,
        style: { display: 'grid', gap: 8, minWidth: 0, margin: 0, border: '1px solid var(--dsw-border-primary, currentColor)', borderRadius: 6 } },
      h('legend', null, `${index + 1}. ${item.file.name}（${item.file.size} 字节）`),
      h('label', { style: field }, 'MIME 类型', h('input', { style: input, 'aria-label': `文件 ${index + 1} MIME 类型`, value: item.mediaType,
        placeholder: '例如 image/png、audio/mpeg、video/mp4',
        onChange: (event: { target: { value: string } }) => update(index, { mediaType: event.target.value,
          .../^audio\//iu.test(event.target.value) ? {} : { format: undefined } }) })),
      /^audio\//iu.test(item.mediaType) ? h('label', { style: field }, '音频格式（可选）', h('input', {
        style: input, 'aria-label': `文件 ${index + 1} 音频格式`, value: item.format ?? '', placeholder: '留空从 MIME 类型声明',
        onChange: (event: { target: { value: string } }) => update(index, { format: event.target.value || undefined }),
      })) : null,
      h('button', { type: 'button', style: button,
        onClick: () => setFiles(current => current.filter((_value, itemIndex) => itemIndex !== index)) }, `移除文件 ${index + 1}`))),
      h('label', { style: field }, '关于这些媒体的问题', h('textarea', { style: input, rows: 3, value: prompt,
        disabled: busy, 'aria-label': '媒体问题', onChange: (event: { target: { value: string } }) => setPrompt(event.target.value) })),
      availability === '' ? null : h('p', { role: 'status', style: { margin: 0 } }, availability,
        h('button', { type: 'button', style: button, disabled: busy || !addressable, onClick: () => setRetry(value => value + 1) }, '重新检查')),
      invalid === '' ? null : h('p', { role: 'alert', style: { margin: 0 } }, invalid),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        h('button', { type: 'button', style: button, disabled: busy || !ready || invalid !== '' || files.length === 0,
          onClick: () => { void send() } }, session.running ? '发送媒体并插入当前任务' : '发送媒体'),
        busy ? h('button', { type: 'button', style: button, onClick: () => pending.current?.abort() }, '取消') : null),
      notice === '' ? null : h('p', { role: 'status', style: { margin: 0 } }, notice)))
}
