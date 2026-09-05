import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import * as VolcenginePlugin from '../../src/plugin.js'
import { defaultRoutes, SETTINGS_NS, type Config } from '../../src/config.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'
import { enqueueCompletion, MemoryCredentials, MemorySettings, prompt } from './fixtures.js'

const KEY = credentialRef('TEST_VOLCENGINE_KEY')
const contexts: Context[] = []
const servers: FakeArk[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) await server.close()
  vi.unstubAllEnvs()
})

async function server(): Promise<FakeArk> {
  const fake = await startFakeArk()
  servers.push(fake)
  return fake
}

async function boot(config: Config = {}, options: { dynamic?: boolean; key?: string; legacySettings?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  if (options.dynamic !== false) {
    await ctx.plugin(MemorySettings)
    if (options.legacySettings === true) {
      Object.defineProperty(ctx.settings, 'installSection', { configurable: true, value: undefined })
    }
    await ctx.plugin(MemoryCredentials, options.key ? { [KEY]: options.key } : {})
  }
  const plugin = ctx.plugin(VolcenginePlugin, config)
  await plugin
  return { ctx, plugin }
}

function standard(baseURL: string): Config {
  return {
    routes: {
      standard: {
        kind: 'standard', baseURL, apiKeyEnv: KEY,
        models: [{ id: 'manual-model', name: 'My manual model' }],
      },
    },
  }
}

describe('Volcengine plugin in the public Harness runtime', () => {
  it('accepts cancellation from the rc.2 request field and the later callback argument', () => {
    const request = new AbortController().signal
    const callback = new AbortController().signal
    expect(VolcenginePlugin.modelDiscoverySignal({ signal: request } as never)).toBe(request)
    expect(VolcenginePlugin.modelDiscoverySignal({} as never, callback)).toBe(callback)
    expect(VolcenginePlugin.modelDiscoverySignal({ signal: request } as never, callback)).toBe(callback)
    expect(VolcenginePlugin.modelDiscoverySignal({} as never)).toBeUndefined()
  })

  it('uses the Harness 0.1.1 public settings seams when installSection is not a provider method', async () => {
    const fake = await server()
    enqueueCompletion(fake, 'legacy settings host')
    const { ctx, plugin } = await boot(standard(fake.baseUrl), { key: 'legacy-key', legacySettings: true })

    expect(ctx.settings.describe().map(descriptor => descriptor.ns)).toEqual([SETTINGS_NS])
    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer legacy-key')

    await ctx.settings.update(SETTINGS_NS, { routes: { standard: { models: [{ id: 'legacy-edited' }] } } })
    await expect(ctx.llm.listModels('volcengine-standard')).resolves.toEqual([
      expect.objectContaining({ id: 'legacy-edited' }),
    ])

    await plugin.dispose()
    expect(ctx.settings.describe().map(descriptor => descriptor.ns)).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('registers three editable cards and reads manual model catalogs without credentials or network', async () => {
    const fake = await server()
    const routes = defaultRoutes()
    for (const [key, route] of Object.entries(routes)) {
      route.baseURL = `${fake.baseUrl}/${key}`
      route.models = [{ id: `${key}-manual`, name: `Manual ${key}` }]
    }
    const { ctx } = await boot({ routes })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([
      'volcengine-standard', 'volcengine-agent-plan', 'volcengine-coding-plan',
    ])
    expect(ctx.llm.listConfigurableProviders()).toEqual(Object.entries(routes).map(([key, route]) => expect.objectContaining({
      provider: `volcengine-${key}`,
      displayName: route.name,
      settingsNs: SETTINGS_NS,
      settingsPath: ['routes', key],
    })))
    expect(ctx.settings.describe().map(descriptor => descriptor.ns)).toEqual([SETTINGS_NS])
    for (const key of Object.keys(routes)) {
      await expect(ctx.llm.listModels(`volcengine-${key}`)).resolves.toEqual([
        expect.objectContaining({ provider: `volcengine-${key}`, id: `${key}-manual`, name: `Manual ${key}` }),
      ])
    }
    expect(fake.requests).toHaveLength(0)
    expect(JSON.stringify(ctx.settings.describe({ redactSecrets: true }))).not.toContain('Bearer')
  })

  it('boots on defaults with three empty model catalogs and no credential service', async () => {
    const { ctx } = await boot({}, { dynamic: false })
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(3)
    expect(ctx.llm.listProviders()).toHaveLength(3)
    for (const provider of ctx.llm.listProviders()) {
      await expect(ctx.llm.listModels(provider.id)).resolves.toEqual([])
    }
  })

  it('treats cleared display names as defaults instead of invalid Harness metadata', async () => {
    const fake = await server()
    enqueueCompletion(fake)
    const config = standard(fake.baseUrl)
    config.routes!.standard!.name = ''
    config.routes!.standard!.models![0]!.name = ''
    const { ctx } = await boot(config, { key: 'configured-key' })
    expect(ctx.llm.listProviders()[0]!.name).toBe('火山方舟 · 普通 API')
    await expect(ctx.llm.listModels('volcengine-standard')).resolves.toEqual([
      expect.objectContaining({ id: 'manual-model', name: 'manual-model' }),
    ])
    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('uses changed route, model request body and rotated credential on the next runtime request', async () => {
    const first = await server()
    const second = await server()
    enqueueCompletion(first)
    enqueueCompletion(second, 'updated request')
    const { ctx } = await boot(standard(`${first.baseUrl}/api/v3`), { key: 'first-key' })

    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(first.requests[0]!.headers.authorization).toBe('Bearer first-key')

    await ctx.settings.update(SETTINGS_NS, { routes: { standard: {
      baseURL: `${second.baseUrl}/custom/v3`,
      models: [{
        id: 'manual-model', name: 'Edited in settings',
        customBody: { thinking: { type: 'enabled' }, future_options: { opaque: true } },
      }],
    } } })
    await ctx.credentials.set(KEY, 'rotated-key')

    const result = await prompt(ctx)
    expect(result).toContainEqual({ type: 'text-delta', index: 0, text: 'updated request' })
    expect(result.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    expect(second.requests[0]!.path).toBe('/custom/v3/chat/completions')
    expect(second.requests[0]!.headers.authorization).toBe('Bearer rotated-key')
    expect(second.requests[0]!.json).toMatchObject({
      model: 'manual-model',
      thinking: { type: 'enabled' },
      future_options: { opaque: true },
    })
    await expect(ctx.llm.listModels('volcengine-standard')).resolves.toEqual([
      expect.objectContaining({ id: 'manual-model', name: 'Edited in settings' }),
    ])
    const descriptors = JSON.stringify(ctx.settings.describe({ redactSecrets: true }))
    expect(descriptors).not.toContain('first-key')
    expect(descriptors).not.toContain('rotated-key')
  })

  it('starts without a key, fails explicitly without HTTP, and recovers when credentials arrive', async () => {
    vi.stubEnv(KEY, '')
    const fake = await server()
    enqueueCompletion(fake)
    const { ctx } = await boot(standard(fake.baseUrl))

    const missing = await prompt(ctx)
    expect(missing.at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } },
    })
    expect(fake.requests).toHaveLength(0)
    await ctx.credentials.set(KEY, 'arrived-key')
    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer arrived-key')
  })

  it('keeps a prepared call on one endpoint, key and body generation while the next call uses new settings', async () => {
    const first = await server()
    const second = await server()
    enqueueCompletion(first)
    enqueueCompletion(second)
    const config = standard(first.baseUrl)
    Object.assign(config.routes!.standard!.models![0]!, {
      customBody: { generation: 'before' }, maxTokens: 256,
    })
    const { ctx } = await boot(config, { key: 'before-key' })
    const prepared = await ctx.llm.prepareCall({ provider: 'volcengine-standard', model: 'manual-model' })
    expect(prepared.config.maxTokens).toBe(256)
    expect(Object.hasOwn(prepared, 'inputModalities')).toBe(false)

    await ctx.settings.update(SETTINGS_NS, { routes: { standard: {
      baseURL: second.baseUrl,
      models: [{ id: 'manual-model', customBody: { generation: 'after' }, maxTokens: 512,
        modalities: { video: 'force_enable' } }],
    } } })
    await ctx.credentials.set(KEY, 'after-key')

    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(first.requests[0]!.headers.authorization).toBe('Bearer before-key')
    expect(first.requests[0]!.json).toMatchObject({ generation: 'before', max_tokens: 256 })
    expect(second.requests).toHaveLength(0)

    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(second.requests[0]!.headers.authorization).toBe('Bearer after-key')
    expect(second.requests[0]!.json).toMatchObject({ generation: 'after', max_tokens: 512 })
    const resolved = await ctx.llm.resolveModelInfo('volcengine-standard', 'manual-model')
    expect(resolved).toMatchObject({ defaultMaxTokens: 512 })
    expect(Object.hasOwn(resolved, 'inputModalities')).toBe(false)
  })

  it('honors an explicit text disable before HTTP and re-enables it through the model card', async () => {
    const fake = await server()
    enqueueCompletion(fake)
    const config = standard(fake.baseUrl)
    config.routes!.standard!.models![0]!.modalities = { text: 'force_disable' }
    const { ctx } = await boot(config, { key: 'test-key' })
    const options = {
      provider: 'volcengine-standard', model: 'manual-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }
    const disabled: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(options)) disabled.push(chunk)
    expect(disabled.at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: 'MODALITY_DISABLED' } },
    })
    expect(fake.requests).toHaveLength(0)

    await ctx.settings.update(SETTINGS_NS, { routes: { standard: { models: [
      { id: 'manual-model', modalities: { text: 'force_enable' } },
    ] } } })
    const enabled: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(options)) enabled.push(chunk)
    expect(enabled.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.json).toMatchObject({ messages: [{ role: 'user', content: 'hello' }] })
  })

  it('keeps rich discovery feedback from changing user model modalities, context or request controls', async () => {
    const fake = await server()
    fake.enqueueResponse({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{
        id: 'manual-model', name: 'Vendor label', supports_video: false,
        input_modalities: ['text'], context_window: 5,
        reasoning: { efforts: ['high'] }, default_max_tokens: 1,
      }] }),
    })
    const config = standard(fake.baseUrl)
    Object.assign(config.routes!.standard!.models![0]!, {
      modalities: { video: 'force_enable' }, contextWindow: 65536, maxTokens: 512,
    })
    const { ctx } = await boot(config, { key: 'test-key' })
    const before = ctx.settings.get(SETTINGS_NS)

    await expect(ctx.llm.discoverModels(SETTINGS_NS, { provider: 'volcengine-standard' })).resolves.toEqual([
      { id: 'manual-model', name: 'Vendor label' },
    ])
    expect(fake.requests).toHaveLength(1)
    expect(ctx.settings.get(SETTINGS_NS)).toEqual(before)
    const resolved = await ctx.llm.resolveModelInfo('volcengine-standard', 'manual-model')
    expect(resolved).toMatchObject({
      name: 'My manual model', context: { contextWindow: 65536 }, defaultMaxTokens: 512,
    })
    expect(Object.hasOwn(resolved, 'inputModalities')).toBe(false)
    expect(resolved).not.toHaveProperty('reasoning')
  })

  it('uses environment references when optional settings and credentials services are absent', async () => {
    vi.stubEnv(KEY, 'environment-key')
    const fake = await server()
    enqueueCompletion(fake)
    const { ctx } = await boot(standard(fake.baseUrl), { dynamic: false })

    expect(ctx.get('settings')).toBeUndefined()
    expect(ctx.get('credentials')).toBeUndefined()
    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer environment-key')
  })

  it('keeps a disabled card editable, activates added routes live, and removes every registration on unload', async () => {
    const fake = await server()
    const { ctx, plugin } = await boot(standard(fake.baseUrl), { key: 'test-key' })
    await ctx.settings.update(SETTINGS_NS, { routes: { standard: { enabled: false } } })
    await vi.waitFor(() => expect(ctx.llm.listProviders()).toEqual([]))
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      expect.objectContaining({ provider: 'volcengine-standard' }),
    ])
    expect((await prompt(ctx)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(fake.requests).toHaveLength(0)

    await ctx.settings.update(SETTINGS_NS, { routes: {
      experimental: {
        kind: 'coding-plan', name: 'Experimental card', baseURL: `${fake.baseUrl}/api/coding/v3`,
        apiKeyEnv: KEY, models: [{ id: 'arbitrary-future-model' }],
      },
    } })
    await vi.waitFor(() => expect(ctx.llm.listProviders()).toEqual([
      { id: 'volcengine-experimental', name: 'Experimental card' },
    ]))
    enqueueCompletion(fake)
    expect((await prompt(ctx, 'volcengine-experimental', 'arbitrary-future-model')).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(fake.requests[0]!.path).toBe('/api/coding/v3/chat/completions')

    await plugin.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(ctx.settings.describe()).toEqual([])
  })

  it('rejects a route ownership conflict before persisting or moving an existing endpoint', async () => {
    const original = await server()
    const rejected = await server()
    enqueueCompletion(original)
    const { ctx } = await boot(standard(`${original.baseUrl}/original/v3`), { key: 'test-key' })
    class OtherAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    await ctx.plugin({
      inject: ['llm'],
      apply(owner: Context) {
        owner.llm.registerAdapter(['volcengine-extra'], new OtherAdapter())
      },
    })
    const settingsBefore = ctx.settings.describe()
    const directoryBefore = ctx.llm.listConfigurableProviders()
    const providersBefore = ctx.llm.listProviders()

    await expect(ctx.settings.update(SETTINGS_NS, { routes: {
      standard: { baseURL: `${rejected.baseUrl}/rejected/v3` },
      extra: {
        kind: 'standard', enabled: true, baseURL: rejected.baseUrl,
        apiKeyEnv: KEY, models: [{ id: 'another-model' }],
      },
    } })).rejects.toThrow()

    // Admission must refuse the whole candidate before either persistence or
    // registry publication; a failed observer after commit would be too late.
    expect(ctx.settings.describe()).toEqual(settingsBefore)
    expect(ctx.llm.listConfigurableProviders()).toEqual(directoryBefore)
    expect(ctx.llm.listProviders()).toEqual(providersBefore)
    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(original.requests).toHaveLength(1)
    expect(original.requests[0]!.path).toBe('/original/v3/chat/completions')
    expect(rejected.requests).toHaveLength(0)
  })

  it('preserves unknown route and model settings through live edits for future UI controls', async () => {
    const config = standard('http://127.0.0.1:1')
    config.future_top_level = { version: 2 }
    const route = config.routes!.standard!
    route.future_route_control = { enabled: true }
    route.models![0]!.future_model_control = { values: ['a', 'b'] }
    route.models![0]!.customBody = { new_vendor_field: { enabled: true } }
    const { ctx } = await boot(config)

    await ctx.settings.update(SETTINGS_NS, { routes: { standard: {
      name: 'Renamed card', future_route_control: { added_after_boot: true },
    } } })
    await ctx.settings.mutate(SETTINGS_NS, [{ op: 'set',
      path: ['routes', 'standard', 'future_route_control', 'edited_by_ui'], value: { any_json: [1, false, null] },
    }])
    expect(ctx.settings.get(SETTINGS_NS)).toMatchObject({
      future_top_level: { version: 2 },
      routes: { standard: {
        name: 'Renamed card', future_route_control: {
          enabled: true, added_after_boot: true, edited_by_ui: { any_json: [1, false, null] },
        },
        models: [{
          id: 'manual-model', future_model_control: { values: ['a', 'b'] },
          customBody: { new_vendor_field: { enabled: true } },
        }],
      } },
    })
  })

  it('round-trips raw request-body JSON through settings without losing literal special keys', async () => {
    const fake = await server()
    enqueueCompletion(fake)
    const { ctx } = await boot(standard(fake.baseUrl), { key: 'test-key' })
    const customBody = '{"__proto__":{"vendorRoot":true},"nested":{"__proto__":{"vendorNested":true}},"constructor":{"prototype":{"vendorConstructor":true}}}'
    await ctx.settings.update(SETTINGS_NS, { routes: { standard: { models: [{
      id: 'manual-model', customBody,
    }] } } })
    await ctx.settings.mutate(SETTINGS_NS, [{
      op: 'set', path: ['routes', 'standard', 'name'], value: 'Edited beside raw JSON',
    }])
    expect(ctx.settings.get(SETTINGS_NS)).toMatchObject({ routes: { standard: { models: [{ customBody }] } } })

    expect((await prompt(ctx)).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const body = fake.requests[0]!.json as Record<string, unknown>
    const nested = body.nested as Record<string, unknown>
    expect(Object.hasOwn(body, '__proto__')).toBe(true)
    expect(body.__proto__).toEqual({ vendorRoot: true })
    expect(Object.hasOwn(nested, '__proto__')).toBe(true)
    expect(nested.__proto__).toEqual({ vendorNested: true })
    expect(body.constructor).toEqual({ prototype: { vendorConstructor: true } })
    expect(Object.hasOwn(Object.prototype, 'vendorRoot')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'vendorNested')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'vendorConstructor')).toBe(false)
  })
})
