import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveConfig, type Config } from '../../src/config.js'
import { ConfiguredVolcengineAdapter } from '../../src/configured-adapter.js'
import { routeAt } from '../../src/client/draft.js'
import { SettingsConflictError } from '../../src/client/operations.js'
import type { CardOperations, SettingsNamespaceView, SettingsPathOpView } from '../../src/client/operations.js'
import { RouteSaveConflictError, RouteSaveUncertainError, saveRouteConfiguration } from '../../src/client/route-save.js'
import type { RouteSaveRequest } from '../../src/client/route-save.js'

afterEach(() => vi.unstubAllGlobals())

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const FIRST_REF = `DSH_VOLCENGINE_KEY_${'A'.repeat(32)}`
const SECOND_REF = `DSH_VOLCENGINE_KEY_${'B'.repeat(32)}`

function fixture() {
  let view: SettingsNamespaceView = {
    ns: 'llm-volcengine', schema: {}, revision: 7, applies: 'live', secrets: [],
    value: { futureNamespace: 'keep', routes: {
      standard: {
        kind: 'standard', enabled: true, baseURL: 'https://old.invalid/v3', apiKeyEnv: 'OLD_REF',
        futureRoute: { keep: true }, models: [{ id: 'manual-model', futureModel: { keep: true } }],
      },
      coding: { kind: 'coding-plan', apiKeyEnv: 'CODING_REF', models: [{ id: 'coding-model' }] },
    } },
  }
  const keys = new Map([['OLD_REF', 'fake-old-key'], ['CODING_REF', 'fake-coding-key'], ['ENV_REF', 'fake-env-key']])
  const read = vi.fn(async () => ({ writable: true, hasDocument: true, namespaces: [structuredClone(view)] }))
  const saveSettings = vi.fn(async (_ns: string, ops: SettingsPathOpView[], revision: number) => {
    if (revision !== view.revision) throw new SettingsConflictError()
    const value = structuredClone(view.value) as Record<string, unknown>
    for (const op of ops) {
      let target = value
      for (const key of op.path.slice(0, -1)) target = target[key] as Record<string, unknown>
      const key = op.path.at(-1)!
      if (op.op === 'unset') delete target[key]
      else target[key] = structuredClone(op.value)
    }
    view = { ...view, revision: view.revision + 1, value }
    return structuredClone(view)
  })
  const saveCredential = vi.fn(async (ref: string, value: string) => { keys.set(ref, value) })
  const deleteCredential = vi.fn(async (ref: string) => keys.delete(ref))
  const operations: CardOperations = {
    read, saveSettings, saveCredential, deleteCredential,
    describeCredential: vi.fn(async ref => ({ configured: keys.has(ref), writable: ref !== 'ENV_REF' })),
  }
  function request(route = 'standard'): RouteSaveRequest {
    const namespace = structuredClone(view)
    const path = ['routes', route]
    const original = routeAt(namespace.value, path)!
    return { operations, namespace, path, original, changes: {}, models: structuredClone(original.models ?? []), apiKey: '', createCredentialReference: () => FIRST_REF }
  }
  return { operations, keys, read, saveSettings, saveCredential, deleteCredential, request, view: () => view }
}

