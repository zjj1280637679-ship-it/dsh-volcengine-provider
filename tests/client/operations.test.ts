import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCardOperations,
  hasNamespacedRemote,
  SettingsConflictError,
  type SettingsDescribeValue,
  type SettingsPathOpView,
} from '../../src/client/operations.js'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function description(): SettingsDescribeValue {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [{
      ns: 'llm-volcengine',
      schema: {},
      value: { routes: {} },
      applies: 'live',
      secrets: [],
      revision: 4,
    }],
  }
}

describe('version-neutral card operations', () => {
  it('uses namespaced Remotes on rc.1 and alpha hosts', async () => {
    const ctx = context()
    const view = description().namespaces[0]!
    const describe = vi.fn(async () => ({ ok: true as const, value: description() }))
    const mutate = vi.fn(async () => ({ ok: true as const, value: view }))
    const describeCredential = vi.fn(async () => ({
      ok: true as const,
      value: { ARK_KEY: { configured: true, writable: true, source: 'memory' } },
    }))
    const set = vi.fn(async () => ({ ok: true as const, value: {} }))
    const unset = vi.fn(async () => ({ ok: true as const, value: {} }))
    ctx.provide('remote', {
      settings: { describe, mutate },
      credentials: { describe: describeCredential, set, unset },
    } as never)
    const operations = createCardOperations(ctx)
    const ops: SettingsPathOpView[] = [{ op: 'set', path: ['routes'], value: {} }]

    expect(hasNamespacedRemote(ctx)).toBe(true)
    await expect(operations.read()).resolves.toEqual(description())
    await expect(operations.describeCredential('ARK_KEY')).resolves.toMatchObject({ configured: true })
    await expect(operations.saveSettings('llm-volcengine', ops, 4)).resolves.toEqual(view)
    await operations.saveCredential('ARK_KEY', 'test-value')
    await expect(operations.deleteCredential?.('PRIVATE_STAGING_REF')).resolves.toBe(true)
    expect(describe).toHaveBeenCalledWith()
    expect(describeCredential).toHaveBeenCalledWith(['ARK_KEY'])
    expect(mutate).toHaveBeenCalledWith('llm-volcengine', ops, 4)
    expect(set).toHaveBeenCalledWith('ARK_KEY', 'test-value')
    expect(unset).toHaveBeenCalledWith('PRIVATE_STAGING_REF')
  })

  it('uses rc.2 connection.api payloads and response envelopes', async () => {
    const ctx = context()
    const view = description().namespaces[0]!
    const describe = vi.fn(async () => ({ rpcId: 'read', result: { ok: true as const, value: description() } }))
    const mutate = vi.fn(async () => ({ rpcId: 'write', result: { ok: true as const, value: view } }))
    const describeCredential = vi.fn(async () => ({
      rpcId: 'credential-read',
      result: { ok: true as const, value: {
        credentials: { ARK_KEY: { configured: false, writable: true } },
      } },
    }))
    const set = vi.fn(async () => ({ rpcId: 'credential-write', result: { ok: true as const, value: {} } }))
    const unset = vi.fn(async () => ({ rpcId: 'credential-delete', result: { ok: true as const, value: {} } }))
    ctx.provide('remote', {} as never)
    ctx.provide('connection', { api: {
      settings: { describe, mutate },
      credentials: { describe: describeCredential, set, unset },
    } } as never)
    const operations = createCardOperations(ctx)
    const ops: SettingsPathOpView[] = [{ op: 'unset', path: ['routes', 'standard', 'name'] }]

    expect(hasNamespacedRemote(ctx)).toBe(false)
    await expect(operations.read()).resolves.toEqual(description())
    await expect(operations.describeCredential('ARK_KEY')).resolves.toMatchObject({ configured: false })
    await expect(operations.saveSettings('llm-volcengine', ops, 4)).resolves.toEqual(view)
    await operations.saveCredential('ARK_KEY', 'test-value')
    await expect(operations.deleteCredential?.('PRIVATE_STAGING_REF')).resolves.toBe(true)
    expect(describe).toHaveBeenCalledWith({})
    expect(describeCredential).toHaveBeenCalledWith({ refs: ['ARK_KEY'] })
    expect(mutate).toHaveBeenCalledWith({ ns: 'llm-volcengine', ops, expectedRevision: 4 })
    expect(set).toHaveBeenCalledWith({ ref: 'ARK_KEY', value: 'test-value' })
    expect(unset).toHaveBeenCalledWith({ ref: 'PRIVATE_STAGING_REF' })
  })

  it('accepts an additive response envelope on the namespaced transport', async () => {
    const ctx = context()
    const view = description().namespaces[0]!
    ctx.provide('remote', {
      settings: {
        describe: async () => ({ requestId: 'future', result: { ok: true, value: description() } }),
        mutate: async () => ({ requestId: 'future', result: { ok: true, value: view } }),
      },
      credentials: {
        describe: async () => ({ result: { ok: true, value: {
          credentials: { ARK_KEY: { configured: true, writable: true } },
        } } }),
        set: async () => ({ requestId: 'future', result: { ok: true, value: {} } }),
      },
    } as never)

    const operations = createCardOperations(ctx)
    await expect(operations.read()).resolves.toEqual(description())
    await expect(operations.describeCredential('ARK_KEY')).resolves.toMatchObject({ configured: true })
    await expect(operations.saveSettings('llm-volcengine', [], 4)).resolves.toEqual(view)
    await expect(operations.saveCredential('ARK_KEY', 'test-value')).resolves.toBeUndefined()
  })

  it('accepts direct operation results on the connection transport', async () => {
    const ctx = context()
    const view = description().namespaces[0]!
    ctx.provide('connection', { api: {
      settings: {
        describe: async () => ({ ok: true, value: description() }),
        mutate: async () => ({ ok: true, value: view }),
      },
      credentials: {
        describe: async () => ({ ok: true, value: {
          ARK_KEY: { configured: false, writable: true },
        } }),
        set: async () => ({ ok: true, value: {} }),
      },
    } } as never)

    const operations = createCardOperations(ctx)
    await expect(operations.read()).resolves.toEqual(description())
    await expect(operations.describeCredential('ARK_KEY')).resolves.toMatchObject({ configured: false })
    await expect(operations.saveSettings('llm-volcengine', [], 4)).resolves.toEqual(view)
    await expect(operations.saveCredential('ARK_KEY', 'test-value')).resolves.toBeUndefined()
  })

  it.each(['settings/conflict', 'settings-conflict'] as const)(
    'normalizes the %s settings conflict code', async (code) => {
    const ctx = context()
    ctx.provide('remote', {} as never)
    ctx.provide('connection', { api: {
      settings: {
        describe: async () => ({ result: { ok: true, value: description() } }),
        mutate: async () => ({ result: {
          ok: false, error: { code, message: 'wire detail' },
        } }),
      },
      credentials: {
        describe: async () => ({ result: { ok: true, value: { credentials: {} } } }),
        set: async () => ({ result: { ok: true, value: {} } }),
      },
    } } as never)

    await expect(createCardOperations(ctx).saveSettings('llm-volcengine', [], 1))
      .rejects.toBeInstanceOf(SettingsConflictError)
  })

  it('contains credential transport failures and reports unsupported cleanup without exposing the submitted value', async () => {
    const ctx = context()
    ctx.provide('remote', {
      settings: {
        describe: async () => ({ ok: true, value: description() }),
        mutate: async () => ({ ok: true, value: description().namespaces[0] }),
      },
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async (_ref: string, value: string) => { throw new Error(`transport echoed ${value}`) },
      },
    } as never)
    const operations = createCardOperations(ctx)
    await expect(operations.saveCredential('PRIVATE_STAGING_REF', 'fake-never-echo-key'))
      .rejects.toThrow('密钥未保存，请保留当前页面并重试。')
    await expect(operations.deleteCredential?.('PRIVATE_STAGING_REF')).resolves.toBe(false)
  })
})
