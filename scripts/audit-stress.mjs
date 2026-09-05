// Reproducible bounded local audit. No supplier endpoint, real key, or automatic retry.
// Run: pnpm build && node --expose-gc scripts/audit-stress.mjs
// Add --after-fix-output to preserve the original audit evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildMediaContent, createDefaultModelConfig, VolcengineChatAdapter } from '../dist/index.js'

const MAX_REQUESTS = 150
const followupOnly = process.argv.includes('--followup-only')
const partialErrorOnly = process.argv.includes('--inband-partial-only')
const afterFixOutput = process.argv.includes('--after-fix-output')
const KEY = 'local-audit-not-a-provider-credential'
const report = {
  timestamp: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version,
  transport: 'real Node HTTP + fetch on 127.0.0.1, production built VolcengineChatAdapter',
  externalRequests: 0,
  credential: 'fixed synthetic local-only value',
  limits: { maxRequests: MAX_REQUESTS, textConcurrency: 8, textRequests: 48, mediaConcurrency: 3, mediaBytesEach: 8 * 1024 * 1024 },
  cases: [],
}
const sha = value => createHash('sha256').update(value).digest('hex')
report.distSha256 = sha(await readFile(new URL('../dist/index.js', import.meta.url)))
const requests = []
const inspections = new Map()
const activeResponses = new Map()
const serverErrors = []
let peakRss = process.memoryUsage().rss
const sampleMemory = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }
const memoryTimer = setInterval(sampleMemory, 10)
const event = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\r\n\r\n`
const chunk = (content, finish = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })
const complete = text => event(chunk(text)) + event(chunk('', 'stop')) + event('[DONE]')

const server = createServer(async (req, res) => {
  const number = requests.length + 1
  const record = { number, path: req.url, method: req.method, bytes: 0, model: null, status: null }
  requests.push(record)
  if (number > MAX_REQUESTS) { res.writeHead(503).end('local audit request budget exceeded'); return }
  try {
    const buffers = []
    for await (const buffer of req) {
      record.bytes += buffer.length
      if (record.bytes > 48 * 1024 * 1024) throw new Error('local audit body budget exceeded')
      buffers.push(buffer)
    }
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8'))
    buffers.length = 0
    record.model = body.model
    assert.equal(req.headers.authorization, `Bearer ${KEY}`)
    assert.equal(req.url, '/api/coding/v3/chat/completions')
    const model = body.model
    activeResponses.set(model, res)
    res.on('close', () => {
      const inspection = inspections.get(model)
      if (inspection) inspection.responseClosed = true
    })
    const send = (value, status = 200, type = 'text/event-stream', headers = {}) => {
      record.status = status
      res.writeHead(status, { 'content-type': type, ...headers }).end(value)
    }
    if (model.startsWith('concurrent-')) {
      const payload = Buffer.from(': keep-alive\r\n\r\n' + complete(`你好🌋e\u0301—${model}`))
      record.status = 200
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // A flush between individual bytes deliberately splits UTF-8 and SSE delimiters.
      for (const byte of payload) { res.write(Buffer.from([byte])); await nextTick() }
      res.end()
    } else if (model === 'truncated-sse') {
      send(event(chunk('partial-before-close')))
    } else if (model === 'socket-disconnect') {
      record.status = 200
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(event(chunk('partial-before-reset')))
      await delay(25)
      res.destroy()
    } else if (model === 'headers-timeout') {
      record.status = 'deliberately-no-response'
    } else if (model === 'stream-cancel') {
      record.status = 200
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(event(chunk('before-cancel')))
    } else if (model === 'idle-without-signal') {
      inspections.set(model, { responseClosed: false })
      record.status = 200
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': headers and heartbeat, deliberately no model content\n\n')
    } else if (model === 'consumer-break') {
      inspections.set(model, { responseClosed: false })
      record.status = 200
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(event(chunk('first-content')))
    } else if (model === 'stream-error-event') {
      send(event({ error: { code: 'local_stream_error', message: 'controlled upstream stream failure' } }) + event('[DONE]'))
    } else if (model === 'partial-stream-error-event') {
      send(event(chunk('partial-before-upstream-error')) + event({ error: { code: 'local_partial_stream_error', message: 'controlled failure after partial content' } }) + event('[DONE]'))
    } else if (model === 'http-429') {
      send(JSON.stringify({ error: { code: 'rate_limit', message: 'local controlled rate limit' } }), 429, 'application/json', { 'retry-after': '2', 'x-request-id': 'local-429' })
    } else if (model === 'http-503') {
      send(JSON.stringify({ error: { message: 'local controlled unavailable' } }), 503, 'application/json', { 'retry-after': '1', 'x-request-id': 'local-503' })
    } else if (model === 'http-413') {
      send(JSON.stringify({ error: { message: 'local controlled payload limit' } }), 413, 'application/json')
    } else if (model === 'redirect') {
      send('', 307, 'text/plain', { location: '/must-not-follow' })
    } else if (model === 'bad-json') {
      send('{broken json', 200, 'application/json')
    } else if (model === 'bad-sse-json') {
      send(event('{broken json') + event('[DONE]'))
    } else if (model === 'json-null') {
      send('null', 200, 'application/json')
    } else if (model === 'sse-null') {
      send(event('null') + event('[DONE]'))
    } else if (model === 'empty-completion') {
      send(event(chunk('', 'stop')) + event('[DONE]'))
    } else if (model === 'missing-finish-reason') {
      send(event(chunk('partial-without-finish')) + event('[DONE]'))
    } else if (model === 'multiple-choices') {
      inspections.set(model, { requestedN: body.n })
      send(event({ choices: [
        { index: 0, delta: { content: 'first-choice' }, finish_reason: null },
        { index: 1, delta: { content: 'second-choice' }, finish_reason: null },
      ] }) + event({ choices: [
        { index: 0, delta: {}, finish_reason: 'stop' },
        { index: 1, delta: {}, finish_reason: 'stop' },
      ] }) + event('[DONE]'))
    } else if (model === 'tool-round-1') {
      inspections.set(model, { toolNames: body.tools?.map(tool => tool.function.name) })
      send(event({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call-a', type: 'function', function: { name: 'sum', arguments: '{"a":' } },
        { index: 1, id: 'call-b', type: 'function', function: { name: 'echo', arguments: '{"text":"你' } },
      ] } }] }) + event({ choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: '好🌋"}' } },
        { index: 0, function: { arguments: '2,"b":3}' } },
      ] }, finish_reason: 'tool_calls' }] }) + event('[DONE]'))
    } else if (model === 'tool-round-2') {
      inspections.set(model, {
        roles: body.messages.map(message => message.role),
        assistantCalls: body.messages.find(message => message.role === 'assistant')?.tool_calls,
        results: body.messages.filter(message => message.role === 'tool'),
      })
      send(complete('sum=5; echo=你好🌋'))
    } else if (model.startsWith('media-')) {
      const part = body.messages[0].content[0]
      const encoded = part.type === 'input_audio' ? part.input_audio.data : part[part.type].url.split(',')[1]
      const decoded = Buffer.from(encoded, 'base64')
      inspections.set(model, { type: part.type, bytes: decoded.length, sha256: sha(decoded), format: part.input_audio?.format })
      sampleMemory()
      send(complete(`received-${decoded.length}`))
    } else {
      throw new Error(`Unrecognized local case: ${model}`)
    }
  } catch (error) {
    if (error?.code !== 'ECONNRESET') serverErrors.push({ model: record.model, name: error.name, message: error.message.slice(0, 300) })
    if (!res.headersSent) res.writeHead(500)
    res.end('local audit handler failed')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/api/coding/v3`
