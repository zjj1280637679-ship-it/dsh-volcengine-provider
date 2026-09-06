import { DEFAULT_ROUTES } from '../routes.js'
import { jsonEqual, parseCustomBody, routeAt, routeChanges, validateModels } from './draft.js'
import type { DraftModelCard, DraftRouteConfig } from './draft.js'
import { SettingsConflictError } from './operations.js'
import type { CardOperations, CredentialInfo, SettingsNamespaceView } from './operations.js'

export interface RouteSaveRequest {
  operations: CardOperations
  /** The namespace and route as this editor last loaded or successfully saved them. */
  namespace: SettingsNamespaceView
  path: readonly string[]
  original: DraftRouteConfig
  changes: Partial<DraftRouteConfig>
  models: readonly DraftModelCard[]
  /** Empty keeps an existing reference; a new key creates a private reference. */
  apiKey: string
  /** Deterministic randomness seam; production uses Web Crypto. */
  createCredentialReference?: () => string
}

export interface RouteSaveResult {
  namespace: SettingsNamespaceView
  route: DraftRouteConfig
  credential: CredentialInfo
  credentialReference: string
}

export class RouteSaveConflictError extends Error {
  constructor() {
    super('此通道已在其他位置更新，未覆盖新配置。你的修改仍保留，请重新载入后再编辑。')
    this.name = 'RouteSaveConflictError'
  }
}

export class RouteSaveUncertainError extends Error {
  constructor() {
    super('暂时无法确认保存结果。你的修改仍保留，请重新载入检查当前配置后再重试。')
    this.name = 'RouteSaveUncertainError'
  }
}

function credentialReference(route: DraftRouteConfig): string {
  return (route.apiKeyEnv ?? DEFAULT_ROUTES[route.kind].apiKeyEnv).trim()
}

function privateCredentialReference(): string {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('当前浏览器无法创建独立密钥引用，请更换浏览器后重试。')
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const random = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `DSH_VOLCENGINE_KEY_${random}`
}

function checkedModels(models: readonly DraftModelCard[]): DraftModelCard[] {
  const result = structuredClone(models).map(model => {
    const value = { ...model, id: model.id.trim() }
    if (typeof value.customBody === 'string') parseCustomBody(value.customBody)
    return value
  })
  const failure = validateModels(result)
  if (failure !== undefined) throw new Error(failure)
  return result
}

async function latestNamespace(request: RouteSaveRequest): Promise<SettingsNamespaceView> {
  const description = await request.operations.read()
  if (!description.writable) throw new Error('当前设置为只读。')
  const view = description.namespaces.find(item => item.ns === request.namespace.ns)
  if (view === undefined) throw new Error('方舟配置尚未就绪，请重新载入。')
  return view
}

function assertRouteUnchanged(request: RouteSaveRequest, view: SettingsNamespaceView): void {
  if (!jsonEqual(routeAt(view.value, request.path), request.original)) throw new RouteSaveConflictError()
}

function savedResult(
  request: RouteSaveRequest,
  namespace: SettingsNamespaceView,
  credential: CredentialInfo,
): RouteSaveResult {
  const route = routeAt(namespace.value, request.path)
  if (route === undefined) throw new RouteSaveUncertainError()
  return { namespace, route, credential, credentialReference: credentialReference(route) }
}

/**
 * Save a route without exposing a half-updated endpoint/key pair.
 *
 * A new key is stored under a never-published, random reference. A single Host
 * settings CAS then publishes the endpoint, models, and reference together.
 * Existing refs (including environment and shared refs) are never overwritten.
 * Host 0.1.2-rc.1 CredentialsController.set admits any syntactically valid ref;
 * it does not require a prior settings declaration. The older Connection face
 * exposes the same credential-reference seam.
 *
 * This transaction deliberately has no component-lifetime cancellation hook:
 * unmounting an editor must only stop UI updates, not interrupt a started save.
 */
