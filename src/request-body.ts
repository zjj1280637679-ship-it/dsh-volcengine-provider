export type RequestBody = Record<string, unknown>
export type RequestBodyMode = 'merge' | 'patch' | 'raw'

function isPlainObject(value: unknown): value is RequestBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownValue(target: RequestBody, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined
}

/**
 * Define a JSON field as an own data property. Ordinary bracket assignment is
 * intentionally avoided because a valid JSON key such as `__proto__` must be
 * preserved as data rather than invoking an inherited prototype setter.
 */
function setOwnValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  })
}

/**
 * Clone JSON containers while sharing immutable primitive values. In
 * particular, a generated base64 string is not serialized through
 * `structuredClone` merely because one unrelated custom field is merged.
 */
function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== 'object' || value === null) return value
  const source = value as object
  const existing = seen.get(source)
  if (existing !== undefined) return existing as T

  if (Array.isArray(value)) {
    const result = new Array<unknown>(value.length)
    seen.set(source, result)
    for (const [key, item] of Object.entries(value)) {
      setOwnValue(result, key, cloneValue(item, seen))
    }
    return result as T
  }

  if (isPlainObject(value)) {
    const result = Object.create(Object.getPrototypeOf(value)) as RequestBody
    seen.set(source, result)
    for (const [key, item] of Object.entries(value)) {
      setOwnValue(result, key, cloneValue(item, seen))
    }
    return result as T
  }

  // Non-JSON values are outside the wire contract, but retain the previous
  // structured-clone behavior until JSON.stringify decides their wire form.
  return structuredClone(value)
}

/**
 * Freedom-preserving deep merge:
 * - plain objects recurse
 * - arrays replace as a whole
 * - scalars replace
 * - unknown keys are retained verbatim as own properties
 */
export function deepMergeRequestBody(
  base: RequestBody,
  custom: RequestBody,
): RequestBody {
  const result = cloneValue(base)

  for (const [key, value] of Object.entries(custom)) {
    const current = ownValue(result, key)
    if (isPlainObject(current) && isPlainObject(value)) {
      setOwnValue(result, key, deepMergeRequestBody(current, value))
    } else {
      setOwnValue(result, key, cloneValue(value))
    }
  }

  return result
}

/** Patch mode uses null as an explicit delete marker. */
export function patchRequestBody(
  base: RequestBody,
  patch: RequestBody,
): RequestBody {
  const result = cloneValue(base)

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key]
      continue
    }

    const current = ownValue(result, key)
    if (isPlainObject(current) && isPlainObject(value)) {
      setOwnValue(result, key, patchRequestBody(current, value))
    } else {
      setOwnValue(result, key, cloneValue(value))
    }
  }

  return result
}

export function composeRequestBody(
  base: RequestBody,
  custom: RequestBody,
  mode: RequestBodyMode = 'merge',
): RequestBody {
  if (mode === 'raw') return cloneValue(custom)
  if (mode === 'patch') return patchRequestBody(base, custom)
  return deepMergeRequestBody(base, custom)
}
