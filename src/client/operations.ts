import type { Context } from '@deepseek-ai/cordis'

/** Stable client-side subset shared by the two published Harness wire shapes. */
export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

export interface SettingsNamespaceView {
  ns: string
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: 'live' | 'restart'
  secrets: { path: string[]; set: boolean }[]
  revision: number
}

export interface SettingsDescribeValue {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
}

export type SettingsPathOpView = {
  op: 'set'
  path: string[]
  value: unknown
} | {
  op: 'unset'
  path: string[]
}

interface OperationFailure {
  code?: string
  message: string
}

type OperationResult<T> = { ok: true; value: T } | { ok: false; error: OperationFailure }

interface NamespacedRemote {
  settings: {
    describe(): Promise<OperationResult<SettingsDescribeValue>>
    mutate(ns: string, ops: SettingsPathOpView[], revision: number): Promise<OperationResult<SettingsNamespaceView>>
  }
  credentials: {
    describe(refs: string[]): Promise<OperationResult<Record<string, CredentialInfo>>>
    set(ref: string, value: string): Promise<OperationResult<unknown>>
  }
}

interface ConnectionApi {
  settings: {
    describe(payload: Record<string, never>): Promise<{ result: OperationResult<SettingsDescribeValue> }>
    mutate(payload: {
      ns: string
      ops: SettingsPathOpView[]
      expectedRevision: number
    }): Promise<{ result: OperationResult<SettingsNamespaceView> }>
  }
  credentials: {
    describe(payload: { refs: string[] }): Promise<{
      result: OperationResult<{ credentials: Record<string, CredentialInfo> }>
    }>
    set(payload: { ref: string; value: string }): Promise<{ result: OperationResult<unknown> }>
  }
}

export interface CardOperations {
  read(): Promise<SettingsDescribeValue>
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  saveSettings(ns: string, ops: SettingsPathOpView[], revision: number): Promise<SettingsNamespaceView>
  saveCredential(ref: string, value: string): Promise<void>
}

function service(ctx: Context, name: string): unknown {
  return ctx.get(name as never)
}

function namespacedRemote(ctx: Context): NamespacedRemote | undefined {
  const remote = service(ctx, 'remote') as Partial<NamespacedRemote> | undefined
  if (typeof remote?.settings?.describe !== 'function'
    || typeof remote.settings.mutate !== 'function'
    || typeof remote.credentials?.describe !== 'function'
    || typeof remote.credentials.set !== 'function') return undefined
  return remote as NamespacedRemote
}

function connectionApi(ctx: Context): ConnectionApi | undefined {
  const connection = service(ctx, 'connection') as { api?: Partial<ConnectionApi> } | undefined
  const api = connection?.api
  if (typeof api?.settings?.describe !== 'function'
    || typeof api.settings.mutate !== 'function'
    || typeof api.credentials?.describe !== 'function'
    || typeof api.credentials.set !== 'function') return undefined
  return api as ConnectionApi
}

/** rc.1/alpha expose namespaced Remotes; rc.2 uses the Connection API tree. */
export function hasNamespacedRemote(ctx: Context): boolean {
  return namespacedRemote(ctx) !== undefined
}

function transport(ctx: Context): { remote: NamespacedRemote } | { api: ConnectionApi } {
  const remote = namespacedRemote(ctx)
  if (remote !== undefined) return { remote }
  const api = connectionApi(ctx)
  if (api !== undefined) return { api }
  throw new Error('Harness settings transport is unavailable.')
}

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function unwrapSettings(result: OperationResult<SettingsNamespaceView>): SettingsNamespaceView {
  if (!result.ok) {
    throw new Error(result.error.code === 'settings/conflict' || result.error.code === 'settings-conflict'
      ? '配置已在其他位置更新。请重新载入后再保存。'
      : result.error.message)
  }
  return result.value
}

/** Bind either official client transport behind one version-neutral card face. */
export function createCardOperations(ctx: Context): CardOperations {
  return {
    async read() {
      const selected = transport(ctx)
      if ('remote' in selected) return unwrap(await selected.remote.settings.describe())
      return unwrap((await selected.api.settings.describe({})).result)
    },
    async describeCredential(ref) {
      const selected = transport(ctx)
      if ('remote' in selected) return unwrap(await selected.remote.credentials.describe([ref]))[ref]
      return unwrap((await selected.api.credentials.describe({ refs: [ref] })).result).credentials[ref]
    },
    async saveSettings(ns, ops, revision) {
      const selected = transport(ctx)
      if ('remote' in selected) {
        return unwrapSettings(await selected.remote.settings.mutate(ns, ops, revision))
      }
      return unwrapSettings((await selected.api.settings.mutate({
        ns, ops, expectedRevision: revision,
      })).result)
    },
    async saveCredential(ref, value) {
      const selected = transport(ctx)
      const result = 'remote' in selected
        ? await selected.remote.credentials.set(ref, value)
        : (await selected.api.credentials.set({ ref, value })).result
      if (!result.ok) throw new Error('密钥未保存，请保留当前页面并重试。')
    },
  }
}
