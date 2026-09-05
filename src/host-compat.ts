/** Runtime capability checks for Host services that evolve independently. */

export const CORE_LLM_CAPABILITIES = [
  'registerAdapter',
  'listProviders',
] as const

export const DIRECTORY_LLM_CAPABILITIES = [
  'registerConfigurableProviders',
  'listConfigurableProviders',
] as const

export const DISCOVERY_LLM_CAPABILITIES = [
  'registerModelDiscovery',
] as const

export interface LlmHostCapabilities {
  /** Minimum adapter registry needed to serve statically configured routes. */
  core: boolean
  /** Optional provider directory used by model-settings surfaces. */
  directory: boolean
  /** Optional endpoint-backed model discovery registration. */
  discovery: boolean
  /** Exact missing method names, suitable for a credential-free diagnostic. */
  missing: readonly string[]
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

export function hasMethods<const T extends readonly string[]>(
  value: unknown,
  names: T,
): value is Record<T[number], (...args: never[]) => unknown> {
  return isObject(value) && names.every(name => typeof value[name] === 'function')
}

/** Inspect public LLM services by behavior instead of a Harness package version. */
export function inspectLlmHost(value: unknown): LlmHostCapabilities {
  const groups = [CORE_LLM_CAPABILITIES, DIRECTORY_LLM_CAPABILITIES, DISCOVERY_LLM_CAPABILITIES]
  const missing = groups.flatMap(group => group.filter(name => !hasMethods(value, [name])))
  return {
    core: hasMethods(value, CORE_LLM_CAPABILITIES),
    directory: hasMethods(value, DIRECTORY_LLM_CAPABILITIES),
    discovery: hasMethods(value, DISCOVERY_LLM_CAPABILITIES),
    missing,
  }
}

export interface SlotRegistryLike {
  inject(name: string, register: () => () => void): void
  register(options: object, component: unknown): () => void
}

/** Slots are optional presentation capabilities; their absence must not break Host boot. */
export function hasSlotRegistry(value: unknown): value is SlotRegistryLike {
  return hasMethods(value, ['inject', 'register'])
}
