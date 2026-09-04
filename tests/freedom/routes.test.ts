import { describe, expect, it } from 'vitest'

import { DEFAULT_ROUTES, getDefaultRoute, joinRouteUrl } from '../../src/routes.js'

describe('freedom contract: route defaults', () => {
  it('does not let one caller mutate the shipped default route', () => {
    const first = getDefaultRoute('coding-plan')
    first.baseUrl = 'https://example.invalid/changed'
    first.apiKeyEnv = 'CHANGED'

    const second = getDefaultRoute('coding-plan')
    expect(second.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3')
    expect(second.apiKeyEnv).toBe('ARK_CODING_PLAN_API_KEY')
    expect(Object.isFrozen(DEFAULT_ROUTES['coding-plan'])).toBe(true)
  })

  it('preserves the route path prefix when joining an operation', () => {
    expect(joinRouteUrl(getDefaultRoute('agent-plan'), '/chat/completions')).toBe(
      'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions',
    )
  })
})
