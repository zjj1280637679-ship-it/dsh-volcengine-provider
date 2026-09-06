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

it('falls back to Plugins without requiring Remote and yields when Models appears', async () => {
  const ctx = new cordis.Context()
  try {
    const SlotRegistry = await registry()
    await ctx.plugin(SlotRegistry).await()
    const mounted = ctx.plugin(plugin)
    await mounted.await()
    const declarePlugin = () => ctx.slots.register({
      name: 'root', children: {
        'settings.plugin.item': { kind: 'keyed', scope: 'root' },
      },
    } as never, () => null)
    const disposePluginSeat = declarePlugin()
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(0)
    const entries = ctx.slots.entries('settings.plugin.item')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options).toMatchObject({ key: 'llm-volcengine' })
    disposePluginSeat()
    expect(ctx.slots.entries('settings.plugin.item')).toHaveLength(0)
    const disposeBothSeats = ctx.slots.register({
      name: 'root', children: {
        'settings.plugin.item': { kind: 'keyed', scope: 'root' },
        'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      },
    } as never, () => null)
    expect(ctx.slots.entries('settings.plugin.item')).toHaveLength(0)
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(1)
    disposeBothSeats()
    expect(ctx.slots.entries('settings.plugin.item')).toHaveLength(0)
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(0)
    const disposePluginSeatAgain = declarePlugin()
    expect(ctx.slots.entries('settings.plugin.item')).toHaveLength(1)
    disposePluginSeatAgain()
    await mounted.dispose()
    expect(ctx.slots.entries('settings.plugin.item')).toHaveLength(0)
  } finally { await ctx.fiber.dispose() }
})

it('adds one input-row media plus only when the complete public side-path exists', async () => {
  const ctx = new cordis.Context()
  try {
    const SlotRegistry = await registry()
    await ctx.plugin(SlotRegistry).await()
    const mounted = ctx.plugin(plugin)
    await mounted.await()
    const declare = () => ctx.slots.register({
      name: 'root', children: {
        'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
        'conversation.input.left': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    const dispose = declare()
    const mediaEntries = () => ctx.slots.entries('conversation.input.left' as never)
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(1)
    expect(mediaEntries()).toHaveLength(0)
    ctx.provide('connection', {
      isLoopback: true,
      rpc: { call() {} },
      generation: {
        getSnapshot: () => ({ id: 1, host: { home: 'C:\\Users\\fixture' } }),
        subscribe: () => () => {},
      },
    })
    ctx.provide('modelDirectories', { directoryFor: () => ({
      store: { getSnapshot: () => ({ current: null, routable: null }), subscribe: () => () => {} },
      load: async () => {},
    }) })
    ctx.provide('sessions', { scope() {}, subagentAddress() {} })
    ctx.provide('conversation', { input: { for: () => ({
      setDraft() {}, insertReference() { return true }, notify() {},
      state: { getSnapshot: () => ({ draft: '', draftRev: 0, phase: 'plain', occurrences: [] }), subscribe: () => () => {} },
    }) } })
    let sourceDisposed = false
    ctx.provide('inputTriggers', { registerSource() { return () => { sourceDisposed = true } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mediaEntries()).toHaveLength(1)
    expect(mediaEntries()[0]!.options).toMatchObject({ id: 'volcengine-native-media-plus', order: 31 })
    const injected = (mediaEntries()[0]!.inject as unknown as (id: string) => { operations: { addFiles: unknown } })('session-host')
    expect(typeof injected.operations.addFiles).toBe('function')
    expect(ctx.slots.entries('settings.models.provider-card')).toHaveLength(1)
    dispose()
    expect(mediaEntries()).toHaveLength(0)
    declare()
    expect(mediaEntries()).toHaveLength(1)
    await mounted.dispose()
    expect(mediaEntries()).toHaveLength(0)
    expect(sourceDisposed).toBe(true)
  } finally { await ctx.fiber.dispose() }
})

it('does not mount a partial or non-loopback input path', async () => {
  const ctx = new cordis.Context()
  try {
    const SlotRegistry = await registry()
    await ctx.plugin(SlotRegistry).await()
    const mounted = ctx.plugin(plugin)
    await mounted.await()
    ctx.slots.register({
      name: 'root', children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    ctx.provide('modelDirectories', { directoryFor: () => ({
      store: { getSnapshot: () => ({ current: null, routable: null }), subscribe: () => () => {} },
      load: async () => {},
    }) })
    ctx.provide('sessions', { scope() {}, subagentAddress() {} })
    ctx.provide('conversation', { input: { for() {} } })
    ctx.provide('inputTriggers', { registerSource() { return () => {} } })
    ctx.provide('connection', { isLoopback: false, rpc: { call() {} } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.slots.entries('conversation.input.left' as never)).toHaveLength(0)
    await mounted.dispose()
  } finally { await ctx.fiber.dispose() }
})
