import { describe, expect, it } from 'vitest'

import {
  asRecord,
  parseCustomBody,
  routeAt,
  routeChanges,
  validateModels,
  type DraftModelCard,
} from '../../src/client/draft.js'

describe('client settings draft', () => {
  it('reads a namespace-relative route and refuses array or inherited paths', () => {
    const route = { kind: 'standard', models: [] }
    expect(routeAt({ routes: { primary: route } }, ['routes', 'primary'])).toBe(route)
    expect(routeAt({ routes: [] }, ['routes', '0'])).toBeUndefined()
    expect(routeAt({}, ['constructor'])).toBeUndefined()
    expect(asRecord(null)).toEqual({})
    expect(asRecord([])).toEqual({})
  })

  it('accepts empty or arbitrary object request bodies and gives readable JSON errors', () => {
    expect(parseCustomBody('  ')).toBeUndefined()
    expect(parseCustomBody('{"future_vendor_option":{"values":[1,null,true]}}')).toEqual({
      future_vendor_option: { values: [1, null, true] },
    })
    for (const input of ['null', '[]', '7', '"text"']) {
      expect(() => parseCustomBody(input)).toThrow('必须是 JSON 对象')
    }
    expect(() => parseCustomBody('{')).toThrow('不是有效的 JSON')
  })

  it('requires nonempty distinct model IDs, including whitespace duplicates', () => {
    expect(validateModels([{ id: '  ' }])).toContain('模型 ID')
    expect(validateModels([{ id: 'model-a' }, { id: ' model-a ' }])).toContain('重复')
    expect(validateModels([{ id: 'model-a' }, { id: 'model-b' }])).toBeUndefined()
    expect(validateModels([])).toBeUndefined()
  })

  it('rejects numeric overflow at any depth without changing finite numbers or strings', () => {
    for (const text of [
      '{"limit":1e999}',
      '{"future":{"limit":-1e999}}',
      '{"future":[0,{"nested":[1e999]}]}',
    ]) {
      expect(() => parseCustomBody(text)).toThrow('数字必须为有限数')
    }
    expect(parseCustomBody('{"max":1e308,"min":-1e308,"text":"1e999"}')).toEqual({
      max: 1e308, min: -1e308, text: '1e999',
    })
  })

  it('allows omitted capacities and rejects invalid optional capacity values', () => {
    expect(validateModels([{ id: 'model-a', contextWindow: 131072, maxTokens: 8192 }])).toBeUndefined()
    expect(validateModels([{ id: 'model-a', contextWindow: undefined, maxTokens: undefined }])).toBeUndefined()
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      for (const value of [0, -1, 1.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(validateModels([{ id: 'model-a', [field]: value }])).toContain('必须为正整数')
      }
    }
  })

  it('writes only changed known fields and leaves unrelated route settings untouched', () => {
    const before = {
      kind: 'standard', name: 'Old', baseURL: 'https://example.test/v3',
      enabled: true, futureRouteSetting: { preserved: true }, models: [{ id: 'model-a' }],
    }
    expect(routeChanges(['routes', 'primary'], before, {
      name: 'New', enabled: true, futureRouteSetting: { preserved: false },
    })).toEqual([{ op: 'set', path: ['routes', 'primary', 'name'], value: 'New' }])
    expect(before.futureRouteSetting).toEqual({ preserved: true })
  })

  it('clears only an explicitly edited override', () => {
    expect(routeChanges(['routes', 'primary'], { name: 'Custom', baseURL: 'https://example.test' }, {
      name: undefined,
    })).toEqual([{ op: 'unset', path: ['routes', 'primary', 'name'] }])
  })

  it('preserves unknown model fields when replacing the models array and isolates the operation', () => {
    const original: DraftModelCard[] = [{
      id: 'model-a', name: 'Before', futureModelField: { values: ['keep', 42] },
      modalities: { video: 'force_enable' },
    }]
    const edited = structuredClone(original)
    edited[0]!.name = 'After'
    const changes = routeChanges(['routes', 'primary'], { models: original }, { models: edited })
    expect(changes).toEqual([{
      op: 'set', path: ['routes', 'primary', 'models'], value: [{
        id: 'model-a', name: 'After', futureModelField: { values: ['keep', 42] },
        modalities: { video: 'force_enable' },
      }],
    }])
    edited[0]!.name = 'Later'
    expect(changes[0]).toMatchObject({ value: [{ name: 'After' }] })
    expect(original[0]!.name).toBe('Before')
  })

  it('does not persist semantically unchanged JSON with reordered object keys', () => {
    const before = { models: [{ id: 'model-a', customBody: { a: 1, b: 2 } }] }
    expect(routeChanges(['routes', 'primary'], before, {
      models: [{ customBody: { b: 2, a: 1 }, id: 'model-a', name: undefined }],
    })).toEqual([])
  })
})
