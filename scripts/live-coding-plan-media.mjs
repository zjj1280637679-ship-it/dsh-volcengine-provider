import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildMediaCommandContent, createDefaultModelConfig, getDefaultRoute, VolcengineChatAdapter } from '../dist/index.js'

const fixtureRoot = new URL('../tests/fixtures/live-media/', import.meta.url)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
// Explicit test cases requested by the user, never a provider capability table.
export const MEDIA_CASES = [
  { model: 'doubao-seed-2.0-lite', modality: 'image', file: 'image.png', prompt: 'Describe the two main colored shapes in this image in English. Mention their colors and shapes.' },
  { model: 'doubao-seed-2.0-lite', modality: 'audio', file: 'audio.mp3', prompt: 'Transcribe the spoken English in this audio. Return only the transcription.' },
  { model: 'glm-5.3-flash', modality: 'image', file: 'image.png', prompt: 'Describe the two main colored shapes in this image in English. Mention their colors and shapes.' },
  { model: 'glm-5.3-flash', modality: 'video', file: 'video.mp4', prompt: 'Name the main screen colors in this video in temporal order. Answer in English.' },
]

export function matchesFixture(modality, text) {
  const normalized = text.toLowerCase().replace(/[*_`-]/gu, ' ')
  if (modality === 'image') return /\b(?:red\s+circle|circle\s+(?:is\s+|in\s+)?red)\b/u.test(normalized)
    && /\b(?:blue\s+square|square\s+(?:is\s+|in\s+)?blue)\b/u.test(normalized)
  if (modality === 'audio') return /\bbanana\b/u.test(normalized)
    && /(?:\bseven[\s,.-]+three[\s,.-]+one\b|\b7[\s,.-]*3[\s,.-]*1\b)/u.test(normalized)
  return /\byellow\b[\s\S]*\bgreen\b[\s\S]*\b(?:purple|violet)\b/u.test(normalized)
}

/** Four sequential requests through the production command builder and adapter. No retries. */
export async function runMediaProbe({ apiKey, fetchImpl = fetch }) {
  const key = apiKey?.trim() ?? ''
  const route = getDefaultRoute('coding-plan')
  const report = { timestamp: new Date().toISOString(), credential: key ? 'configured' : 'missing', route: route.baseUrl, requests: [], cases: [], ok: false }
  if (!key) return report
  if (/\s/u.test(key)) return { ...report, credential: 'invalid-whitespace' }
  const sensitive = new Set([apiKey, key])
  const safe = value => {
    let text = String(value ?? '')
    for (const token of sensitive) if (token) text = text.split(token).join('[REDACTED]')
    return text.replace(/data:[^\s"']+;base64,[a-z0-9+/=]+/giu, '[MEDIA]')
  }
  const failure = error => ({ code: safe(error?.code ?? error?.name ?? 'ERROR').slice(0, 100), message: safe(error?.message ?? 'Request failed.').slice(0, 1000) })
  const fixtures = new Map()
  try {
    const manifest = JSON.parse(await readFile(new URL('manifest.json', fixtureRoot), 'utf8'))
    for (const file of new Set(MEDIA_CASES.map(item => item.file))) {
      const bytes = await readFile(new URL(file, fixtureRoot))
      const info = manifest[file]
      sensitive.add(bytes.toString('base64'))
      if (bytes.length !== info.bytes || hash(bytes) !== info.sha256) throw new Error(`Fixture integrity check failed: ${file}`)
      fixtures.set(file, { ...info, data: bytes })
    }
  } catch (error) {
    return { ...report, failure: failure(error) }
  }

  for (const test of MEDIA_CASES) {
    const fixture = fixtures.get(test.file)
    const result = { model: test.model, modality: test.modality, fixture: test.file, bytes: fixture.bytes, sourceSha256: fixture.sha256, wireSha256: null, bytesPreserved: false, text: '', reasoningCharacters: 0, finish: null, completed: false, semanticMatch: false, ok: false }
    report.cases.push(result)
    const config = createDefaultModelConfig()
    config.modalities[test.modality].enabled = true
    let attempts = 0
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({ route, apiKey: key, modelConfig: config }),
      resolveMediaBytes: async (block, signal) => {
        signal?.throwIfAborted()
        if (block.attachment.attachmentId !== test.file) throw new Error('Unexpected fixture reference.')
        return fixture.data
      },
      fetchImpl: async (input, init) => {
        if (String(input) !== `${route.baseUrl}/chat/completions` || init.method !== 'POST' || ++attempts !== 1) throw new Error('Unexpected live-probe destination or retry.')
        const body = JSON.parse(init.body)
        const parts = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        const media = parts.filter(part => part.type !== 'text')
        if (body.model !== test.model || media.length !== 1) throw new Error('Unexpected outgoing model or media count.')
        const part = media[0]
        const expectedType = { image: 'image_url', audio: 'input_audio', video: 'video_url' }[test.modality]
        if (part.type !== expectedType) throw new Error('Unexpected outgoing media wire type.')
        let encoded
        if (test.modality === 'audio') {
          if (part.input_audio.format !== 'mp3' || part.input_audio.data.startsWith('data:')) throw new Error('Incorrect Chat audio envelope.')
          encoded = part.input_audio.data
        } else {
          const url = part[expectedType].url
          const prefix = `data:${fixture.mediaType};base64,`
          if (!url.startsWith(prefix)) throw new Error('Incorrect Chat media envelope.')
          encoded = url.slice(prefix.length)
        }
        const decoded = Buffer.from(encoded, 'base64')
        result.wireSha256 = hash(decoded)
        result.bytesPreserved = decoded.equals(fixture.data)
        if (!result.bytesPreserved) throw new Error('Media bytes changed before transmission.')
        const request = { model: test.model, modality: test.modality, method: init.method, path: new URL(String(input)).pathname, status: null }
        report.requests.push(request)
        const response = await fetchImpl(input, { ...init, redirect: 'error' })
        request.status = response.status
        request.contentType = response.headers.get('content-type')
        request.requestId = response.headers.get('x-request-id') ?? response.headers.get('x-tt-logid')
        return response
      },
    })
    try {
      const content = buildMediaCommandContent(`${fixture.mediaType} -- ${test.prompt}`, [
        { type: 'file', attachment: { attachmentId: test.file, name: test.file, bytes: fixture.bytes } },
      ])
      // Exercise durable JSON content shape, using the same native media blocks as /ark-media.
      const message = JSON.parse(JSON.stringify(createUserMessage({ content, source: { kind: 'user' } })))
      for await (const chunk of adapter.stream({ provider: 'volcengine-coding-plan', model: test.model, maxTokens: 1024, signal: AbortSignal.timeout(120_000), messages: [message] })) {
        if (chunk.type === 'text-delta') result.text += chunk.text
        if (chunk.type === 'reasoning-delta') result.reasoningCharacters += chunk.text.length
        if (chunk.type === 'finish') result.finish = chunk.reason
        if (chunk.type === 'usage') result.usage = chunk.usage
      }
      result.completed = result.text.trim().length > 0 && result.finish?.kind === 'stop'
      result.semanticMatch = matchesFixture(test.modality, result.text)
      result.ok = result.bytesPreserved && result.completed && result.semanticMatch
      if (!result.ok) result.failure = { code: 'MEDIA_CHECK_FAILED', message: 'Check completion, semantic content and byte preservation separately.' }
    } catch (error) {
      result.failure = failure(error)
    }
    result.text = safe(result.text).slice(0, 2000)
  }
  report.ok = report.cases.length === MEDIA_CASES.length && report.cases.every(result => result.ok)
  return JSON.parse(JSON.stringify(report, (_name, value) => typeof value === 'string' ? safe(value) : value))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runMediaProbe({ apiKey: process.env.ARK_CODING_PLAN_API_KEY })
  const output = JSON.stringify(report, null, 2)
  console.log(output)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Coding Plan media probe\n\n\`\`\`json\n${output}\n\`\`\`\n`)
  if (!report.ok) process.exitCode = 1
}
