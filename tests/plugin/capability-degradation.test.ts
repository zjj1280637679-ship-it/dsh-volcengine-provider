import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as VolcenginePlugin from '../../src/plugin.js'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('Host capability degradation', () => {
  it('keeps Host boot active when the injected LLM service lacks the core adapter seam', async () => {
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.provide('llm', { listProviders: () => [] } as never)

    const mounted = ctx.plugin(VolcenginePlugin)
    await mounted.await()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('lacks public capabilities'),
      'registerAdapter',
    )
  })

  it('serves static routes when optional directory and discovery capabilities are absent', async () => {
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const registered: string[][] = []
    const registerAdapter = vi.fn((providers: string[]) => {
      registered.push([...providers])
      const dispose = () => undefined
      dispose.replace = (next: string[]) => { registered.push([...next]) }
      return dispose
    })
    ctx.provide('llm', { registerAdapter, listProviders: () => [] } as never)

    const mounted = ctx.plugin(VolcenginePlugin)
    await mounted.await()
    expect(registered).toEqual([[
      'volcengine-standard', 'volcengine-agent-plan', 'volcengine-coding-plan',
    ]])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider-directory capabilities are unavailable'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('model-discovery registration is unavailable'))
  })

  it('keeps static configuration active when a future settings service has no known attachment seam', async () => {
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const registerAdapter = (providers: string[]) => {
      const dispose = () => undefined
      dispose.replace = (_next: string[]) => undefined
      return dispose
    }
    const registerDirectory = (entries: unknown[]) => {
      const dispose = () => undefined
      dispose.replace = (_next: unknown[]) => undefined
      return dispose
    }
    ctx.provide('llm', {
      registerAdapter,
      listProviders: () => [],
      registerConfigurableProviders: registerDirectory,
      listConfigurableProviders: () => [],
      registerModelDiscovery: () => () => undefined,
    } as never)
    ctx.provide('settings', { futureSettingsApi: true } as never)

    const mounted = ctx.plugin(VolcenginePlugin)
    await mounted.await()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings attachment capabilities are unavailable'))
  })
})