export async function saveRouteConfiguration(request: RouteSaveRequest): Promise<RouteSaveResult> {
  const original = structuredClone(request.original)
  const changes = structuredClone(request.changes)
  const models = checkedModels(request.models)
  const draft = { ...original, ...changes, models }
  const selectedRef = credentialReference(draft)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selectedRef)) throw new Error('密钥引用名称只能包含字母、数字和下划线，且不能以数字开头。')
  if (changes.apiKeyEnv !== undefined) changes.apiKeyEnv = selectedRef
  const key = request.apiKey.trim()
  if (/\s/u.test(key)) throw new Error('密钥中含空白字符，请检查粘贴内容。')
  if (key.length > 0 && selectedRef !== credentialReference(original)) {
    throw new Error('使用手动密钥引用时请留空 API Key；填写新 API Key 会为此通道创建独立引用。')
  }
  if (draft.baseURL !== undefined) {
    let url: URL
    try { url = new URL(draft.baseURL) } catch { throw new Error('请填写有效的 HTTP(S) API 根地址。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('API 根地址必须使用 HTTP(S)，且不能包含账号、查询参数或片段。')
    }
  }
  if (!jsonEqual(models, original.models ?? [])) changes.models = models

  // Snapshot every caller-owned input before the first await. UI edits made
  // while saving cannot retarget a pending write to another route or key.
  request = { ...request, namespace: { ...request.namespace }, original, changes, models, path: [...request.path] }
  let view = await latestNamespace(request)
  assertRouteUnchanged(request, view)
  let stagedRef: string | undefined
  let credential: CredentialInfo
  if (key.length === 0) {
    credential = await request.operations.describeCredential(selectedRef) ?? { configured: false, writable: true }
    // An empty source is a valid first setup step. It advertises no models and
    // can be saved before credentials are available, without changing enabled.
    if (draft.enabled !== false && models.length > 0 && !credential.configured) {
      throw new Error('请填写 API Key，或先在运行环境中配置所选密钥引用。')
    }
  } else {
    const mint = request.createCredentialReference ?? privateCredentialReference
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = mint()
      if (!/^DSH_VOLCENGINE_KEY_[A-F0-9]{32}$/.test(candidate)) throw new Error('无法创建独立密钥引用，请重试。')
      const info = await request.operations.describeCredential(candidate)
      if (info?.configured || info?.writable === false) continue
      stagedRef = candidate
      break
    }
    if (stagedRef === undefined) throw new Error('无法创建可写的独立密钥引用，请重试。')
    try {
      await request.operations.saveCredential(stagedRef, key)
    } catch (error) {
      // No configuration publication has even been attempted at this point.
      await request.operations.deleteCredential?.(stagedRef).catch(() => false)
      throw error
    }
    credential = { configured: true, writable: true }
    changes.apiKeyEnv = stagedRef
  }

  const ops = routeChanges(request.path, original, changes)
  if (ops.length === 0) return savedResult(request, view, credential)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return savedResult(request, await request.operations.saveSettings(view.ns, ops, view.revision), credential)
    } catch (error) {
      if (!(error instanceof SettingsConflictError)) {
        // A transport failure is not proof that the CAS did not commit. A
        // private ref can identify our committed publication on a fresh read.
        // Never delete it after an ambiguous settings response: the in-flight
        // Host operation may still make it live, even if a read is stale.
        if (stagedRef !== undefined) {
          const current = await latestNamespace(request).catch(() => undefined)
          const route = current === undefined ? undefined : routeAt(current.value, request.path)
          if (route !== undefined && credentialReference(route) === stagedRef) return savedResult(request, current!, credential)
        }
        throw new RouteSaveUncertainError()
      }
      try {
        view = await latestNamespace(request)
        assertRouteUnchanged(request, view)
        if (attempt === 3) throw new Error('其他通道正在更新，暂未保存。你的修改仍保留，请重试。')
      } catch (conflict) {
        // All attempted CAS writes were definitely rejected. Only this
        // transaction's never-published ref is eligible for best-effort cleanup.
        if (stagedRef !== undefined) await request.operations.deleteCredential?.(stagedRef).catch(() => false)
        throw conflict
      }
    }
  }
  throw new RouteSaveUncertainError()
}
