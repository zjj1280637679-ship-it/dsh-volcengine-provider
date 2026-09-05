import { expect, it } from 'vitest'

import { pluginSettingsProviders } from '../../src/client/PluginSettingsCard.js'
import type { SettingsDescribeValue } from '../../src/client/operations.js'

function description(routes: Record<string, unknown>): SettingsDescribeValue {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [{
      ns: 'llm-volcengine', schema: {}, value: { routes }, applies: 'live', secrets: [], revision: 1,
    }],
  }
}

it('maps the three built-in Ark routes to advanced cards on the rc.2 Plugins page', () => {
  expect(pluginSettingsProviders(description({
    standard: { kind: 'standard' },
    'agent-plan': { kind: 'agent-plan' },
    'coding-plan': { kind: 'coding-plan' },
  })).map(card => ({
    provider: card.provider,
    path: card.settingsPath,
  }))).toEqual([
    { provider: 'volcengine-standard', path: ['routes', 'standard'] },
    { provider: 'volcengine-agent-plan', path: ['routes', 'agent-plan'] },
    { provider: 'volcengine-coding-plan', path: ['routes', 'coding-plan'] },
  ])
})

it('shows only the routes present in a partial rc.2 profile', () => {
  expect(pluginSettingsProviders(description({
    'coding-plan': { kind: 'coding-plan', name: 'Coding only', enabled: true },
  }))).toEqual([expect.objectContaining({
    provider: 'volcengine-coding-plan',
    displayName: 'Coding only',
    settingsPath: ['routes', 'coding-plan'],
  })])
})