const route = { kind: 'coding-plan', baseUrl, apiKeyEnv: 'LOCAL_AUDIT_ONLY' }
function adapter(extra = {}) {
  const { connection = {}, ...options } = extra
  return new VolcengineChatAdapter({
    resolveConnection: () => ({ route, apiKey: KEY, ...connection }),
    fetchImpl: (input, init) => {
      assert.equal(String(input), `${baseUrl}/chat/completions`)
      return fetch(input, init)
    },
    ...options,
  })
}
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const options = (model, extra = {}) => ({ provider: 'local-audit', model, messages: [user('local bounded diagnostic')], signal: AbortSignal.timeout(10_000), ...extra })
function facts(error) {
  return {
    name: error?.name ?? 'UnknownError', code: error?.code ?? null,
    message: String(error?.message ?? error).split(KEY).join('[REDACTED]').slice(0, 500),
    ...(error?.failure ? { failure: error.failure } : {}),
  }
}
async function collect(iterable) {
  const result = { text: '', reasoning: '', blocks: [], finish: null, error: null }
  try {
    for await (const value of iterable) {
      if (value.type === 'text-delta') result.text += value.text
      if (value.type === 'reasoning-delta') result.reasoning += value.text
      if (value.type === 'block-end') result.blocks.push(value.block)
      if (value.type === 'finish') result.finish = value.reason
    }
  } catch (error) { result.error = facts(error) }
  return result
}
async function scenario(name, test) {
  const started = performance.now()
  const before = requests.length
  const result = { name, status: 'pass', requests: 0, elapsedMs: 0 }
  try { await test(result) } catch (error) { result.status = 'fail'; result.assertion = facts(error) }
  result.requests = requests.length - before
  result.elapsedMs = Math.round((performance.now() - started) * 100) / 100
  sampleMemory()
  report.cases.push(result)
  console.log(`${result.status.toUpperCase()} ${name}: ${result.requests} requests, ${result.elapsedMs} ms`)
}

