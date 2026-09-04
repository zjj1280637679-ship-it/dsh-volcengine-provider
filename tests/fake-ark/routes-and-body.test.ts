import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildChatCompletionsBody } from '../../src/wire.js'
import { getDefaultRoute, type RouteKind } from '../../src/routes.js'
import { sendArkJson } from '../../src/transport.js'
import { startFakeArk, type FakeArk } from '../support/fake-ark.js'

describe('fake ark: route isolation and final body capture', () => {
  let fake!: FakeArk

  beforeEach(async () => {
    fake = await startFakeArk()
  })

  afterEach(async () => {
    await fake.close()
  })

  it('sends each route to its own exact path prefix with its own credential', async () => {
    const cases = [
      ['standard', '/api/v3'],
      ['agent-plan', '/api/plan/v3'],
      ['coding-plan', '/api/coding/v3'],
    ] as const satisfies readonly (readonly [RouteKind, string])[]

    for (const [kind, prefix] of cases) {
      const route = {
        ...getDefaultRoute(kind),
        baseUrl: `${fake.baseUrl}${prefix}`,
      }
      const response = await sendArkJson({
        route,
        operation: 'chat/completions',
        apiKey: `test-key-${kind}`,
        body: { model: `model-${kind}`, messages: [] },
      })
      expect(response.status).toBe(200)
    }

    expect(fake.requests.map(request => request.path)).toEqual([
      '/api/v3/chat/completions',
      '/api/plan/v3/chat/completions',
      '/api/coding/v3/chat/completions',
    ])
    expect(fake.requests.map(request => request.headers.authorization)).toEqual([
      'Bearer test-key-standard',
      'Bearer test-key-agent-plan',
      'Bearer test-key-coding-plan',
    ])
  })

  it('does not retry or fall back to another route after a Coding Plan failure', async () => {
    fake.enqueueResponse({
      status: 429,
      headers: { 'content-type': 'application/json' },
      body: '{"error":{"message":"rate limited"}}',
    })

    const route = {
      ...getDefaultRoute('coding-plan'),
      baseUrl: `${fake.baseUrl}/api/coding/v3`,
    }
    const response = await sendArkJson({
      route,
      operation: 'chat/completions',
      apiKey: 'coding-secret',
      body: { model: 'any-model', messages: [] },
    })

    expect(response.status).toBe(429)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.path).toBe('/api/coding/v3/chat/completions')
  })

  it('delivers an unknown model id and unknown custom fields unchanged', async () => {
    const body = buildChatCompletionsBody({
      model: 'future-model-not-in-any-catalog',
      messages: [{ role: 'user', content: 'hello' }],
      customBody: {
        future_vendor_field: { nested: ['kept', 123] },
        experimental_video_understanding: true,
      },
    })
    const route = {
      ...getDefaultRoute('standard'),
      baseUrl: `${fake.baseUrl}/api/v3`,
    }

    await sendArkJson({
      route,
      operation: 'chat/completions',
      apiKey: 'standard-secret',
      body,
    })

    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.json).toEqual(body)
  })
})
