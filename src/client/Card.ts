import { createElement as h, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { DEFAULT_ROUTES } from '../routes.js'
import type { Modality, ModalityOverride } from '../domain.js'
import type { CardOperations, SettingsNamespaceView } from './operations.js'
import {
  parseCustomBody, routeAt, routeChanges, validateModels,
} from './draft.js'
import type { DraftModelCard, DraftRouteConfig } from './draft.js'

export interface ProviderCardDescriptor {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  active?: boolean
  declared?: boolean
}

export interface VolcengineCardProps {
  provider: ProviderCardDescriptor
  operations: CardOperations
}

type Props = VolcengineCardProps
interface ModelDraft { value: DraftModelCard; body: string }

const stack: CSSProperties = { display: 'grid', gap: '12px', minWidth: 0 }
const fieldStyle: CSSProperties = { display: 'grid', gap: '6px', minWidth: 0 }
const inputStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', padding: '8px 10px', borderRadius: '6px',
  border: '1px solid var(--dsw-border-primary, currentColor)', font: 'inherit',
  color: 'inherit', background: 'var(--dsw-bg-primary, transparent)',
}
const small: CSSProperties = { margin: 0, fontSize: '12px', opacity: 0.75 }
const actionStyle: CSSProperties = { font: 'inherit', padding: '7px 12px', cursor: 'pointer' }
const modalityLabels: Record<Modality, string> = {
  text: '文本', image: '图片', video: '视频', audio: '音频',
}

function field(label: string, control: ReactNode, hint?: string): ReactNode {
  return h('label', { style: fieldStyle }, h('span', null, label), control,
    hint === undefined ? null : h('span', { style: small }, hint))
}

function textInput(label: string, value: string, change: (value: string) => void, disabled: boolean,
  extra: Record<string, unknown> = {}): ReactNode {
  return h('input', { style: inputStyle, 'aria-label': label, value, disabled,
    onChange: (event: { target: { value: string } }) => change(event.target.value), ...extra })
}

function modelDrafts(route: DraftRouteConfig): ModelDraft[] {
  return (route.models ?? []).map(value => ({
    value: structuredClone(value), body: typeof value.customBody === 'string' ? value.customBody
      : value.customBody === undefined ? '' : JSON.stringify(value.customBody, null, 2),
  }))
}

