import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, resolveRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VolcengineChatAdapter } from '../../src/chat/adapter.js'
import { normalizeTransportError } from '../../src/chat/errors.js'
import { sendArkJson } from '../../src/transport.js'

let server: Server | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  server?.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    if (server === undefined) return resolve()
    server.close(error => error ? reject(error) : resolve())
  })
  server = undefined
})

async function localAdapter(mode: 'before-headers' | 'empty-eof' | 'sse' | 'json' | 'http-error') {
  let requests = 0
  let activeResponse: ServerResponse | undefined
  server = createServer(async (request, response) => {
    for await (const _piece of request) { /* drain this one request */ }
    requests++
    activeResponse = response
    if (mode === 'before-headers') return request.socket.destroy()
    response.writeHead(mode === 'http-error' ? 503 : 200, {
      'content-type': mode === 'json' || mode === 'http-error' ? 'application/json' : 'text/event-stream',
    })
    response.flushHeaders()
    if (mode === 'empty-eof') return response.end()
    if (mode === 'json' || mode === 'http-error') response.write('{')
    else response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const adapter = new VolcengineChatAdapter({
    resolveConnection: () => ({ route: { kind: 'coding-plan', baseUrl, apiKeyEnv: 'TEST' }, apiKey: 'synthetic-local-key' }),
    fetchImpl: async (...args) => {
      const response = await fetch(...args)
      if (mode === 'json' || mode === 'http-error') activeResponse!.destroy()
      return response
    },
  })
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['ark-network-test'], adapter)
  return {
    requests: () => requests,
    disconnect: () => activeResponse!.destroy(),
    stream: (signal = AbortSignal.timeout(3000)) => ctx!.llm.stream({
      provider: 'ark-network-test', model: 'local-only', messages: [], signal,
    }),
  }
}

describe('network failures at the real Harness boundary', () => {
  it.each(['before-headers', 'empty-eof', 'sse', 'json', 'http-error'] as const)(
    'classifies %s interruption for host retry policy without adding adapter attempts', async mode => {
      const local = await localAdapter(mode)
      const chunks: StreamChunk[] = []
      for await (const chunk of local.stream()) {
        chunks.push(chunk)
        if (mode === 'sse' && chunk.type === 'text-delta') local.disconnect()
      }
      const finishes = chunks.filter(chunk => chunk.type === 'finish')
      expect(finishes).toHaveLength(1)
      expect(finishes[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } })
      expect(resolveRetryPolicy(undefined, 'network-test')).toMatchObject({
        mode: 'normal', retryableCodes: expect.arrayContaining(['TRANSPORT']),
      })
      expect(local.requests()).toBe(1)
      if (mode === 'sse') expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'partial' })
    },
  )

  it('keeps caller cancellation aborted after partial output', async () => {
    const local = await localAdapter('sse')
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    for await (const chunk of local.stream(controller.signal)) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') controller.abort(new Error('user stopped generation'))
    }
    expect(chunks.filter(chunk => chunk.type === 'finish')).toEqual([{
      type: 'finish', reason: { kind: 'aborted', failure: {
        code: 'ABORTED', message: 'Volcengine Ark request aborted by caller.',
      } },
    }])
    expect(local.requests()).toBe(1)
  })

  it('retains the original fetch cause and actionable network detail', async () => {
    const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    const original = new TypeError('fetch failed', { cause: socket })
    const fetchImpl = vi.fn(async () => { throw original })
    let caught: unknown
    try {
      await sendArkJson({
        route: { kind: 'standard', baseUrl: 'http://unused.invalid', apiKeyEnv: 'TEST' },
        operation: 'chat/completions', apiKey: 'synthetic', body: {}, fetchImpl,
      })
    } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'TRANSPORT', cause: original, message: expect.stringContaining('UND_ERR_SOCKET') })
    expect((caught as Error).cause).toBe(original)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps provider, malformed-request and redirect failures outside transient network classification', () => {
    for (const original of [
      new LlmError('provider says no', 'INVALID_REQUEST'),
      new TypeError('Converting circular structure to JSON'),
      new TypeError('Failed to parse URL from invalid'),
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    ]) expect(normalizeTransportError(original)).toBe(original)
  })
})
