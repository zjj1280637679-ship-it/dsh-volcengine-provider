import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CapturedRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: Uint8Array
  json?: unknown
}

export interface FakeArkResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | Uint8Array
}

export interface FakeArk {
  baseUrl: string
  requests: CapturedRequest[]
  enqueueResponse(response: FakeArkResponse): void
  close(): Promise<void>
}

function maybeParseJson(headers: IncomingHttpHeaders, body: Buffer): unknown {
  const rawContentType = headers['content-type']
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType
  if (body.byteLength === 0 || !contentType?.includes('application/json')) return undefined
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

export async function startFakeArk(): Promise<FakeArk> {
  const requests: CapturedRequest[] = []
  const responses: FakeArkResponse[] = []

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    requests.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: { ...request.headers },
      body: Uint8Array.from(body),
      json: maybeParseJson(request.headers, body),
    })

    const queued = responses.shift() ?? {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    }
    response.statusCode = queued.status ?? 200
    for (const [name, value] of Object.entries(queued.headers ?? {})) {
      response.setHeader(name, value)
    }
    if (queued.body instanceof Uint8Array) response.end(Buffer.from(queued.body))
    else response.end(queued.body ?? '')
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    enqueueResponse(response) {
      responses.push(response)
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
}
