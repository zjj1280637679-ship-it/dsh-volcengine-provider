import { createElement as h, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { DEFAULT_ROUTES } from '../routes.js'
import { DEFAULT_AGENT_MEDIA_FALLBACK_MB, type Modality, type ModalityOverride } from '../domain.js'
import type { CardOperations, SettingsNamespaceView } from './operations.js'
import {
  parseCustomBody, routeAt, routeChanges, validateModels,
} from './draft.js'
import type { DraftModelCard, DraftRouteConfig } from './draft.js'
import { saveRouteConfiguration } from './route-save.js'

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
  showHeader?: boolean
}

type Props = VolcengineCardProps
interface ModelDraft { draftId: number; value: DraftModelCard; body: string }

const stack: CSSProperties = { display: 'grid', gap: '16px', minWidth: 0 }
const fieldStyle: CSSProperties = { display: 'grid', gap: '6px', minWidth: 0 }
const inputStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minWidth: 0, padding: '9px 11px', borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l3, #cbd5e1)', font: 'inherit',
  color: 'inherit', background: 'var(--dsw-alias-bg-layer-1, Canvas)',
}
const small: CSSProperties = { margin: 0, fontSize: '12px', lineHeight: 1.55,
  color: 'var(--dsw-alias-label-secondary, inherit)' }
