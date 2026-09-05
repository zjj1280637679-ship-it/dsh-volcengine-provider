import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import * as react from 'react'
import * as reactDom from 'react-dom'
import * as reactDomClient from 'react-dom/client'
import * as jsx from 'react/jsx-runtime'
import { expect, it } from 'vitest'
import * as plugin from '../../src/client/index.js'

/** Materialize the actual npm browser factory using the host's shared-module contract. */
async function registry() {
  const require = createRequire(import.meta.url)
  const script = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8')
  const modules: Record<string, unknown> = {
    '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-ui-slots': slots,
    react, 'react-dom': reactDom, 'react-dom/client': reactDomClient, 'react/jsx-runtime': jsx,
  }
  let loaded: unknown
  runInNewContext(script, {
    window: { __ModuleLoader__: {
      load(entry: { factory: (require: (name: string) => unknown) => unknown }) {
        loaded = entry.factory(name => {
          if (!(name in modules)) throw new Error(`Unexpected browser external: ${name}`)
          return modules[name]
        })
      },
    } }, queueMicrotask, setTimeout, clearTimeout,
  })
  return (loaded as typeof import('@deepseek-ai/dsh-client-ui-renderer/client')).SlotRegistry
}

it('registers after the real Models slot appears, restores after redeclaration and cleans up on unload', async () => {
  const ctx = new cordis.Context()
  try {
    const SlotRegistry = await registry()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('remote', {})
    ctx.provide('remote.settings', {})
    ctx.provide('remote.credentials', {})
    const mounted = ctx.plugin(plugin)
    await mounted.await()
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(0)
    const declare = () => ctx.slots.register({
      name: 'root',
      children: { 'settings.models.provider-card': { kind: 'keyed', scope: 'root' } },
    } as never, () => null)
    const dispose = declare()
    const entries = ctx.slots.entries('settings.models.provider-card')
    expect(entries).toHaveLength(1)
    expect(entries[0].options).toMatchObject({ key: 'llm-volcengine' })
    dispose()
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(0)
    declare()
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(1)
    await mounted.dispose()
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(0)
  } finally { await ctx.fiber.dispose() }
})
