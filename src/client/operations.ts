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
type OperationResponse<T> = OperationResult<T> | { result: OperationResult<T> }
type CredentialDescription = Record<string, CredentialInfo> | {
  credentials: Record<string, CredentialInfo>
}

interface NamespacedRemote {
  settings: {
    describe(): Promise<OperationResponse<SettingsDescribeValue>>
    mutate(ns: string, ops: SettingsPathOpView[], revision: number): Promise<OperationResponse<SettingsNamespaceView>>
  }
  credentials: {
    describe(refs: string[]): Promise<OperationResponse<CredentialDescription>>
    set(ref: string, value: string): Promise<OperationResponse<unknown>>
    unset?(ref: string): Promise<OperationResponse<unknown>>
  }
}

interface ConnectionApi {
  settings: {
    describe(payload: Record<string, never>): Promise<OperationResponse<SettingsDescribeValue>>
    mutate(payload: {
      ns: string
      ops: SettingsPathOpView[]
      expectedRevision: number
    }): Promise<OperationResponse<SettingsNamespaceView>>
  }
  credentials: {
    describe(payload: { refs: string[] }): Promise<OperationResponse<CredentialDescription>>
    set(payload: { ref: string; value: string }): Promise<OperationResponse<unknown>>
    unset?(payload: { ref: string }): Promise<OperationResponse<unknown>>
  }
}

export interface CardOperations {
  read(): Promise<SettingsDescribeValue>
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  saveSettings(ns: string, ops: SettingsPathOpView[], revision: number): Promise<SettingsNamespaceView>
  saveCredential(ref: string, value: string): Promise<void>
  /** Optional on older Hosts; only remove a private, never-published staging ref. */
  deleteCredential?(ref: string): Promise<boolean>
}

/** A definite rejection: the Host's namespace CAS did not publish this write. */
export class SettingsConflictError extends Error {
  constructor() {
    super('配置已在其他位置更新。请重新载入后再保存。')
    this.name = 'SettingsConflictError'
  }
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

/** Prefer namespaced Remotes when complete; otherwise use the Connection API tree. */
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

function operationResult<T>(response: OperationResponse<T>): OperationResult<T> {
  const candidate = typeof response === 'object' && response !== null && 'ok' in response
    ? response
    : response.result
  if (typeof candidate !== 'object' || candidate === null || typeof candidate.ok !== 'boolean') {
    throw new Error('Harness settings transport returned an unsupported response shape.')
  }
  return candidate
}

function unwrapResponse<T>(response: OperationResponse<T>): T {
  return unwrap(operationResult(response))
}

function credentialDescription(value: CredentialDescription): Record<string, CredentialInfo> {
  const wrapped = (value as { credentials?: unknown }).credentials
  const wrappedIsOneCredential = typeof wrapped === 'object' && wrapped !== null
    && typeof (wrapped as Partial<CredentialInfo>).configured === 'boolean'
    && typeof (wrapped as Partial<CredentialInfo>).writable === 'boolean'
  if (typeof wrapped === 'object' && wrapped !== null && !wrappedIsOneCredential) {
    return wrapped as Record<string, CredentialInfo>
  }
  return value as Record<string, CredentialInfo>
}

function unwrapSettings(result: OperationResult<SettingsNamespaceView>): SettingsNamespaceView {
  if (!result.ok) {
    if (result.error.code === 'settings/conflict' || result.error.code === 'settings-conflict') {
      throw new SettingsConflictError()
    }
    throw new Error(result.error.message)
  }
  return result.value
}

/** Bind either official client transport behind one version-neutral card face. */
export function createCardOperations(ctx: Context): CardOperations {
  return {
    async read() {
      const selected = transport(ctx)
      if ('remote' in selected) return unwrapResponse(await selected.remote.settings.describe())
      return unwrapResponse(await selected.api.settings.describe({}))
    },
    async describeCredential(ref) {
      const selected = transport(ctx)
      const description = 'remote' in selected
        ? unwrapResponse(await selected.remote.credentials.describe([ref]))
        : unwrapResponse(await selected.api.credentials.describe({ refs: [ref] }))
      return credentialDescription(description)[ref]
    },
    async saveSettings(ns, ops, revision) {
      const selected = transport(ctx)
      if ('remote' in selected) {
        return unwrapSettings(operationResult(await selected.remote.settings.mutate(ns, ops, revision)))
      }
      return unwrapSettings(operationResult(await selected.api.settings.mutate({
        ns, ops, expectedRevision: revision,
      })))
    },
    async saveCredential(ref, value) {
      try {
        const selected = transport(ctx)
        const response = 'remote' in selected
          ? await selected.remote.credentials.set(ref, value)
          : await selected.api.credentials.set({ ref, value })
        if (!operationResult(response).ok) throw new Error('credential write rejected')
      } catch {
        // A credential provider or transport must not echo a submitted value
        // into the configuration page, even when it throws outside an envelope.
        throw new Error('密钥未保存，请保留当前页面并重试。')
      }
    },
    async deleteCredential(ref) {
      try {
        const selected = transport(ctx)
        const response = 'remote' in selected
          ? await selected.remote.credentials.unset?.(ref)
          : await selected.api.credentials.unset?.({ ref })
        return response !== undefined && operationResult(response).ok
      } catch {
        return false
      }
    },
  }
}