const actionStyle: CSSProperties = { font: 'inherit', padding: '8px 12px', cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l3, #cbd5e1)', borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-1, Canvas)', color: 'inherit' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: '12px', flexWrap: 'wrap', minWidth: 0 }
const badgeStyle: CSSProperties = { ...small, padding: '3px 8px', borderRadius: '6px',
  background: 'var(--dsw-alias-interactive-bg-hover, transparent)', whiteSpace: 'nowrap' }
const cardStyles = `
.ark-provider-card { color: var(--dsw-alias-label-primary, CanvasText); }
.ark-provider-card button:disabled, .ark-provider-card input:disabled,
.ark-provider-card select:disabled, .ark-provider-card textarea:disabled { opacity: .55; cursor: not-allowed; }
.ark-provider-card button:focus-visible, .ark-provider-card summary:focus-visible,
.ark-provider-card input:focus-visible, .ark-provider-card select:focus-visible,
.ark-provider-card textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #6366f1); outline-offset: 2px; }
.ark-model-summary { display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; list-style: none; }
.ark-model-summary::-webkit-details-marker { display: none; }
.ark-model-summary::after { content: '›'; font-size: 22px; flex: 0 0 auto; }
.ark-model-row[open] > .ark-model-summary::after { transform: rotate(90deg); }
.ark-model-summary:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.ark-model-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 12px; }
`
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

function modelDrafts(route: DraftRouteConfig, nextId: () => number): ModelDraft[] {
  return (route.models ?? []).map(value => ({
    draftId: nextId(), value: structuredClone(value), body: typeof value.customBody === 'string' ? value.customBody
      : value.customBody === undefined ? '' : JSON.stringify(value.customBody, null, 2),
  }))
}

function modelSignature(models: readonly ModelDraft[]): string {
  return JSON.stringify(models.map(({ value, body }) => ({ value, body })))
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
  const [expanded, setExpanded] = useState(value.id.length === 0)
  const change = (patch: Partial<DraftModelCard>): void => update({ ...model, value: { ...value, ...patch } })
  let jsonFailure: string | undefined
  try { parseCustomBody(model.body) } catch (error) { jsonFailure = failureMessage(error) }
  const overrides = (Object.keys(modalityLabels) as Modality[]).flatMap(modality => {
    const override = value.modalities?.[modality]
    return override === 'force_enable' || override === 'force_disable'
      ? [`${modalityLabels[modality]}：${override === 'force_enable' ? '强制开启' : '强制关闭'}`] : []
  })
  return h('details', { className: 'ark-model-row', open: expanded,
    style: { border: '1px solid var(--dsw-alias-border-l2, #cbd5e1)', borderRadius: '10px', overflow: 'hidden', minWidth: 0 } },
  h('summary', { className: 'ark-model-summary', 'aria-label': `编辑模型 ${value.id || index + 1}`,
    onClick: (event: { preventDefault(): void }) => { event.preventDefault(); setExpanded(current => !current) } },
    h('span', { style: { display: 'grid', gap: '4px', flex: '1 1 auto', minWidth: 0 } },
      h('span', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, value.name?.trim() || value.id || '新模型'),
      value.name?.trim() ? h('span', { style: { ...small, fontFamily: 'monospace', overflowWrap: 'anywhere' } }, value.id || '请填写模型 ID') : null,
      h('span', { style: small }, overrides.length === 0 ? '输入模态未设置' : overrides.join(' · '))),
    jsonFailure === undefined ? null : h('span', { style: { ...badgeStyle,
      color: 'var(--dsw-alias-state-error-primary, #b91c1c)' } }, 'JSON 待修正')),
  h('fieldset', { disabled, style: { ...stack, margin: 0, padding: '14px', minWidth: 0, border: 0,
    borderTop: '1px solid var(--dsw-alias-border-l2, #cbd5e1)' }, 'aria-label': `模型 ${index + 1}配置` },
  field('模型 ID', textInput('模型 ID', value.id, id => change({ id }), disabled,
    { placeholder: '输入方舟模型 ID 或推理接入点 ID', required: true })),
  h('details', null,
    h('summary', { style: { cursor: 'pointer' } }, '模型高级配置'),
    h('div', { style: { ...stack, marginTop: '12px' } },
      field('模型显示名称', textInput('模型显示名称', value.name ?? '', name => change({ name: name.trim() ? name : undefined }), disabled)),
      h('div', { className: 'ark-model-fields' }, field('上下文容量（可选）', textInput('上下文容量', value.contextWindow === undefined ? '' : String(value.contextWindow),
        text => change({ contextWindow: text === '' ? undefined : Number(text) }), disabled,
        { type: 'number', min: 1, step: 1, placeholder: '留空不声明容量' })),
      field('输出上限（可选）', textInput('输出上限', value.maxTokens === undefined ? '' : String(value.maxTokens),
        text => change({ maxTokens: text === '' ? undefined : Number(text) }), disabled,
        { type: 'number', min: 1, step: 1, placeholder: '留空使用供应商默认值' }))),
      field('智能体媒体续链预算（十进制 MB）', textInput(
        '智能体媒体续链预算',
        String(value.agentMediaFallbackMB ?? DEFAULT_AGENT_MEDIA_FALLBACK_MB),
        text => change({ agentMediaFallbackMB: text === '' ? undefined : Number(text) }),
        disabled,
        { type: 'number', min: 0, step: 'any' },
      ), '仅作用于 tool-result 中的图片和视频。超额媒体只从本次模型请求省略，不删除原文件；AI 会收到诊断并自行决定下一步。0 表示关闭此降级。1 MB = 1,000,000 字节。'),
      h('div', { style: stack }, h('span', null, '输入模态'),
        h('p', { style: small }, '未设置不声明模型能力，也不阻止你主动提交媒体；只有手动关闭才阻止发送。供应商反馈不会自动填写或修改。文本默认可用。'),
        h('div', { className: 'ark-model-fields' }, ...(Object.keys(modalityLabels) as Modality[]).map(modality =>
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
          h('option', { value: 'force_disable' }, '强制关闭'))))),
      ),
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
  h('button', { type: 'button', disabled, style: { ...actionStyle, justifySelf: 'start' },
    onClick: remove, 'aria-label': `移除模型 ${value.id || index + 1}` }, `移除模型 ${index + 1}`)))
}

/** The host Models page owns the card shell; all configuration goes through its official Remotes. */
export function VolcengineCard(props: Props): ReactNode {
  const identity = JSON.stringify([props.provider.provider, props.provider.settingsNs, props.provider.settingsPath])
  // The host keys provider rows by provider id. Keep the same boundary here so
  // a route identity change remounts its draft without render-phase state.
  return h(VolcengineCardForm, { ...props, key: identity })
}

function VolcengineCardForm({ provider, operations, showHeader = false }: Props): ReactNode {
  const [namespace, setNamespace] = useState<SettingsNamespaceView>()
  const [original, setOriginal] = useState<DraftRouteConfig>()
  const [changed, setChanged] = useState<Partial<DraftRouteConfig>>({})
  const [models, setModels] = useState<ModelDraft[]>([])
  const [originalModelSignature, setOriginalModelSignature] = useState('[]')
  const [search, setSearch] = useState('')
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
  const draftSerial = useRef(0)
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
      const drafts = modelDrafts(route, () => draftSerial.current++)
      setModels(drafts)
      setOriginalModelSignature(modelSignature(drafts))
      setSearch('')
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
  const dirty = key.length > 0 || routeChanges(provider.settingsPath, original, changed).length > 0
    || modelSignature(models) !== originalModelSignature
  const query = search.trim().toLocaleLowerCase()
  const visibleModels = models.map((model, index) => ({ model, index })).filter(({ model }) =>
    query.length === 0 || `${model.value.id} ${model.value.name ?? ''}`.toLocaleLowerCase().includes(query))
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
    try {
      const nextModels = modelValues(models)
      const modelFailure = validateModels(nextModels)
      if (modelFailure !== undefined) throw new Error(modelFailure)
      // A click owns the whole transaction. Leaving this card only detaches its
      // UI; it must not interrupt credential staging or settings publication.
      const result = await saveRouteConfiguration({
        operations, namespace, path: provider.settingsPath, original,
        changes: changed, models: nextModels, apiKey: key,
      })
      if (!mounted.current) return
      setNamespace(result.namespace)
      setOriginal(result.route)
      setChanged({})
      const drafts = modelDrafts(result.route, () => draftSerial.current++)
      setModels(drafts)
      setOriginalModelSignature(modelSignature(drafts))
      setKey('')
      setKeyConfigured(result.credential?.configured === true)
      setKeyWritable(result.credential?.writable !== false)
      setSaved(true)
    } catch (error) {
      if (mounted.current) setFailure(failureMessage(error))
    } finally {
      if (mounted.current) { inFlight.current = false; setBusy(false) }
    }
  }

  return h('section', { className: 'ark-provider-card', 'aria-label': `${provider.displayName}配置`,
    'aria-busy': busy, style: { ...stack, padding: showHeader ? '18px' : '12px 0',
      ...(showHeader ? { border: '1px solid var(--dsw-alias-border-l2, #cbd5e1)', borderRadius: '14px',
        background: 'var(--dsw-alias-bg-module-platform, Canvas)' } : {}) } },
    h('style', null, cardStyles),
    h('header', { style: rowStyle },
      h('div', { style: { display: 'grid', gap: '5px', minWidth: 0, flex: '1 1 200px' } },
        showHeader ? h('h3', { style: { fontSize: '16px', lineHeight: 1.4, margin: 0 } }, route?.name?.trim() || provider.displayName) : null,
        route === undefined ? null : h('p', { style: { ...small, fontFamily: 'monospace', overflowWrap: 'anywhere' } },
          route.baseURL ?? DEFAULT_ROUTES[route.kind].baseUrl)),
      route === undefined ? null : h('span', { style: badgeStyle },
        route.enabled === false ? '通道已停用' : keyConfigured ? '密钥已配置' : '待配置密钥')),
    route === undefined ? h('p', { style: small }, busy ? '正在载入方舟配置…' : '配置尚未载入。') : h('div', { style: stack },
      h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: route.enabled !== false, disabled,
          onChange: (event: { target: { checked: boolean } }) => edit({ enabled: event.target.checked }) }),
        '启用此通道'),
      field('API Key', textInput('API Key', key, value => { setKey(value); setSaved(false) }, disabled,
        { type: 'password', autoComplete: 'off', spellCheck: false,
          placeholder: keyConfigured ? '已配置；留空保留现有密钥' : '粘贴本通道的 API Key' }),
        keyWritable ? '填写新密钥会为此通道创建独立凭据引用；留空保留现有密钥。'
          : '当前密钥由运行环境提供；填写新密钥会为此通道创建独立凭据引用。'),
      h('details', null, h('summary', { style: { cursor: 'pointer' } }, '通道高级配置'),
        h('div', { style: { ...stack, marginTop: '12px' } },
          field('通道显示名称', textInput('通道显示名称', route.name ?? '',
            name => edit({ name: name.trim().length === 0 ? undefined : name }), disabled)),
          field('API 地址', textInput('API 地址', route.baseURL ?? DEFAULT_ROUTES[route.kind].baseUrl,
            baseURL => edit({ baseURL }), disabled, { type: 'url' })),
          field('密钥引用名称', textInput('密钥引用名称', route.apiKeyEnv ?? DEFAULT_ROUTES[route.kind].apiKeyEnv,
            apiKeyEnv => edit({ apiKeyEnv }), disabled), '使用已有环境变量或凭据引用时，请留空 API Key。新密钥将创建独立引用，不能同时指定另一个引用。'))),
      h('div', { style: { ...stack, borderTop: '1px solid var(--dsw-alias-border-l2, #cbd5e1)', paddingTop: '16px' } },
        h('div', { style: rowStyle },
          h('h4', { style: { margin: 0, fontSize: '14px' } }, '模型 ', h('span', { style: badgeStyle }, String(models.length))),
          h('button', { type: 'button', disabled, style: actionStyle,
            onClick: () => {
              setModels(current => [...current, { draftId: draftSerial.current++, value: { id: '' }, body: '' }])
              setSearch(''); setSaved(false)
            } }, '添加模型')),
        models.length > 4 || search.length > 0 ? textInput('搜索模型', search, setSearch, disabled,
          { type: 'search', placeholder: '搜索模型 ID 或显示名称' }) : null,
        models.length === 0 ? h('p', { style: { ...small, padding: '14px',
          border: '1px dashed var(--dsw-alias-border-l3, #cbd5e1)', borderRadius: '10px' } },
        '尚未添加模型。点击“添加模型”，填写模型 ID 即可开始。') : null,
        models.length > 0 && visibleModels.length === 0 ? h('p', { style: small }, '没有匹配的模型，请换个关键词。') : null,
        h('div', { style: { display: 'grid', gap: '8px', minWidth: 0 } }, ...visibleModels.map(({ model, index }) => h(ModelEditor, {
          key: model.draftId, model, index, disabled,
          update: (next: ModelDraft) => {
            setModels(current => current.map(item => item.draftId === model.draftId ? next : item)); setSaved(false)
          },
          remove: () => { setModels(current => current.filter(item => item.draftId !== model.draftId)); setSaved(false) },
        }))))),
    failure === undefined ? null : h('p', { role: 'alert', style: { margin: 0 } }, failure),
    saved ? h('p', { role: 'status', style: { margin: 0 } }, '已保存，后续请求使用新配置。') : null,
    !saved && dirty ? h('p', { style: { ...small, color: 'var(--dsw-alias-state-warn-label, inherit)' } }, '有未保存修改') : null,
    !writable && namespace !== undefined ? h('p', { style: small }, '当前设置为只读。') : null,
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '4px' } },
      h('button', { type: 'button', disabled: disabled || route === undefined || !dirty,
        style: { ...actionStyle, background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
          color: 'var(--dsw-alias-label-primary-foreground, #fff)', borderColor: 'transparent' },
        onClick: () => { void save() } }, busy ? '处理中…' : '保存方舟配置'),
      h('button', { type: 'button', disabled: busy, style: actionStyle,
        onClick: () => {
          if (inFlight.current) return
          inFlight.current = true
          setBusy(true)
          setReload(current => current + 1)
        } }, '重新载入（放弃未保存修改）')))
}
