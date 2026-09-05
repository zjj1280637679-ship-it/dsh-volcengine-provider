import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { getDefaultRoute, VolcengineChatAdapter } from '../dist/index.js'

// Explicit user-selected test targets; this is not a provider model allowlist.
export const TEST_MODELS = ['doubao-seed-2.0-lite', 'glm-5.3-flash']

/** One advisory GET and one bounded production-adapter request per chosen model. */
export async function runCodingPlanProbe({ apiKey, fetchImpl = fetch }) {
  const key = apiKey?.trim() ?? ''
  const route = getDefaultRoute('coding-plan')
  const report = {
    timestamp: new Date().toISOString(),
    credential: key === '' ? 'missing' : 'configured',
    route: route.baseUrl,
    models: [...TEST_MODELS],
    requests: [],
    discovery: { status: 'not-run' },
    chat: [],
    ok: false,
  }
  if (key === '') return report
  if (/\s/u.test(key)) return { ...report, credential: 'invalid-whitespace' }

  const safe = value => {
    let text = String(value ?? '')
    for (const secret of new Set([apiKey, key])) {
      if (secret) text = text.split(secret).join('[REDACTED]')
    }
    return text
  }
  const failure = error => ({
    code: safe(error?.code ?? error?.name ?? 'ERROR').slice(0, 100),
    message: safe(error?.message ?? 'Request failed.').slice(0, 1200),
  })
  const observedFetch = async (input, init) => {
    const url = String(input)
    if (url !== `${route.baseUrl}/models` && url !== `${route.baseUrl}/chat/completions`) {
      throw new Error('The live probe may contact only the selected Coding Plan route.')
    }
    const attempt = { method: init.method, path: new URL(url).pathname, status: null }
    report.requests.push(attempt)
    const timeout = AbortSignal.timeout(90_000)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const response = await fetchImpl(input, { ...init, redirect: 'error', signal })
    attempt.status = response.status
    attempt.contentType = response.headers.get('content-type')
    attempt.requestId = response.headers.get('x-request-id') ?? response.headers.get('x-tt-logid')
    return response
  }
  const adapter = new VolcengineChatAdapter({
    resolveConnection: () => ({ route, apiKey: key }),
    fetchImpl: observedFetch,
  })
  const provider = 'volcengine-coding-plan'

  // Discovery is advisory. In particular, an unsupported /models endpoint
  // must not prevent testing the two model IDs the user explicitly supplied.
  try {
    const models = await adapter.listModels(provider)
    report.discovery = {
      status: 'ok', count: models.length,
      requestedModelsListed: TEST_MODELS.filter(id => models.some(model => model.id === id)),
    }
  } catch (error) {
    report.discovery = { status: 'error', ...failure(error) }
  }

  for (const model of TEST_MODELS) {
    const result = { model, ok: false, text: '', reasoningCharacters: 0, finish: null }
    report.chat.push(result)
    try {
      for await (const chunk of adapter.stream({
        provider, model, maxTokens: 256,
        signal: AbortSignal.timeout(90_000),
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'This is a connection test. Reply with exactly OK.' }],
          source: { kind: 'user' },
        })],
      })) {
        if (chunk.type === 'text-delta') result.text += chunk.text
        if (chunk.type === 'reasoning-delta') result.reasoningCharacters += chunk.text.length
        if (chunk.type === 'finish') result.finish = chunk.reason
        if (chunk.type === 'usage') result.usage = chunk.usage
      }
      result.ok = result.text.trim().length > 0
        && ['stop', 'max-tokens'].includes(result.finish?.kind)
      if (!result.ok) result.failure = { code: 'NO_USABLE_TEXT', message: 'No completed text reply within this probe budget.' }
    } catch (error) {
      result.failure = failure(error)
    }
    result.text = safe(result.text).slice(0, 1000)
  }
  report.ok = report.chat.every(result => result.ok)
  // Sanitize the complete report as well, including any upstream error fields
  // or diagnostic headers. Never emit credentials, request headers or stacks.
  return JSON.parse(JSON.stringify(report, (_name, value) => typeof value === 'string' ? safe(value) : value))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runCodingPlanProbe({ apiKey: process.env.ARK_CODING_PLAN_API_KEY })
  const output = JSON.stringify(report, null, 2)
  console.log(output)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Coding Plan live probe\n\n\`\`\`json\n${output}\n\`\`\`\n`)
  }
  if (!report.ok) process.exitCode = 1
}
