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
  directory: { store: ReadableStore<MediaDirectoryState>; load(): Promise<unknown> }
  canAddress(): boolean
  generation: ReadableStore<number>
}

export interface MediaOperations {
  readonly sessionId: string
  /** Host attachment flow, or the loopback-only raw MP4 compatibility flow. */
  readonly mode?: 'host-media' | 'loopback-video'
  readonly maxFiles?: number
  readonly selection: ReadableStore<MediaDirectoryState>
  readonly generation: ReadableStore<number>
  validate?(files: readonly MediaDraftFile[], prompt: string): void
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

/**
 * Provider ids are created by config.providerId(). This is only a client-side
 * availability hint; the command handler rechecks live plugin ownership at the
 * delivery boundary, so a colliding id cannot cross the server trust boundary.
 */
function selectedVolcengineModel(selection: MediaSelection): boolean {
  return selection.provider.startsWith('volcengine-') && selection.model.length > 0
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
    if (!selectedVolcengineModel(selected)) throw new Error('请先选择已启用的火山方舟模型。')
    const commands = await services.commands.list(sessionId)
    abort(signal)
    if (!unwrap(commands).some(row => row.name === 'ark-media' && row.input?.attachments === true)) {
      throw new Error('当前 Harness 未提供原始媒体命令。')
    }
    const latest = services.directory.store.getSnapshot().current
    if (latest === null || !same(selected, latest)) throw new Error('模型已切换，请确认当前模型后重新发送。')
    return selected
  }
  return {
    sessionId, mode: 'host-media', selection: services.directory.store, generation: services.generation, check,
    async send(files, prompt, signal, progress) {
      const line = mediaCommandLine(files, prompt)
      const generation = services.generation.getSnapshot()
      const initial = services.directory.store.getSnapshot().current
      const controller = new AbortController()
      const cancel = (message: string): void => {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException(message, 'AbortError'))
        }
      }
      const relayAbort = (): void => { controller.abort(signal.reason) }
      if (signal.aborted) relayAbort()
      else signal.addEventListener('abort', relayAbort, { once: true })
      const invalidate = (): void => {
        const state = services.directory.store.getSnapshot()
        if (generation !== services.generation.getSnapshot()) {
          cancel('连接已更新，请重新发送以取得新的上传凭证。')
        } else if (!services.canAddress()) {
          cancel('当前会话不再支持原始媒体发送。')
        } else if (initial === null || state.current === null || !same(initial, state.current)) {
          cancel('模型已切换，文件已保留。请确认当前模型后重新发送。')
        } else if (state.routable === false) {
          cancel('当前火山方舟模型已不可用，请重新选择后发送。')
        }
      }
      const stopSelection = services.directory.store.subscribe(invalidate)
      const stopGeneration = services.generation.subscribe(invalidate)
      try {
        invalidate()
        abort(controller.signal)
        const selected = await check(controller.signal)
        if (initial === null || !same(initial, selected)) {
          cancel('模型已切换，文件已保留。请确认当前模型后重新发送。')
        }
        const guard = (): void => {
          invalidate()
          abort(controller.signal)
        }
        const attachments: { type: 'file'; receiptId: string }[] = []
        for (const item of files) {
          guard()
          let receipt = receipts.get(item.file)
          if (receipt?.generation !== generation) {
            const result = await services.upload.upload(sessionId, item.file, item.file.name, controller.signal,
              value => progress({ name: item.file.name, ...value }))
            const value = unwrap(result)
            // Cache a completed upload even when cancellation arrives immediately after it.
            receipt = { generation, receiptId: value.receiptId }
            receipts.set(item.file, receipt)
          }
          attachments.push({ type: 'file', receiptId: receipt.receiptId })
          guard()
        }
        const confirmed = await check(controller.signal)
        if (!same(selected, confirmed)) {
          cancel('模型已切换，文件已保留。请确认当前模型后重新发送。')
        }
        guard()
        let execution: Awaited<ReturnType<MediaServices['commands']['execute']>> extends Result<infer T> ? T : never
        try {
          const result = await services.commands.execute(sessionId, line, attachments, controller.signal)
          execution = unwrap(result)
        }
        catch (error) {
          throw new Error('提交状态未确认，文件已保留。请先查看会话是否收到消息，再决定是否重试。', { cause: error })
        }
        // Once execute() starts, the host may have synchronously accepted the
        // command even if its RPC response is later aborted. A returned result
        // is authoritative; an exception is deliberately reported as unknown
        // above so the UI never calls a possibly delivered command "cancelled".
        if (execution === undefined) throw new Error('原始媒体命令不可用，文件已保留。')
        if (execution.result.kind !== 'success') throw new Error(execution.result.text ?? '发送失败，文件已保留。')
      } finally {
        signal.removeEventListener('abort', relayAbort)
        stopSelection()
        stopGeneration()
      }
    },
  }
}
