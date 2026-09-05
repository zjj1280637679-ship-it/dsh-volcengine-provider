import { resolveMediaDeclaration } from '../media-declaration.js'
import type { MediaDeclaration } from '../media-declaration.js'

type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }
export interface MediaSelection { provider: string; model: string }
export interface MediaDirectoryState { current: MediaSelection | null; routable: boolean | null }
export interface ReadableStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface MediaDraftFile extends MediaDeclaration { readonly file: File }
export interface MediaProgress { name: string; loaded: number; total?: number }

/** Structural, documented public services; no new Harness runtime dependency. */
export interface MediaServices {
  upload: {
    readonly available: boolean
    upload(sessionId: string, data: Blob, name?: string, signal?: AbortSignal,
      onProgress?: (progress: { loaded: number; total?: number }) => void): Promise<Result<{ receiptId: string }>>
  }
  commands: {
    list(sessionId: string): Promise<Result<readonly { name: string; input?: { attachments?: boolean } }[]>>
    execute(sessionId: string, line: string, attachments: readonly { type: 'file'; receiptId: string }[],
      signal?: AbortSignal): Promise<Result<{ result: { kind: 'success' | 'error'; text?: string } } | undefined>>
  }
  llm: {
    listConfigurableProviders(): Promise<Result<readonly { provider: string; settingsNs: string }[]>>
    listProviders(): Promise<Result<readonly { id: string }[]>>
  }
  directory: { store: ReadableStore<MediaDirectoryState>; load(): Promise<unknown> }
  canAddress(): boolean
  generation(): number
}

export interface MediaOperations {
  readonly sessionId: string
  readonly selection: ReadableStore<MediaDirectoryState>
  check(signal?: AbortSignal): Promise<MediaSelection>
  send(files: readonly MediaDraftFile[], prompt: string, signal: AbortSignal,
    progress: (value: MediaProgress) => void): Promise<void>
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
function abort(signal?: AbortSignal): void { signal?.throwIfAborted() }
function same(a: MediaSelection, b: MediaSelection): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** User choices become command arguments; filenames never decide how bytes are interpreted. */
export function mediaCommandLine(files: readonly MediaDraftFile[], prompt: string): string {
  if (files.length === 0) throw new Error('请添加至少一个原始媒体文件。')
  const declarations = files.map(file => {
    const value = resolveMediaDeclaration(file)
    return value.mediaType + (value.format === undefined ? '' : `=${value.format}`)
  })
  return `/ark-media ${declarations.join(',')} -- ${prompt}`
}

/** One Session owns receipt reuse. A connection generation change invalidates old receipts. */
export function createMediaOperations(sessionId: string, services: MediaServices): MediaOperations {
  const receipts = new WeakMap<File, { generation: number; receiptId: string }>()
  const check = async (signal?: AbortSignal): Promise<MediaSelection> => {
    abort(signal)
    if (!services.upload.available || !services.canAddress()) throw new Error('当前会话不支持原文件上传。')
    await services.directory.load()
    abort(signal)
    const state = services.directory.store.getSnapshot()
    if (state.current === null || state.routable === false) throw new Error('请先选择已启用的火山方舟模型。')
    const selected = { ...state.current }
    const [declared, active, commands] = await Promise.all([
      services.llm.listConfigurableProviders(), services.llm.listProviders(),
      services.commands.list(sessionId),
    ])
    abort(signal)
    if (!unwrap(declared).some(row => row.provider === selected.provider && row.settingsNs === 'llm-volcengine')
      || !unwrap(active).some(row => row.id === selected.provider)) {
      throw new Error('请先选择已启用的火山方舟模型。')
    }
    if (!unwrap(commands).some(row => row.name === 'ark-media' && row.input?.attachments === true)) {
      throw new Error('当前 Harness 未提供原始媒体命令。')
    }
    const latest = services.directory.store.getSnapshot().current
    if (latest === null || !same(selected, latest)) throw new Error('模型已切换，请确认当前模型后重新发送。')
    return selected
  }
  return {
    sessionId, selection: services.directory.store, check,
    async send(files, prompt, signal, progress) {
      const line = mediaCommandLine(files, prompt)
      const generation = services.generation()
      const selected = await check(signal)
      const guard = (): void => {
        abort(signal)
        if (generation !== services.generation()) throw new Error('连接已更新，请重新发送以取得新的上传凭证。')
        const current = services.directory.store.getSnapshot().current
        if (current === null || !same(selected, current)) throw new Error('模型已切换，文件已保留。请确认当前模型后重新发送。')
      }
      const attachments: { type: 'file'; receiptId: string }[] = []
      for (const item of files) {
        guard()
        let receipt = receipts.get(item.file)
        if (receipt?.generation !== generation) {
          const result = await services.upload.upload(sessionId, item.file, item.file.name, signal,
            value => progress({ name: item.file.name, ...value }))
          const value = unwrap(result)
          // Cache a completed upload even when cancellation arrives immediately after it.
          receipt = { generation, receiptId: value.receiptId }
          receipts.set(item.file, receipt)
        }
        attachments.push({ type: 'file', receiptId: receipt.receiptId })
        guard()
      }
      const confirmed = await check(signal)
      if (!same(selected, confirmed)) throw new Error('模型已切换，请确认当前模型后重新发送。')
      guard()
      let result: Awaited<ReturnType<MediaServices['commands']['execute']>>
      try { result = await services.commands.execute(sessionId, line, attachments, signal) }
      catch { throw new Error('提交状态未确认，文件已保留。请先查看会话是否收到消息，再决定是否重试。') }
      const execution = unwrap(result)
      if (execution === undefined) throw new Error('原始媒体命令不可用，文件已保留。')
      if (execution.result.kind !== 'success') throw new Error(execution.result.text ?? '发送失败，文件已保留。')
    },
  }
}
