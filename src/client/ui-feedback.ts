import { createElement as h, useState } from 'react'
import type { ReactNode } from 'react'

export interface UiError { readonly message: string; readonly detail?: string }

const mediaMessages: readonly [RegExp, string][] = [
  [/^Each Ark media attachment must contain at least one byte\.$/u, '文件为空，请重新选择。'],
  [/^An Ark media attachment has an invalid file name\.$/u, '文件名无效，请重命名后重新选择。'],
  [/^Ark Chat does not document this media format:/u, '暂不支持这种文件格式，请选择图片、视频或音频。'],
  [/^The (?:file extension and browser media type disagree|browser declared an unsupported media type) for /u, '文件类型与扩展名不一致，请检查文件后重新选择。'],
  [/^Select an enabled Volcengine Ark model before adding media\.$/u, '请先选择已启用的方舟模型。'],
  [/^Finish or cancel the current composer action before adding Ark media\.$/u, '请先完成或取消当前输入操作。'],
  [/^The Harness draft changed before the Ark attachment could be inserted\./u, '输入内容已改变，请重新添加附件。'],
  [/^The (?:Harness connection|selected model) changed/u, '连接或模型已改变，请移除对应附件后重新添加。'],
  [/^The same Ark media attachment cannot be submitted twice\.$/u, '附件重复，请移除重复的附件后发送。'],
  [/^An Ark media attachment reference is malformed or was moved\./u, '附件位置无效，请将附件移回输入框开头。'],
  [/^The Ark media attachment (?:reference is invalid|is no longer associated|belongs to a different)/u, '附件已失效或不属于当前模型，请重新添加。'],
  [/^The (?:media bundle is invalid|Ark media bundle was not committed)/u, '附件尚未就绪或已失效，请重新添加。'],
  [/^(?:Ark media attachments are available only|Raw Ark media attachment staging is available only)/u, '请在本机的主会话中添加附件。'],
  [/^The installed provider does not expose the native Ark media draft protocol\.$/u, '附件服务不可用，请更新插件并重启 Harness。'],
]

/** Bound untrusted diagnostics before they enter the DOM, including expanded details. */
function diagnostic(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    .replace(/\bBearer\s+[^\s"',;}]+/giu, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, '[已隐藏]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|secret|password)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/giu, '$1[已隐藏]')
    .slice(0, 2000)
}

/** Local validation stays actionable; protocol/server errors belong behind disclosure. */
export function describeUiError(error: unknown, fallback: string): UiError {
  const raw = typeof error === 'string' ? error
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : ''
  const detail = diagnostic(raw).trim()
  if (!detail) return { message: fallback }
  const translated = mediaMessages.find(([pattern]) => pattern.test(raw))?.[1]
  if (translated !== undefined) return { message: translated }
  const readable = raw.length <= 180 && /[\u3400-\u9fff]/u.test(raw)
    && !/[\r\n{}<>]|__dsh_|VOLCENGINE_|https?:\/\/|\b[A-Za-z_]\w*\s*[:=]/u.test(raw) && detail === raw.trim()
  const message = readable ? detail : fallback
  return { message, ...(message === detail ? {} : { detail: detail + (raw.length > 2000 ? '\n…详情已截短' : '') }) }
}

export function ErrorNotice({ error }: { readonly error: UiError }): ReactNode {
  const [expandedDetail, setExpandedDetail] = useState<string>()
  const expanded = error.detail !== undefined && expandedDetail === error.detail
  return h('div', { style: { display: 'grid', gap: '4px', minWidth: 0, fontSize: '12px', lineHeight: 1.5 } },
    h('p', { role: 'alert', style: { margin: 0, overflowWrap: 'anywhere' } }, error.message),
    error.detail === undefined ? null : h('details', { open: expanded },
      h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, inherit)' },
        onClick: (event: { preventDefault(): void }) => {
          event.preventDefault(); setExpandedDetail(expanded ? undefined : error.detail)
        } }, '错误详情'),
      expanded ? h('pre', { style: { margin: '6px 0 0', padding: '8px', maxHeight: '160px', overflow: 'auto',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '11px', fontFamily: 'monospace',
        borderRadius: '6px', background: 'var(--dsw-alias-interactive-bg-hover, transparent)' } }, error.detail) : null))
}
