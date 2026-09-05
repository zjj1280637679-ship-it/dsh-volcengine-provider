import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import * as VolcenginePlugin from '../../src/plugin.js'
import { SETTINGS_NS } from '../../src/config.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'
import { enqueueCompletion, MemoryCredentials, MemorySettings, prompt } from './fixtures.js'

let root: string | undefined
let ctx: Context | undefined
let fake: FakeArk | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await fake?.close()
  fake = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Cordis configuration composition', () => {
  it('loads a real cordis.yml through Loader and Include, then serves a live model-card edit', async () => {
    root = await mkdtemp(join(tmpdir(), 'volcengine-loader-'))
    fake = await startFakeArk()
    enqueueCompletion(fake, 'from composition')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm'",
      '- id: settings',
      "  name: 'test:memory-settings'",
      '- id: credentials',
      "  name: 'test:memory-credentials'",
      '  config:',
      '    TEST_VOLCENGINE_LOADER_KEY: composition-key',
      '- id: volcengine',
      "  name: 'dsh-volcengine-provider'",
      '  config:',
      '    routes:',
      '      coding-plan:',
      '        kind: coding-plan',
      `        baseURL: ${JSON.stringify(`${fake.baseUrl}/api/coding/v3`)}`,
      '        apiKeyEnv: TEST_VOLCENGINE_LOADER_KEY',
      '        models:',
      '          - id: loader-model',
      '            name: Loader model',
      '',
    ].join('\n'))

    ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['test:memory-settings', MemorySettings],
      ['test:memory-credentials', MemoryCredentials],
      ['dsh-volcengine-provider', VolcenginePlugin],
    ])
    // Loader/Include and runtime are the published packages. Only module
    // resolution is mapped so this test can exercise the plugin's source.
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    expect(ctx.llm.listProviders()).toEqual([
      expect.objectContaining({ id: 'volcengine-coding-plan' }),
    ])
    expect(ctx.settings.describe().map(section => section.ns)).toEqual([SETTINGS_NS])
    await expect(ctx.llm.listModels('volcengine-coding-plan')).resolves.toEqual([
      expect.objectContaining({ id: 'loader-model', name: 'Loader model' }),
    ])
    expect(fake.requests).toHaveLength(0)

    await ctx.settings.update(SETTINGS_NS, { routes: { 'coding-plan': { models: [{
      id: 'loader-model', customBody: { reasoning_effort: 'high', future_setting: [1, 2] },
    }] } } })
    await ctx.credentials.set(credentialRef('TEST_VOLCENGINE_LOADER_KEY'), 'edited-key')
    expect((await prompt(ctx, 'volcengine-coding-plan', 'loader-model')).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.path).toBe('/api/coding/v3/chat/completions')
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer edited-key')
    expect(fake.requests[0]!.json).toMatchObject({
      model: 'loader-model', reasoning_effort: 'high', future_setting: [1, 2],
    })
  })
})