function modelValues(models: readonly ModelDraft[]): DraftModelCard[] {
  return models.map(({ value, body }) => {
    const result = { ...value, id: value.id.trim() }
    const customBody = parseCustomBody(body)
    if (customBody === undefined) delete result.customBody
    else result.customBody = body
    return result
  })
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

interface ModelEditorProps {
  model: ModelDraft
  index: number
  disabled: boolean
  update: (next: ModelDraft) => void
  remove: () => void
}

function ModelEditor({ model, index, disabled, update, remove }: ModelEditorProps): ReactNode {
  const value = model.value
  const change = (patch: Partial<DraftModelCard>): void => update({ ...model, value: { ...value, ...patch } })
  let jsonFailure: string | undefined
  try { parseCustomBody(model.body) } catch (error) { jsonFailure = failureMessage(error) }
  return h('fieldset', { disabled, style: { ...stack, margin: 0, padding: '12px', minWidth: 0,
    border: '1px solid var(--dsw-border-primary, currentColor)', borderRadius: '8px' } },
  h('legend', null, `模型 ${index + 1}`),
  field('模型 ID', textInput('模型 ID', value.id, id => change({ id }), disabled,
    { placeholder: '输入方舟模型 ID 或推理接入点 ID', required: true })),
  h('details', null,
    h('summary', { style: { cursor: 'pointer' } }, '模型高级配置'),
    h('div', { style: { ...stack, marginTop: '12px' } },
      field('模型显示名称', textInput('模型显示名称', value.name ?? '', name => change({ name: name.trim() ? name : undefined }), disabled)),
      field('上下文容量（可选）', textInput('上下文容量', value.contextWindow === undefined ? '' : String(value.contextWindow),
        text => change({ contextWindow: text === '' ? undefined : Number(text) }), disabled,
        { type: 'number', min: 1, step: 1, placeholder: '留空不声明容量' })),
      field('输出上限（可选）', textInput('输出上限', value.maxTokens === undefined ? '' : String(value.maxTokens),
        text => change({ maxTokens: text === '' ? undefined : Number(text) }), disabled,
        { type: 'number', min: 1, step: 1, placeholder: '留空使用供应商默认值' })),
      h('div', { style: stack }, h('span', null, '输入模态'),
        h('p', { style: small }, '未设置不声明模型能力，也不阻止你主动提交媒体；只有手动关闭才阻止发送。供应商反馈不会自动填写或修改。文本默认可用。'),
        ...(Object.keys(modalityLabels) as Modality[]).map(modality =>
          field(modalityLabels[modality], h('select', {
            key: modality, style: inputStyle, 'aria-label': `${modalityLabels[modality]}输入`,
            value: value.modalities?.[modality] ?? 'inherit', disabled,
            onChange: (event: { target: { value: string } }) => {
              const modalities = { ...value.modalities }
              if (event.target.value === 'inherit') delete modalities[modality]
              else modalities[modality] = event.target.value as ModalityOverride
              const next = { ...value }
              if (Object.keys(modalities).length === 0) delete next.modalities
              else next.modalities = modalities
              update({ ...model, value: next })
            },
          }, h('option', { value: 'inherit' }, modality === 'text' ? '未设置（文本默认可用）' : '未设置'),
          h('option', { value: 'force_enable' }, '强制开启'),
          h('option', { value: 'force_disable' }, '强制关闭')))),
        h('details', null,
          h('summary', { style: { cursor: 'pointer' } }, '如何发送媒体'),
          h('p', { style: small }, '可在支持原文件上传的 Harness 会话中展开“方舟原始媒体”，添加文件并手动填写 MIME 类型后发送。音频可单独填写格式。'),
          h('p', { style: small }, '也可添加附件并使用 /ark-media 命令；每个附件按顺序填写一个 MIME 类型。'),
          h('p', { style: small }, h('code', null, '/ark-media video/mp4,audio/mpeg -- 总结这两个附件')),
          h('p', { style: small }, '“方舟原始媒体”会保留图片、视频和音频的原文件，不自动压缩或转码。普通图片仍可通过聊天附件发送。'))),
      field('自定义请求体模式', h('select', {
        style: inputStyle, 'aria-label': '自定义请求体模式', value: value.customBodyMode ?? 'merge', disabled,
        onChange: (event: { target: { value: string } }) => change({ customBodyMode: event.target.value as 'merge' | 'patch' | 'raw' }),
      }, h('option', { value: 'merge' }, '合并'), h('option', { value: 'patch' }, '补丁（null 删除字段）'),
      h('option', { value: 'raw' }, '原始请求体（完整替换）'))),
      field('自定义请求体 JSON', h('textarea', {
        style: { ...inputStyle, fontFamily: 'monospace', minHeight: '120px', resize: 'vertical' },
        rows: 6, 'aria-label': '自定义请求体 JSON', 'aria-invalid': jsonFailure !== undefined,
        placeholder: '{"thinking":{"type":"enabled"}}', value: model.body, disabled,
        onChange: (event: { target: { value: string } }) => update({ ...model, body: event.target.value }),
      }), '思考模式和供应商扩展参数在这里配置；原始模式需填写完整请求。'),
      jsonFailure === undefined ? null : h('p', { role: 'alert', style: small }, jsonFailure))),
  h('button', { type: 'button', disabled, style: actionStyle, onClick: remove }, `移除模型 ${index + 1}`))
}

/** The host Models page owns the card shell; all configuration goes through its official Remotes. */
export function VolcengineCard(props: Props): ReactNode {
  const identity = JSON.stringify([props.provider.provider, props.provider.settingsNs, props.provider.settingsPath])
  // The host keys provider rows by provider id. Keep the same boundary here so
  // a route identity change remounts its draft without render-phase state.
  return h(VolcengineCardForm, { ...props, key: identity })
}

function VolcengineCardForm({ provider, operations }: Props): ReactNode {
  const [namespace, setNamespace] = useState<SettingsNamespaceView>()
  const [original, setOriginal] = useState<DraftRouteConfig>()
  const [changed, setChanged] = useState<Partial<DraftRouteConfig>>({})
  const [models, setModels] = useState<ModelDraft[]>([])
  const [key, setKey] = useState('')
  const [keyConfigured, setKeyConfigured] = useState(false)
  const [keyWritable, setKeyWritable] = useState(true)
  const [writable, setWritable] = useState(false)
  const [busy, setBusy] = useState(true)
  const [failure, setFailure] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  const mounted = useRef(false)
  const inFlight = useRef(true)
  const pathKey = JSON.stringify(provider.settingsPath)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let active = true
    inFlight.current = true
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    void operations.read().then(async description => {
      if (!active) return
      const view = description.namespaces.find(item => item.ns === provider.settingsNs)
      if (view === undefined) throw new Error('方舟配置尚未就绪，请重新载入。')
      const route = routeAt(view.value, provider.settingsPath)
      if (route === undefined) throw new Error('此供应商尚无可编辑配置。')
      const ref = route.apiKeyEnv ?? DEFAULT_ROUTES[route.kind].apiKeyEnv
      const credential = await operations.describeCredential(ref)
      if (!active) return
      setNamespace(view)
      setOriginal(route)
      setChanged({})
      setModels(modelDrafts(route))
      setKey('')
      setKeyConfigured(credential?.configured === true)
      setKeyWritable(credential?.writable !== false)
      setWritable(description.writable)
    }).catch(error => { if (active) setFailure(failureMessage(error)) })
      .finally(() => {
        if (active) { inFlight.current = false; setBusy(false) }
      })
    return () => { active = false }
  }, [operations, provider.settingsNs, pathKey, reload])

  const route = original === undefined ? undefined : { ...original, ...changed }
  const disabled = busy || !writable
  const edit = (patch: Partial<DraftRouteConfig>): void => {
    setChanged(current => ({ ...current, ...patch }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    if (inFlight.current || !mounted.current || !writable || route === undefined || namespace === undefined || original === undefined) return
    inFlight.current = true
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    let settingsCommitted = false
    let savingCredential = false
    try {
      const nextModels = modelValues(models)
      const modelFailure = validateModels(nextModels)
      if (modelFailure !== undefined) throw new Error(modelFailure)
      if (route.enabled !== false && nextModels.length === 0) throw new Error('请至少添加一个模型 ID。')
      const ref = (route.apiKeyEnv ?? DEFAULT_ROUTES[route.kind].apiKeyEnv).trim()
      if (ref.length === 0) throw new Error('请填写密钥引用名称。')
      const keyValue = key.trim()
      if (/\s/u.test(keyValue)) throw new Error('密钥中含空白字符，请检查粘贴内容。')
      const credential = await operations.describeCredential(ref)
      if (!mounted.current) return
      if (keyValue.length > 0 && credential?.writable === false) throw new Error('此密钥由运行环境提供，请在运行环境中修改。')
      if (route.enabled !== false && keyValue.length === 0 && credential?.configured !== true) {
        throw new Error('请填写 API Key，或先在运行环境中配置所选密钥引用。')
      }
      const edits = { ...changed }
      if (JSON.stringify(nextModels) !== JSON.stringify(original.models ?? [])) edits.models = nextModels
      const ops = routeChanges(provider.settingsPath, original, edits)
      if (ops.length > 0) {
        const view = await operations.saveSettings(provider.settingsNs, ops, namespace.revision)
        if (!mounted.current) return
        settingsCommitted = true
        const committed = routeAt(view.value, provider.settingsPath)
        if (committed === undefined) throw new Error('配置已保存，但暂时无法读取，请重新载入。')
        setNamespace(view)
        setOriginal(committed)
        setChanged({})
        setModels(modelDrafts(committed))
      }
      if (keyValue.length > 0) {
        savingCredential = true
        await operations.saveCredential(ref, keyValue)
        if (!mounted.current) return
      }
      setKey('')
      setKeyConfigured(keyValue.length > 0 || credential?.configured === true)
      setKeyWritable(credential?.writable !== false)
      setSaved(true)
    } catch (error) {
      if (mounted.current) setFailure(settingsCommitted && savingCredential
        ? '配置已保存，但密钥未保存。请保留当前页面并重试保存密钥。'
        : failureMessage(error))
    } finally {
      if (mounted.current) { inFlight.current = false; setBusy(false) }
    }
  }

  return h('section', { 'aria-label': `${provider.displayName}配置`, style: { ...stack, padding: '12px 0' } },
    route === undefined ? h('p', { style: small }, busy ? '正在载入方舟配置…' : '配置尚未载入。') : h('div', { style: stack },
      h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: route.enabled !== false, disabled,
          onChange: (event: { target: { checked: boolean } }) => edit({ enabled: event.target.checked }) }),
        '启用此通道'),
      field('API Key', textInput('API Key', key, value => { setKey(value); setSaved(false) }, disabled,
        { type: 'password', autoComplete: 'off', spellCheck: false,
          placeholder: keyConfigured ? '已配置；留空保留现有密钥' : '粘贴本通道的 API Key' }),
        keyWritable ? '普通 API、Agent Plan、Coding Plan 分别使用各自的密钥。' : '当前密钥由运行环境提供。'),
      h('div', { style: stack }, ...models.map((model, index) => h(ModelEditor, {
        key: index, model, index, disabled,
        update: (next: ModelDraft) => {
          setModels(current => current.map((item, offset) => offset === index ? next : item)); setSaved(false)
        },
        remove: () => { setModels(current => current.filter((_, offset) => offset !== index)); setSaved(false) },
      }))),
      h('button', { type: 'button', disabled, style: actionStyle,
        onClick: () => { setModels(current => [...current, { value: { id: '' }, body: '' }]); setSaved(false) } }, '添加模型'),
      h('details', null, h('summary', { style: { cursor: 'pointer' } }, '通道高级配置'),
        h('div', { style: { ...stack, marginTop: '12px' } },
          field('通道显示名称', textInput('通道显示名称', route.name ?? '',
            name => edit({ name: name.trim().length === 0 ? undefined : name }), disabled)),
          field('API 地址', textInput('API 地址', route.baseURL ?? DEFAULT_ROUTES[route.kind].baseUrl,
            baseURL => edit({ baseURL }), disabled, { type: 'url' })),
          field('密钥引用名称', textInput('密钥引用名称', route.apiKeyEnv ?? DEFAULT_ROUTES[route.kind].apiKeyEnv,
            apiKeyEnv => edit({ apiKeyEnv }), disabled), '运行环境变量名或 Harness 凭据存储中的引用名称。')))),
    failure === undefined ? null : h('p', { role: 'alert', style: { margin: 0 } }, failure),
    saved ? h('p', { role: 'status', style: { margin: 0 } }, '已保存，后续请求使用新配置。') : null,
    !writable && namespace !== undefined ? h('p', { style: small }, '当前设置为只读。') : null,
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { type: 'button', disabled: disabled || route === undefined, style: actionStyle,
        onClick: () => { void save() } }, busy ? '处理中…' : '保存方舟配置'),
      h('button', { type: 'button', disabled: busy, style: actionStyle,
        onClick: () => {
          if (inFlight.current) return
          inFlight.current = true
          setBusy(true)
          setReload(current => current + 1)
        } }, '重新载入（放弃未保存修改）')))
}
