import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  type LlmFailure,
} from '@deepseek-ai/dsh-llm'

import type { WireErrorBody } from './types.js'

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
])

/** Classify only transport failures; configuration, parsing and provider errors keep their owner. */
export function normalizeTransportError(cause: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
    return new LlmError('Volcengine Ark request aborted by caller.', 'ABORTED', { cause })
  }
  if (cause instanceof LlmError) return cause

  const seen = new Set<Error>()
  const details: string[] = []
  let current = cause
  let networkFailure = false
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const code = (current as Error & { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) networkFailure = true
    const detail = typeof code === 'string' ? `${current.message} (${code})` : current.message
    if (detail.length > 0 && !details.includes(detail)) details.push(detail)
    // Fetch implementations may omit their native cause. Do not apply this
    // fallback to errors with a cause: a rejected redirect or URL is not a
    // transient network failure even when fetch uses the same outer message.
    if (current.cause === undefined && current instanceof TypeError
      && ['fetch failed', 'Failed to fetch', 'terminated'].includes(current.message)) networkFailure = true
    current = current.cause
  }
  return networkFailure
    ? new LlmError(`Volcengine Ark transport failed: ${details.join(': ')}`, 'TRANSPORT', { cause })
    : cause
}

function parseErrorBody(text: string): WireErrorBody | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null ? value as WireErrorBody : undefined
  } catch {
    return undefined
  }
}

function providerDetail(parsed: WireErrorBody | undefined, fallback: string): string {
  const fields = [
    parsed?.error?.code,
    parsed?.error?.type,
    parsed?.error?.message,
    parsed?.code,
    parsed?.message,
  ].filter(value => (typeof value === 'string' && value.length > 0) || typeof value === 'number')
  return fields.length > 0 ? fields.map(String).join(' ') : fallback
}

/** Explicit provider diagnostics have the same meaning in HTTP and in-band responses. */
function providerDiagnosticCode(body?: WireErrorBody): string | undefined {
  const detail = providerDetail(body, '')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  // Ark appends a specific limit after RateLimitExceeded (for example .EndpointRPMExceeded).
  const codes = [body?.error?.code, body?.error?.type, body?.code]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.split('.')[0]!.replace(/[\s_-]/gu, '').toLowerCase())
  if (codes.some(code => ['ratelimit', 'ratelimiterror', 'ratelimitexceeded'].includes(code))) return 'RATE_LIMIT'
  return undefined
}

type ProviderResponse = Pick<Response, 'status' | 'headers'>

function responseFacts(response?: ProviderResponse): Pick<LlmFailure, 'status' | 'requestId' | 'providerRetryAfterMs'> {
  if (response === undefined) return {}
  const requestIdRaw = response.headers.get('x-request-id') || response.headers.get('x-tt-logid')
  const providerRetryAfterMs = retryAfterMs(response.headers)
  return {
    status: response.status,
    ...(requestIdRaw ? { requestId: ProviderRequestId(requestIdRaw) } : {}),
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
  }
}

/** A successful HTTP status can still carry an Ark error, including inside SSE. */
export function providerResponseError(body: WireErrorBody, response?: ProviderResponse): LlmError {
  const detail = providerDetail(body, 'provider returned an error without diagnostic detail')
  const facts = responseFacts(response)
  const suffix = facts.requestId === undefined ? '' : ` (request ${facts.requestId})`
  return new LlmError(
    `Volcengine Ark response failed: ${detail}${suffix}`,
    providerDiagnosticCode(body) ?? 'PROVIDER_ERROR',
    facts,
  )
}

/** Map Ark HTTP failures onto the provider-neutral Harness routing taxonomy. */
export function httpErrorCode(
  status: number,
  parsed?: WireErrorBody,
): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const diagnostic = providerDiagnosticCode(parsed)
  if (diagnostic !== undefined) return diagnostic
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds * 1000) && seconds > 0) return seconds * 1000
  const date = Date.parse(raw)
  if (!Number.isFinite(date)) return undefined
  const delay = date - now
  return delay > 0 ? delay : undefined
}

/** Convert a non-2xx Ark response into a structured Harness error without losing provider detail. */
export async function providerHttpError(response: Response, signal?: AbortSignal): Promise<LlmError> {
  const text = await readResponseText(response, signal)
  const parsed = parseErrorBody(text)
  const facts = responseFacts(response)
  const fallback = text.length > 0 ? text.slice(0, 500) : `HTTP ${response.status}`
  const detail = providerDetail(parsed, fallback)
  const suffix = facts.requestId === undefined ? '' : ` (request ${facts.requestId})`
  return new LlmError(
    `Volcengine Ark request failed: ${detail}${suffix}`,
    httpErrorCode(response.status, parsed),
    facts,
  )
}

async function readResponseText(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    return await response.text()
  } catch (cause) {
    throw normalizeTransportError(cause, signal)
  }
}

export async function parseJsonResponse<T>(response: Response, signal?: AbortSignal): Promise<T> {
  const text = await readResponseText(response, signal)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new LlmError(
      `Volcengine Ark returned malformed JSON: ${text.slice(0, 120)}`,
      'MALFORMED_RESPONSE',
    )
  }
}