describe('route saves publish one configuration and credential generation', () => {
  it('keeps real runtime requests on the old endpoint/key until one CAS publishes the complete replacement', async () => {
    const test = fixture()
    const stageEntered = deferred()
    const stageRelease = deferred()
    const publishEntered = deferred()
    const publishRelease = deferred()
    const storeKey = test.saveCredential.getMockImplementation()!
    const publish = test.saveSettings.getMockImplementation()!
    test.saveCredential.mockImplementation(async (...args) => { stageEntered.resolve(); await stageRelease.promise; await storeKey(...args) })
    test.saveSettings.mockImplementation(async (...args) => { publishEntered.resolve(); await publishRelease.promise; return publish(...args) })
    const sent: Array<{ url: string; authorization: string | null }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), authorization: new Headers(init.headers).get('authorization') })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fake reply' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    })
    const adapter = new ConfiguredVolcengineAdapter({
      route: () => resolveConfig(test.view().value as Config).routes.standard!,
      resolveKey: async ref => test.keys.get(ref)!,
      resolveMediaBytes: async () => new Uint8Array(),
    })
    const send = async () => { for await (const _chunk of adapter.stream({ provider: 'volcengine-standard', model: 'manual-model', messages: [] })) { /* consume */ } }
    const saving = saveRouteConfiguration({ ...test.request(), changes: { baseURL: 'https://new.invalid/v3' }, apiKey: 'fake-new-key' })
    await stageEntered.promise
    await send()
    stageRelease.resolve()
    await publishEntered.promise
    await send()
    publishRelease.resolve()
    const result = await saving
    await send()
    expect(sent).toEqual([
      { url: 'https://old.invalid/v3/chat/completions', authorization: 'Bearer fake-old-key' },
      { url: 'https://old.invalid/v3/chat/completions', authorization: 'Bearer fake-old-key' },
      { url: 'https://new.invalid/v3/chat/completions', authorization: 'Bearer fake-new-key' },
    ])
    expect(result.credentialReference).toBe(FIRST_REF)
    expect(test.keys.get('OLD_REF')).toBe('fake-old-key')
    expect(result.namespace.value).toMatchObject({ futureNamespace: 'keep', routes: { standard: {
      futureRoute: { keep: true }, models: [{ futureModel: { keep: true } }],
    } } })
  })

  it('rejects a stale key-only editor before writing either an old or a new ref', async () => {
    const test = fixture()
    const request = { ...test.request(), apiKey: 'fake-new-key' }
    await test.saveSettings(request.namespace.ns, [{ op: 'set', path: [...request.path, 'apiKeyEnv'], value: 'ENV_REF' }], 7)
    test.saveSettings.mockClear()
    await expect(saveRouteConfiguration(request)).rejects.toBeInstanceOf(RouteSaveConflictError)
    expect(test.saveSettings).not.toHaveBeenCalled()
    expect(test.saveCredential).not.toHaveBeenCalled()
    expect(test.keys.get('ENV_REF')).toBe('fake-env-key')
  })

  it('cleans only its private staging ref when another editor changes the same route during key staging', async () => {
    const test = fixture()
    const storeKey = test.saveCredential.getMockImplementation()!
    test.saveCredential.mockImplementation(async (...args) => {
      await storeKey(...args)
      await test.saveSettings('llm-volcengine', [{ op: 'set', path: ['routes', 'standard', 'name'], value: 'Other editor' }], 7)
    })
    await expect(saveRouteConfiguration({ ...test.request(), apiKey: 'fake-new-key' })).rejects.toBeInstanceOf(RouteSaveConflictError)
    expect(test.deleteCredential).toHaveBeenCalledWith(FIRST_REF)
    expect(test.keys.has(FIRST_REF)).toBe(false)
    expect(test.keys.get('OLD_REF')).toBe('fake-old-key')
    expect(routeAt(test.view().value, ['routes', 'standard'])).toMatchObject({ name: 'Other editor', apiKeyEnv: 'OLD_REF' })
  })

  it('rebases independent route saves after a namespace CAS conflict, retaining both edits and unknown settings', async () => {
    const test = fixture()
    const first = { ...test.request(), changes: { name: 'Standard edited' } }
    const second = { ...test.request('coding'), changes: { name: 'Coding edited' } }
    await Promise.all([saveRouteConfiguration(first), saveRouteConfiguration(second)])
    expect(test.view().revision).toBe(9)
    expect(test.saveSettings.mock.calls.map(call => call[2])).toEqual([7, 7, 8])
    expect(test.view().value).toMatchObject({ futureNamespace: 'keep', routes: {
      standard: { name: 'Standard edited', futureRoute: { keep: true }, models: [{ futureModel: { keep: true } }] },
      coding: { name: 'Coding edited' },
    } })
  })

  it('uses the same route CAS when the only edit is a new API key', async () => {
    const test = fixture()
    const result = await saveRouteConfiguration({ ...test.request(), apiKey: 'fake-new-key' })
    expect(test.saveSettings).toHaveBeenCalledWith('llm-volcengine', [{ op: 'set', path: ['routes', 'standard', 'apiKeyEnv'], value: FIRST_REF }], 7)
    expect(result.credential).toMatchObject({ configured: true, writable: true })
    expect(test.saveCredential).toHaveBeenCalledWith(FIRST_REF, 'fake-new-key')
  })

  it('snapshots caller-owned edits while a save is running', async () => {
    const test = fixture()
    const ready = deferred()
    const resume = deferred()
    const read = test.read.getMockImplementation()!
    test.read.mockImplementation(async () => { ready.resolve(); await resume.promise; return read() })
    const request = { ...test.request(), path: ['routes', 'standard'], changes: { name: 'Intended name' }, apiKey: 'fake-intended-key' }
    const saving = saveRouteConfiguration(request)
    await ready.promise
    request.path[1] = 'coding'
    request.original.apiKeyEnv = 'ENV_REF'
    request.changes.name = 'Late edit'
    request.apiKey = 'fake-late-key'
    request.namespace.ns = 'changed-ns'
    resume.resolve()
    const result = await saving
    expect(result.namespace.ns).toBe('llm-volcengine')
    expect(result.route.name).toBe('Intended name')
    expect(test.keys.get(FIRST_REF)).toBe('fake-intended-key')
  })

  it('never publishes configuration when credential storage fails', async () => {
    const test = fixture()
    test.saveCredential.mockRejectedValue(new Error('credential storage unavailable'))
    await expect(saveRouteConfiguration({ ...test.request(), changes: { baseURL: 'https://new.invalid/v3' }, apiKey: 'fake-new-key' })).rejects.toThrow('credential storage unavailable')
    expect(test.view().revision).toBe(7)
    expect(test.saveSettings).not.toHaveBeenCalled()
    expect(test.deleteCredential).toHaveBeenCalledWith(FIRST_REF)
  })

  it('recovers a lost success response using its unique published ref without deleting the live key', async () => {
    const test = fixture()
    const publish = test.saveSettings.getMockImplementation()!
    test.saveSettings.mockImplementation(async (...args) => { await publish(...args); throw new Error('connection lost after commit') })
    const result = await saveRouteConfiguration({ ...test.request(), apiKey: 'fake-new-key' })
    expect(result.credentialReference).toBe(FIRST_REF)
    expect(test.keys.get(FIRST_REF)).toBe('fake-new-key')
    expect(test.deleteCredential).not.toHaveBeenCalled()
  })

  it('retains the staged key after an ambiguous settings failure because a pending request may still publish it', async () => {
    const test = fixture()
    test.saveSettings.mockRejectedValue(new Error('connection lost; commit is unknown'))
    await expect(saveRouteConfiguration({ ...test.request(), apiKey: 'fake-new-key' })).rejects.toBeInstanceOf(RouteSaveUncertainError)
    expect(test.keys.get(FIRST_REF)).toBe('fake-new-key')
    expect(test.deleteCredential).not.toHaveBeenCalled()
    expect(test.keys.get('OLD_REF')).toBe('fake-old-key')
  })

  it('binds an explicitly selected environment reference without writing its read-only value', async () => {
    const test = fixture()
    const result = await saveRouteConfiguration({ ...test.request(), changes: { apiKeyEnv: 'ENV_REF' } })
    expect(result.credentialReference).toBe('ENV_REF')
    expect(result.credential.writable).toBe(false)
    expect(test.saveCredential).not.toHaveBeenCalled()
  })

  it('rejects an explicit reference plus a new key instead of silently ignoring the reference', async () => {
    const test = fixture()
    await expect(saveRouteConfiguration({ ...test.request(), changes: { apiKeyEnv: 'ENV_REF' }, apiKey: 'fake-new-key' })).rejects.toThrow('使用手动密钥引用时请留空 API Key')
    expect(test.saveCredential).not.toHaveBeenCalled()
    expect(test.saveSettings).not.toHaveBeenCalled()
  })

  it('does not overwrite a configured or read-only collision while allocating a private reference', async () => {
    const test = fixture()
    test.keys.set(FIRST_REF, 'fake-existing-unrelated-key')
    const mint = vi.fn().mockReturnValueOnce(FIRST_REF).mockReturnValue(SECOND_REF)
    const result = await saveRouteConfiguration({ ...test.request(), apiKey: 'fake-new-key', createCredentialReference: mint })
    expect(result.credentialReference).toBe(SECOND_REF)
    expect(test.keys.get(FIRST_REF)).toBe('fake-existing-unrelated-key')
    expect(test.saveCredential).toHaveBeenCalledExactlyOnceWith(SECOND_REF, 'fake-new-key')
  })
})
