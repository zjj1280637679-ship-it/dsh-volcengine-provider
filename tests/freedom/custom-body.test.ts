import { describe, expect, it } from 'vitest'

import { composeRequestBody } from '../../src/request-body.js'

describe('freedom contract: custom request body', () => {
  it('preserves unknown fields and deep-merges nested objects', () => {
    const base = {
      model: 'example-model',
      stream: true,
      thinking: { type: 'auto' },
    }

    const result = composeRequestBody(
      base,
      {
        thinking: { type: 'enabled', budget_tokens: 8192 },
        experimental_video_understanding: true,
        future_vendor_field: { nested: ['kept', 123] },
      },
      'merge',
    )

    expect(result).toEqual({
      model: 'example-model',
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 8192 },
      experimental_video_understanding: true,
      future_vendor_field: { nested: ['kept', 123] },
    })
  })

  it('uses null as a delete marker only in patch mode', () => {
    const base = {
      model: 'example-model',
      stream: true,
      max_tokens: 4096,
    }

    expect(
      composeRequestBody(base, { max_tokens: null, stream: false }, 'patch'),
    ).toEqual({ model: 'example-model', stream: false })

    expect(composeRequestBody(base, { max_tokens: null }, 'merge')).toEqual({
      model: 'example-model',
      stream: true,
      max_tokens: null,
    })
  })

  it('returns only the supplied body in raw mode', () => {
    const result = composeRequestBody(
      { model: 'ignored', stream: true },
      {
        model: 'manual-model',
        input: [{ type: 'experimental_media', value: 'opaque' }],
      },
      'raw',
    )

    expect(result).toEqual({
      model: 'manual-model',
      input: [{ type: 'experimental_media', value: 'opaque' }],
    })
  })

  it('keeps prototype-shaped JSON keys as ordinary own vendor fields', () => {
    const custom = JSON.parse(
      '{"__proto__":{"vendor":true},"constructor":{"prototype":{"future":1}}}',
    ) as Record<string, unknown>

    const result = composeRequestBody({ model: 'example' }, custom, 'merge')

    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true)
    expect(result.__proto__).toEqual({ vendor: true })
    expect(result.constructor).toEqual({ prototype: { future: 1 } })
    expect(({} as Record<string, unknown>).vendor).toBeUndefined()
  })
})
