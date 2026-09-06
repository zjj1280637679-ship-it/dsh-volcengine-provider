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
const addButton: CSSProperties = { ...button, width: 32, height: 32, padding: 0, borderRadius: '50%',
  fontSize: 22, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', justifySelf: 'start' }

/** A separate, optional media draft; the host composer and its attachment rail keep their own state. */
export function MediaDock({ operations, session }: MediaDockProps): ReactNode {
  const selection = useSyncExternalStore(operations.selection.subscribe, operations.selection.getSnapshot)
  const generation = useSyncExternalStore(operations.generation.subscribe, operations.generation.getSnapshot)
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
  const loopbackVideo = operations.mode === 'loopback-video'

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort() }
  }, [operations])
  useEffect(() => {
    pending.current?.abort()
  }, [operations, provider, model, selection.routable, addressable, generation])
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
  }, [operations, provider, model, selection.routable, addressable, generation, retry])

  let invalid = ''
  if (files.length > 0) {
    try {
      if (operations.validate !== undefined) operations.validate(files, prompt)
      else mediaCommandLine(files, prompt)
    } catch (error) { invalid = error instanceof Error ? error.message : '请检查媒体类型。' }
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
  const addLabel = loopbackVideo ? '选择原始 MP4' : '添加原始媒体'

  return h('details', { open: true, style: { margin: '8px 0', fontSize: 13 }, 'aria-label': '火山方舟原始媒体' },
    h('summary', { style: { cursor: 'pointer' } }, '方舟原始媒体'),
    h('div', { style: { display: 'grid', gap: 10, padding: '10px 0' } },
      h('p', { style: { margin: 0 } }, loopbackVideo
        ? '本机兼容入口：一次选择一个原始 MP4；不抽帧、不转码、不修改字节。MIME 必须由用户明确填写为 video/mp4。'
        : '图片、音频和视频按原文件上传。请手动填写每个文件的 MIME 类型；插件不会自动填写或修改模型模态。'),
      h('p', { style: { margin: 0 } }, selection.current === null ? '尚未选择模型。' : `当前模型：${provider} / ${model}`),
      loopbackVideo ? h('p', { style: { margin: 0, fontSize: 12, opacity: 0.8 } },
        '用户主动上传不受插件文件大小阈值阻断；若超过当前方舟 API 或模型条件，界面保留真实 API 错误。 ',
        h('a', { href: 'https://www.volcengine.com/docs/82379/1895586?lang=zh', target: '_blank', rel: 'noreferrer' }, '官方视频理解文档')) : null,
      h('input', { ref: picker, type: 'file', multiple: !loopbackVideo, accept: loopbackVideo ? 'video/mp4' : undefined,
        hidden: true, 'aria-label': loopbackVideo ? '选择原始 MP4 文件' : '选择原始媒体文件', disabled: busy || !ready,
        onChange: (event: { target: HTMLInputElement }) => {
          const selected = Array.from(event.target.files ?? [])
          const additions = selected.map(file => ({ file,
            // Browser-provided File.type is advice, not a user declaration.
            // Keep this blank so the plugin never auto-fills media input.
            mediaType: '' }))
          setFiles(current => loopbackVideo ? additions.slice(0, 1) : [...current, ...additions])
          event.target.value = ''
          setNotice('')
        } }),
      h('button', { type: 'button', style: addButton, disabled: busy || !ready, 'aria-label': addLabel,
        title: addLabel, onClick: () => picker.current?.click() }, '+'),
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
