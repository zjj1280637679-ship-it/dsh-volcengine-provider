import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'

import { VolcengineChatAdapter, type VolcengineChatConnection } from '../../src/chat/adapter.js'
import { createDefaultModelConfig } from '../../src/domain.js'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (cause: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function user(content: Message['content'], id = 'message'): Message {
  return { id, role: 'user', content, source: { kind: 'user' } } as unknown as Message
}

function video(id: string, bytes: number): ContentBlock {
  return {
    type: 'volcengine-video', attachment: { attachmentId: id, name: `${id}.mp4`, bytes }, mediaType: 'video/mp4',
  } as ContentBlock
}

function mediaMessage(id: string, bytes: number): Message {
  return user([video(id, bytes)] as Message['content'], `message-${id}`)
}

function toolMediaMessage(id: string, bytes: number): Message {
  return user([{
    type: 'tool-result', toolCallId: `call-${id}` as never, content: [video(id, bytes)],
  }] as Message['content'], `tool-${id}`)
}

function request(message: Message, signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'volcengine-test', model: 'seed-video', messages: [message], signal,
  } as GenerateOptions
}

function textRequest(id: string): GenerateOptions {
  return request(user([{ type: 'text', text: id }], `text-${id}`))
}

function completion(text = 'ok'): Response {
  return new Response(JSON.stringify({
    choices: [{ index: 0, message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { 'content-type': 'application/json' } })
}

function blockedCompletion(release: Promise<void>): Response {
  const encoded = new TextEncoder().encode(JSON.stringify({
    choices: [{ index: 0, message: { content: 'first' }, finish_reason: 'stop' }],
  }))
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      void release.then(() => {
        controller.enqueue(encoded)
        controller.close()
      })
    },
  }), { headers: { 'content-type': 'application/json' } })
}

async function collect(input: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of input) values.push(value)
  return values
}

const ampleMemory = () => ({
  heapHeadroomBytes: Number.MAX_SAFE_INTEGER,
  systemFreeBytes: Number.MAX_SAFE_INTEGER,
})

const route: VolcengineChatConnection['route'] = {
  kind: 'coding-plan', baseUrl: 'https://ark.example.test/api/v3', apiKeyEnv: 'TEST_KEY',
}

function adapter(options: {
  readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readonly resolveMediaBytes?: (block: Parameters<NonNullable<ConstructorParameters<typeof VolcengineChatAdapter>[0]['resolveMediaBytes']>>[0]) => Promise<Uint8Array>
  readonly connection?: Partial<VolcengineChatConnection>
  readonly memory?: () => { heapHeadroomBytes: number; systemFreeBytes: number }
}): VolcengineChatAdapter {
  return new VolcengineChatAdapter({
    resolveConnection: () => ({ route, apiKey: 'test-secret', ...options.connection }),
    resolveMediaBytes: options.resolveMediaBytes,
    fetchImpl: options.fetchImpl as typeof fetch,
    inspectMediaRuntimeMemory: options.memory ?? ampleMemory,
  })
}

