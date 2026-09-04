export type RouteKind = 'standard' | 'agent-plan' | 'coding-plan'

export interface RouteProfile {
  kind: RouteKind
  baseUrl: string
  apiKeyEnv: string
}

function freezeRoute(route: RouteProfile): Readonly<RouteProfile> {
  return Object.freeze({ ...route })
}

export const DEFAULT_ROUTES = Object.freeze({
  standard: freezeRoute({
    kind: 'standard',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'ARK_STANDARD_API_KEY',
  }),
  'agent-plan': freezeRoute({
    kind: 'agent-plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKeyEnv: 'ARK_AGENT_PLAN_API_KEY',
  }),
  'coding-plan': freezeRoute({
    kind: 'coding-plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    apiKeyEnv: 'ARK_CODING_PLAN_API_KEY',
  }),
}) satisfies Readonly<Record<RouteKind, Readonly<RouteProfile>>>

/**
 * Return a caller-owned copy so runtime edits cannot mutate the shipped defaults.
 * Route selection is explicit and there is intentionally no fallback chain.
 */
export function getDefaultRoute(kind: RouteKind): RouteProfile {
  return { ...DEFAULT_ROUTES[kind] }
}

/** Join a route base URL and provider-relative operation without changing its path prefix. */
export function joinRouteUrl(route: Pick<RouteProfile, 'baseUrl'>, operation: string): string {
  const base = route.baseUrl.replace(/\/+$/u, '')
  const suffix = operation.replace(/^\/+/, '')
  return suffix.length === 0 ? base : `${base}/${suffix}`
}
