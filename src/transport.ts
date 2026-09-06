import type { RequestBody } from './request-body.js'
import { joinRouteUrl, type RouteProfile } from './routes.js'
import { normalizeTransportError } from './chat/errors.js'

export interface ArkTransportCommon {
  route: RouteProfile
  operation: string
  apiKey: string
  headers?: HeadersInit
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface ArkJsonRequest extends ArkTransportCommon {
  body: RequestBody
}

export interface ArkBinaryRequest extends ArkTransportCommon {
  body: Uint8Array
  contentType: string
}

function requestHeaders(
  apiKey: string,
  contentType: string | undefined,
  additional?: HeadersInit,
): Headers {
  const headers = new Headers(additional)
  // Credentials and wire content type are transport-owned and cannot be
  // accidentally replaced by optional attribution/diagnostic headers.
  headers.set('authorization', `Bearer ${apiKey}`)
  if (contentType !== undefined) headers.set('content-type', contentType)
  return headers
}

async function fetchArk(request: ArkTransportCommon, init: RequestInit): Promise<Response> {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch
  try {
    return await fetchImpl(joinRouteUrl(request.route, request.operation), init)
  } catch (cause) {
    throw normalizeTransportError(cause, request.signal)
  }
}

/**
 * One explicit provider attempt. This function intentionally performs no retry
 * and has no knowledge of any other Route, so a Coding Plan failure cannot
 * silently become a Standard Ark request.
 */
export async function sendArkJson(request: ArkJsonRequest): Promise<Response> {
  return fetchArk(request, {
    method: 'POST',
    headers: requestHeaders(request.apiKey, 'application/json', request.headers),
    body: JSON.stringify(request.body),
    redirect: 'error',
    signal: request.signal,
  })
}

/** One-attempt authenticated GET, used for advisory model discovery only. */
export async function sendArkGet(request: ArkTransportCommon): Promise<Response> {
  return fetchArk(request, {
    method: 'GET',
    headers: requestHeaders(request.apiKey, undefined, request.headers),
    redirect: 'error',
    signal: request.signal,
  })
}

/**
 * Verbatim binary transport primitive for provider upload/file APIs. It does
 * not resize, transcode, sample, inspect, or otherwise transform the bytes.
 */
export async function sendArkBytes(request: ArkBinaryRequest): Promise<Response> {
  return fetchArk(request, {
    method: 'POST',
    headers: requestHeaders(request.apiKey, request.contentType, request.headers),
    body: Buffer.from(request.body),
    redirect: 'error',
    signal: request.signal,
  })
}