try {
  if (!followupOnly && !partialErrorOnly) {
  await scenario('48 SSE requests / concurrency 8 / bytewise UTF-8 and CRLF', async result => {
    const durations = []
    let next = 0
    let completed = 0
    const client = adapter()
    const workers = Array.from({ length: 8 }, async () => {
      while (next < 48) {
        const id = next++
        const model = `concurrent-${id}`
        const started = performance.now()
        const observed = await collect(client.stream(options(model)))
        assert.equal(observed.error, null)
        assert.equal(observed.text, `你好🌋e\u0301—${model}`)
        assert.equal(observed.finish?.kind, 'stop')
        durations.push(performance.now() - started)
        completed++
      }
    })
    const settled = await Promise.allSettled(workers)
    result.completed = completed
    durations.sort((a, b) => a - b)
    result.latencyMs = { min: durations[0], p50: durations[Math.floor(durations.length * 0.5)], p95: durations[Math.floor(durations.length * 0.95)], max: durations.at(-1) }
    for (const worker of settled) if (worker.status === 'rejected') throw worker.reason
    assert.equal(completed, 48)
  })

  for (const [model, expected] of [
    ['truncated-sse', 'STREAM_CLOSED'], ['socket-disconnect', null],
    ['bad-json', 'MALFORMED_RESPONSE'], ['bad-sse-json', 'MALFORMED_RESPONSE'],
    ['http-429', 'RATE_LIMIT'], ['http-503', 'SERVER'], ['http-413', 'INVALID_REQUEST'], ['redirect', null],
  ]) {
    await scenario(`${model}: rejected without self-retry`, async result => {
      const before = requests.length
      result.observed = await collect(adapter().stream(options(model)))
      assert.ok(result.observed.error, 'expected a transport/protocol error')
      if (expected) assert.equal(result.observed.error.code, expected)
      assert.notEqual(result.observed.finish?.kind, 'stop')
      if (model === 'http-429') {
        assert.equal(result.observed.error.failure?.providerRetryAfterMs, 2000)
        assert.equal(result.observed.error.failure?.requestId, 'local-429')
      }
      if (model === 'http-503') assert.equal(result.observed.error.failure?.providerRetryAfterMs, 1000)
      await delay(75)
      assert.equal(requests.length - before, 1)
    })
  }

  await scenario('caller deadline while waiting for response headers', async result => {
    result.observed = await collect(adapter().stream(options('headers-timeout', { signal: AbortSignal.timeout(150) })))
    assert.ok(result.observed.error)
    assert.notEqual(result.observed.finish?.kind, 'stop')
  })
  await scenario('caller cancellation after first SSE content', async result => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 150)
    result.observed = await collect(adapter().stream(options('stream-cancel', { signal: controller.signal })))
    clearTimeout(timer)
    assert.equal(result.observed.text, 'before-cancel')
    assert.ok(result.observed.error)
    assert.notEqual(result.observed.finish?.kind, 'stop')
  })
  await scenario('pre-aborted call performs no HTTP request', async result => {
    const controller = new AbortController()
    controller.abort()
    const before = requests.length
    result.observed = await collect(adapter().stream(options('must-never-send', { signal: controller.signal })))
    assert.ok(result.observed.error)
    assert.equal(requests.length, before)
  })
  await scenario('empty completion is not reported as success', async result => {
    result.observed = await collect(adapter().stream(options('empty-completion')))
    assert.equal(result.observed.finish?.kind, 'error')
    assert.equal(result.observed.finish?.failure?.code, 'EMPTY_RESPONSE')
  })

  // Deliberately strict boundary expectations: failures are findings, not patched over.
  for (const model of ['json-null', 'sse-null']) {
    await scenario(`${model}: provider shape errors stay structured`, async result => {
      result.observed = await collect(adapter().stream(options(model)))
      assert.equal(result.observed.error?.code, 'MALFORMED_RESPONSE', 'unexpected provider JSON type must not escape as unclassified TypeError')
    })
  }
  await scenario('SSE content without finish_reason must not claim normal stop', async result => {
    result.observed = await collect(adapter().stream(options('missing-finish-reason')))
    assert.notEqual(result.observed.finish?.kind, 'stop', 'DONE alone does not prove the model supplied a completion reason')
  })
  await scenario('custom n=2 keeps separate choices or explicitly rejects unsupported choice count', async result => {
    result.observed = await collect(adapter({ connection: { customBody: { n: 2 } } }).stream(options('multiple-choices')))
    result.request = inspections.get('multiple-choices')
    assert.equal(result.request.requestedN, 2)
    assert.ok(result.observed.error || ['first-choice', 'second-choice'].includes(result.observed.text), 'two alternatives must not be silently concatenated into one assistant answer')
  })

  await scenario('real published Harness LlmRuntime: interleaved two-tool call and second model round', async result => {
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['local-audit'], adapter())
      const tools = [
        { name: 'sum', description: 'sum local integers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
        { name: 'echo', description: 'echo local unicode', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      ]
      const initial = [user('Add 2 and 3, and echo 你好🌋 using tools.')]
      const first = await collect(ctx.llm.stream(options('tool-round-1', { messages: initial, tools })))
      result.first = first
      assert.equal(first.error, null)
      assert.equal(first.finish?.kind, 'tool-calls')
      assert.deepEqual(first.blocks.map(block => [block.id, block.name]), [['call-a', 'sum'], ['call-b', 'echo']])
      const replies = first.blocks.map(block => {
        const arguments_ = JSON.parse(block.arguments)
        const output = block.name === 'sum' ? String(arguments_.a + arguments_.b) : arguments_.text
        return createToolResultMessage({ callId: block.id, content: [{ type: 'text', text: output }], isError: false })
      })
      const history = [...initial, createAssistantMessage({ content: first.blocks, source: { provider: 'local-audit', model: 'tool-round-1' } }), ...replies]
      const second = await collect(ctx.llm.stream(options('tool-round-2', { messages: history, tools })))
      result.second = second
      result.wire = inspections.get('tool-round-2')
      assert.equal(second.error, null)
      assert.equal(second.text, 'sum=5; echo=你好🌋')
      assert.deepEqual(result.wire.roles, ['user', 'assistant', 'tool', 'tool'])
      assert.deepEqual(result.wire.results.map(item => [item.tool_call_id, item.content]), [['call-a', '5'], ['call-b', '你好🌋']])
      result.scope = 'real LlmRuntime and production adapter; tool execution is controlled local code, not a full Agent loop'
    } finally { await ctx.fiber.dispose() }
  })

  global.gc?.()
  const beforeMedia = process.memoryUsage().rss
  peakRss = beforeMedia
  await scenario('3 concurrent 8 MiB opaque media payloads survive exact-byte HTTP transmission', async result => {
    result.baselineRssBytes = beforeMedia
    result.note = 'Synthetic opaque bytes declared as image/video/audio test only serialization transport, not media decoding or supplier capability.'
    const cases = [
      { modality: 'image', mediaType: 'image/png', wireType: 'image_url' },
      { modality: 'video', mediaType: 'video/mp4', wireType: 'video_url' },
      { modality: 'audio', mediaType: 'audio/x-audit', format: 'x-audit', wireType: 'input_audio' },
    ]
    result.payloads = []
    const settled = await Promise.allSettled(cases.map(async (test, index) => {
      const data = Buffer.alloc(8 * 1024 * 1024, index + 1)
      const config = createDefaultModelConfig()
      config.modalities[test.modality] = { override: 'force_enable' }
      const model = `media-${test.modality}`
      const content = buildMediaContent([{ type: 'file', attachment: { attachmentId: model, name: model, bytes: data.length } }], [test], 'local transport integrity check')
      const started = performance.now()
      const observed = await collect(adapter({ connection: { modelConfig: config }, resolveMediaBytes: async () => data }).stream(options(model, { messages: [createUserMessage({ content, source: { kind: 'user' } })] })))
      const wire = inspections.get(model)
      const outcome = { modality: test.modality, sourceBytes: data.length, sourceSha256: sha(data), wire, elapsedMs: performance.now() - started, error: observed.error, finish: observed.finish }
      result.payloads.push(outcome)
      assert.equal(observed.error, null)
      assert.equal(wire?.bytes, data.length)
      assert.equal(wire?.sha256, outcome.sourceSha256)
      assert.equal(wire?.type, test.wireType)
      assert.equal(observed.finish?.kind, 'stop')
    }))
    result.peakRssBytes = peakRss
    result.rssIncreaseBytes = peakRss - beforeMedia
    result.processIncludesBothHttpClientAndLocalServer = true
    for (const task of settled) if (task.status === 'rejected') throw task.reason
  })
  }

  if (!partialErrorOnly) {
  await scenario('idle SSE without caller signal: bounded observation of adapter timeout ownership', async result => {
    let settled = false
    const pending = collect(adapter().stream(options('idle-without-signal', { signal: undefined }))).then(observed => {
      settled = true
      return observed
    })
    await delay(2000)
    result.completedAutonomouslyWithin2000ms = settled
    result.intervention = 'test closes this single local response after the observation window'
    activeResponses.get('idle-without-signal')?.destroy()
    result.observedAfterTestIntervention = await pending
    result.interpretation = 'Absence of a two-second adapter deadline is an ownership observation, not proof of an infinite hang or universal bug; callers can provide AbortSignal deadlines.'
  })
  await scenario('consumer break after first chunk closes local response socket', async result => {
    for await (const value of adapter().stream(options('consumer-break', { signal: undefined }))) {
      result.firstChunkType = value.type
      break
    }
    await delay(2000)
    result.responseClosedWithin2000ms = inspections.get('consumer-break')?.responseClosed ?? false
    activeResponses.get('consumer-break')?.destroy()
    assert.equal(result.responseClosedWithin2000ms, true)
  })
  await scenario('in-band SSE error preserves upstream structured diagnostic', async result => {
    result.observed = await collect(adapter().stream(options('stream-error-event')))
    const failure = result.observed.error ?? result.observed.finish?.failure
    assert.ok(failure)
    assert.ok(JSON.stringify(failure).includes('local_stream_error'), 'structured stream error must not disappear into a generic EMPTY_RESPONSE')
  })
  }
  if (!followupOnly) {
  await scenario('partial content followed by in-band SSE error must not report normal stop', async result => {
    result.observed = await collect(adapter().stream(options('partial-stream-error-event')))
    assert.equal(result.observed.text, 'partial-before-upstream-error')
    assert.notEqual(result.observed.finish?.kind, 'stop', 'a structured upstream error after partial content must not be silently reported as successful completion')
    const failure = result.observed.error ?? result.observed.finish?.failure
    assert.ok(JSON.stringify(failure ?? {}).includes('local_partial_stream_error'), 'the diagnostic should preserve the structured upstream error')
  })
  }
} finally {
  clearInterval(memoryTimer)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

report.totalRequests = requests.length
report.requestBodyBytesTotal = requests.reduce((sum, request) => sum + request.bytes, 0)
report.requests = requests
report.serverErrors = serverErrors
report.summary = { passed: report.cases.filter(item => item.status === 'pass').length, failed: report.cases.filter(item => item.status === 'fail').length }
report.ok = report.summary.failed === 0 && serverErrors.length === 0 && requests.length <= MAX_REQUESTS
const outputDirectory = new URL('../docs/audit-2026-09-05/', import.meta.url)
await mkdir(outputDirectory, { recursive: true })
const outputName = partialErrorOnly ? 'stress-inband-partial-results.json'
  : followupOnly ? 'stress-followup-results.json' : 'stress-results.json'
await writeFile(new URL(afterFixOutput ? outputName.replace('.json', '-after-fix.json') : outputName, outputDirectory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report.summary, totalRequests: report.totalRequests, externalRequests: report.externalRequests, ok: report.ok }))
if (!report.ok) process.exitCode = 1