describe('process-wide media runtime admission', () => {
  it('serializes media encoding through response headers, then releases before reading the response body', async () => {
    const firstFetchEntered = deferred<void>()
    const secondFetchEntered = deferred<void>()
    const firstHeaders = deferred<Response>()
    const firstBody = deferred<void>()
    let fetchCalls = 0
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      fetchCalls++
      if (fetchCalls === 1) {
        firstFetchEntered.resolve()
        return firstHeaders.promise
      }
      secondFetchEntered.resolve()
      return completion('second')
    })
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({ fetchImpl, resolveMediaBytes })

    let firstSettled = false
    const first = collect(target.stream(request(mediaMessage('first', 1))))
      .finally(() => { firstSettled = true })
    await firstFetchEntered.promise
    const second = collect(target.stream(request(mediaMessage('second', 1))))
    await Promise.resolve()
    expect(resolveMediaBytes).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    firstHeaders.resolve(blockedCompletion(firstBody.promise))
    await secondFetchEntered.promise
    expect(resolveMediaBytes).toHaveBeenCalledTimes(2)
    expect(firstSettled).toBe(false)
    firstBody.resolve()
    await Promise.all([first, second])
  })

  it('does not serialize requests that contain no generated media', async () => {
    const bothEntered = deferred<void>()
    const responses = [deferred<Response>(), deferred<Response>()]
    let calls = 0
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      const index = calls++
      if (calls === 2) bothEntered.resolve()
      return responses[index]!.promise
    })
    const target = adapter({ fetchImpl })
    const first = collect(target.stream(textRequest('first')))
    const second = collect(target.stream(textRequest('second')))
    await bothEntered.promise
    responses[0]!.resolve(completion('first'))
    responses[1]!.resolve(completion('second'))
    await Promise.all([first, second])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('lets a queued media request be cancelled without resolving or fetching its attachment', async () => {
    const firstFetchEntered = deferred<void>()
    const firstHeaders = deferred<Response>()
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      firstFetchEntered.resolve()
      return firstHeaders.promise
    })
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({ fetchImpl, resolveMediaBytes })
    const first = collect(target.stream(request(mediaMessage('first', 1))))
    await firstFetchEntered.promise

    const controller = new AbortController()
    const second = collect(target.stream(request(mediaMessage('cancelled', 1), controller.signal)))
    await Promise.resolve()
    controller.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(resolveMediaBytes).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    firstHeaders.resolve(completion('first'))
    await first
  })

  it('rejects insufficient live memory before resolving media or starting fetch', async () => {
    const fetchImpl = vi.fn(async () => completion())
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({
      fetchImpl,
      resolveMediaBytes,
      memory: () => ({ heapHeadroomBytes: 8, systemFreeBytes: 8 }),
    })
    await expect(collect(target.stream(request(mediaMessage('too-large-for-current-memory', 10)))))
      .rejects.toMatchObject({ code: 'MEDIA_RESOURCE_EXHAUSTED' })
    expect(resolveMediaBytes).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a combined media encoding beyond Node string representability before reading', async () => {
    const fetchImpl = vi.fn(async () => completion())
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({ fetchImpl, resolveMediaBytes })
    const combined = user([
      video('large-one', 300_000_000),
      video('large-two', 300_000_000),
    ] as Message['content'])
    await expect(collect(target.stream(request(combined))))
      .rejects.toMatchObject({ code: 'MEDIA_SIZE_UNREPRESENTABLE' })
    expect(resolveMediaBytes).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not put tool image/video omitted by the fallback budget behind the media gate', async () => {
    const firstFetchEntered = deferred<void>()
    const firstHeaders = deferred<Response>()
    const secondFetchEntered = deferred<void>()
    let calls = 0
    let secondBody = ''
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls++
      if (calls === 1) {
        firstFetchEntered.resolve()
        return firstHeaders.promise
      }
      secondBody = String(init?.body)
      secondFetchEntered.resolve()
      return completion('tool fallback')
    })
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({ fetchImpl, resolveMediaBytes })
    const first = collect(target.stream(request(mediaMessage('first', 1))))
    await firstFetchEntered.promise

    const omitted = collect(target.stream(request(toolMediaMessage('omitted', 45_000_001))))
    await secondFetchEntered.promise
    expect(resolveMediaBytes).toHaveBeenCalledTimes(1)
    expect(secondBody).toContain('TOOL_MEDIA_BUDGET_EXCEEDED')
    firstHeaders.resolve(completion('first'))
    await Promise.all([first, omitted])
  })

  it('counts tool media when zero disables omission', async () => {
    const firstFetchEntered = deferred<void>()
    const firstHeaders = deferred<Response>()
    let calls = 0
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      calls++
      if (calls === 1) {
        firstFetchEntered.resolve()
        return firstHeaders.promise
      }
      return completion('tool media')
    })
    const config = createDefaultModelConfig()
    config.agentMediaFallbackMB = 0
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({ fetchImpl, resolveMediaBytes, connection: { modelConfig: config } })
    const first = collect(target.stream(request(mediaMessage('first', 1))))
    await firstFetchEntered.promise
    const second = collect(target.stream(request(toolMediaMessage('included', 1))))
    await Promise.resolve()
    expect(resolveMediaBytes).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    firstHeaders.resolve(completion('first'))
    await Promise.all([first, second])
    expect(resolveMediaBytes).toHaveBeenCalledTimes(2)
  })

  it('does not inspect or read generated messages when raw mode replaces the body', async () => {
    let sent = ''
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      sent = String(init?.body)
      return completion('raw')
    })
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({
      fetchImpl,
      resolveMediaBytes,
      memory: () => ({ heapHeadroomBytes: 0, systemFreeBytes: 0 }),
      connection: {
        customBodyMode: 'raw',
        customBody: { model: 'raw-model', messages: [{ role: 'user', content: 'manual' }], stream: false },
      },
    })
    await collect(target.stream(request(mediaMessage('ignored-by-raw', Number.MAX_SAFE_INTEGER))))
    expect(resolveMediaBytes).not.toHaveBeenCalled()
    expect(JSON.parse(sent)).toEqual({
      model: 'raw-model', messages: [{ role: 'user', content: 'manual' }], stream: false,
    })
  })

  it('does not read generated media when merge mode replaces the messages field', async () => {
    let sent = ''
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      sent = String(init?.body)
      return completion('custom messages')
    })
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({
      fetchImpl,
      resolveMediaBytes,
      memory: () => ({ heapHeadroomBytes: 0, systemFreeBytes: 0 }),
      connection: {
        customBodyMode: 'merge',
        customBody: { messages: [{ role: 'user', content: 'custom replacement' }], stream: false },
      },
    })
    await collect(target.stream(request(mediaMessage('replaced-by-custom-messages', Number.MAX_SAFE_INTEGER))))
    expect(resolveMediaBytes).not.toHaveBeenCalled()
    expect(JSON.parse(sent)).toMatchObject({
      messages: [{ role: 'user', content: 'custom replacement' }], stream: false,
    })
  })

  it('admits direct user media above the retired 8 MiB transport limit when live resources suffice', async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 257)
    bytes[0] = 1
    bytes[bytes.length - 1] = 2
    const fetchImpl = vi.fn(async () => completion('large accepted'))
    const resolveMediaBytes = vi.fn(async () => bytes)
    const target = adapter({ fetchImpl, resolveMediaBytes })
    await collect(target.stream(request(mediaMessage('large-direct', bytes.byteLength))))
    expect(resolveMediaBytes).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
  }, 30_000)

  it('releases the media slot when serialization or fetch fails', async () => {
    const firstFetchEntered = deferred<void>()
    const firstFailure = deferred<Response>()
    const secondFetchEntered = deferred<void>()
    let calls = 0
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      calls++
      if (calls === 1) {
        firstFetchEntered.resolve()
        return firstFailure.promise
      }
      secondFetchEntered.resolve()
      return completion('recovered')
    })
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({ fetchImpl, resolveMediaBytes })
    const first = collect(target.stream(request(mediaMessage('failed', 1))))
    await firstFetchEntered.promise
    const second = collect(target.stream(request(mediaMessage('after-failure', 1))))
    await Promise.resolve()
    expect(resolveMediaBytes).toHaveBeenCalledTimes(1)
    firstFailure.reject(new Error('synthetic network failure'))
    await expect(first).rejects.toThrow('synthetic network failure')
    await secondFetchEntered.promise
    await second
    expect(resolveMediaBytes).toHaveBeenCalledTimes(2)
  })

  it('rejects unsafe attachment declarations before resolver or fetch', async () => {
    const fetchImpl = vi.fn(async () => completion())
    const resolveMediaBytes = vi.fn(async () => Uint8Array.of(1))
    const target = adapter({ fetchImpl, resolveMediaBytes })
    for (const [id, bytes] of [
      ['negative', -1], ['fractional', 1.5], ['not-a-number', Number.NaN],
      ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      await expect(collect(target.stream(request(mediaMessage(id, bytes)))))
        .rejects.toMatchObject({ code: 'INVALID_MEDIA_REFERENCE' })
    }
    expect(resolveMediaBytes).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
