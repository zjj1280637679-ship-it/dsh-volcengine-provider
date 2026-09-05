import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import {
  hasSlotRegistry,
  inspectLlmHost,
} from '../../src/host-compat.js'
import { settingsSectionMode } from '../../src/settings-compat.js'

describe('version-independent Host capability policy', () => {
  it('does not encode synchronized Harness prereleases as npm peer locks', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
      devDependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-')))
      .toEqual([])
    // Exact packages still belong in the development fixture; removing runtime
    // locks must not turn compilation into an unpinned network experiment.
    expect(manifest.devDependencies?.['@deepseek-ai/dsh-llm']).toMatch(/^0\.1\./u)
    // Stable host libraries stay declarative, but must not make pnpm install a
    // private Host copy when DSH provides them through its profile fallback.
    expect(manifest.peerDependenciesMeta?.['@deepseek-ai/cordis']?.optional).toBe(true)
    expect(manifest.peerDependenciesMeta?.['@deepseek-ai/schemastery']?.optional).toBe(true)
  })

  it.each([
    ['0.1.1-style public surface', {
      registerAdapter() {}, listProviders() {},
      registerConfigurableProviders() {}, listConfigurableProviders() {},
      registerModelDiscovery() {},
    }],
    ['0.1.2-style additive surface', {
      registerAdapter() {}, listProviders() {},
      registerConfigurableProviders() {}, listConfigurableProviders() {},
      registerModelDiscovery() {}, futureMethod() {},
    }],
    ['future proxy-backed surface with the same capabilities', new Proxy({}, {
      get: (_target, name) => typeof name === 'string' ? () => undefined : undefined,
    })],
  ])('accepts %s without reading a version', (_label, llm) => {
    expect(inspectLlmHost(llm)).toMatchObject({ core: true, directory: true, discovery: true, missing: [] })
  })

  it('separates the required adapter seam from optional directory and discovery features', () => {
    expect(inspectLlmHost({ registerAdapter() {}, listProviders() {} })).toEqual({
      core: true,
      directory: false,
      discovery: false,
      missing: ['registerConfigurableProviders', 'listConfigurableProviders', 'registerModelDiscovery'],
    })
    expect(inspectLlmHost({ listProviders() {} })).toMatchObject({
      core: false,
      directory: false,
      discovery: false,
    })
  })

  it('selects settings and slot features by callable shape', () => {
    expect(settingsSectionMode({ installSection() {} })).toBe('install-section')
    expect(settingsSectionMode({ register() {} })).toBe('register-watch')
    expect(settingsSectionMode({ installSection: true, register: 'old' })).toBe('unavailable')
    expect(hasSlotRegistry({ inject() {}, register() {}, futureSeat() {} })).toBe(true)
    expect(hasSlotRegistry({ inject() {} })).toBe(false)
  })
})
