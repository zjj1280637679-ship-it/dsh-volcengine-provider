import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'

import type { WireErrorBody } from './types.js'

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
  ].filter(value => value !== undefined && value !== null && String(value).length > 0)
  return fields.length > 0 ? fields.map(String).join(' ') : fallback
}

/** A successful HTTP status can still carry an Ark error, including inside SSE. */
export function providerResponseError(body: WireErrorBody): LlmError {
  const detail = providerDetail(body, 'provider returned an error without diagnostic detail')
  return new LlmError(`Volcengine Ark response failed: ${detail}`, 'PROVIDER_ERROR')
}

/** Map Ark HTTP failures onto the provider-neutral Harness routing taxonomy. */
export function httpErrorCode(
  status: number,
  parsed?: WireErrorBody,
): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = providerDetail(parsed, '')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(raw)
  if (!Number.isFinite(date)) return undefined
  const delay = date - now
  return delay > 0 ? delay : undefined
}

/** Convert a non-2xx Ark response into a structured Harness error without losing provider detail. */
export async function providerHttpError(response: Response): Promise<LlmError> {
  const text = await response.text()
  const parsed = parseErrorBody(text)
  const requestIdRaw = response.headers.get('x-request-id')
    ?? response.headers.get('x-tt-logid')
  const requestId = requestIdRaw === null || requestIdRaw.length === 0
    ? undefined
    : ProviderRequestId(requestIdRaw)
  const providerRetryAfterMs = retryAfterMs(response.headers)
  const fallback = text.length > 0 ? text.slice(0, 500) : `HTTP ${response.status}`
  const detail = providerDetail(parsed, fallback)
  const suffix = requestIdRaw === null || requestIdRaw.length === 0
    ? ''
    : ` (request ${requestIdRaw})`
  return new LlmError(
    `Volcengine Ark request failed: ${detail}${suffix}`,
    httpErrorCode(response.status, parsed),
    {
      status: response.status,
      ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
    },
  )
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new LlmError(
      `Volcengine Ark returned malformed JSON: ${text.slice(0, 120)}`,
      'MALFORMED_RESPONSE',
    )
  }
}
