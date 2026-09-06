import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { VolcengineChatAdapter, getDefaultRoute, buildMediaCommandContent } from '../dist/index.js'
import { matchesFixture } from './live-coding-plan-media.mjs'

const SOURCE_COMMIT = 'f419db47303939a6254c091c28b5c3e8174f422d'
const route = getDefaultRoute('coding-plan')
const key = process.env.ARK_CODING_PLAN_API_KEY?.trim() ?? ''
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const scrub = value => {
  let text = String(value ?? '')
  if (key) text = text.split(key).join('[REDACTED]')
  return text.replace(/data:[^\s"']+;base64,[a-z0-9+/=]+/giu, '[MEDIA]')
}
const report = {
  timestamp: new Date().toISOString(),
  productionSourceCommit: SOURCE_COMMIT,
  auditCommit: process.env.GITHUB_SHA ?? 'local',
  credential: key ? 'configured' : 'missing',
  route: route.baseUrl,
  modalityPolicy: 'unset; no modelConfig and no capability inference',
  maxRequests: 7,
  requests: [],
  cases: [],
}
const tests = [
  {model:'doubao-seed-2.0-lite', modality:'text', prompt:'Reply with exactly OK.'},
  {model:'glm-5.3-flash', modality:'text', prompt:'Reply with exactly OK.'},
  {model:'doubao-seed-2.0-lite', modality:'image', file:'image.png', prompt:'Describe the two main colored shapes. Mention each color and shape in English.'},
  {model:'glm-5.3-flash', modality:'image', file:'image.png', prompt:'Describe the two main colored shapes. Mention each color and shape in English.'},
  {model:'doubao-seed-2.0-lite', modality:'video', file:'video.mp4', prompt:'Name the main screen colors in temporal order, and estimate each duration. Answer in English.'},
  {model:'glm-5.3-flash', modality:'video', file:'video.mp4', prompt:'Name the main screen colors in temporal order, and estimate each duration. Answer in English.'},
  {model:'doubao-seed-2.0-lite', modality:'audio', file:'audio.mp3', prompt:'Transcribe the spoken English. Return only the transcription.'},
]
if (key && !/\s/u.test(key)) {
  const fixtureRoot = new URL('../tests/fixtures/live-media/', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('manifest.json', fixtureRoot), 'utf8'))
  for (const test of tests) {
    const result = {model:test.model, modality:test.modality, text:'', completed:false, semanticMatch:false}
    report.cases.push(result)
    const fixture = test.file ? manifest[test.file] : undefined
    const bytes = test.file ? await readFile(new URL(test.file, fixtureRoot)) : undefined
    if (bytes && (bytes.length !== fixture.bytes || hash(bytes) !== fixture.sha256)) {
      throw new Error('Fixture integrity mismatch')
    }
    let count = 0
    const adapter = new VolcengineChatAdapter({
      resolveConnection: () => ({route, apiKey:key}),
      resolveMediaBytes: async (block, signal) => {
        signal?.throwIfAborted()
        if (!bytes || block.attachment.attachmentId !== test.file) throw new Error('Unexpected media reference')
        return bytes
      },
      fetchImpl: async (input, init) => {
        if (String(input) !== route.baseUrl + '/chat/completions' || init.method !== 'POST' || ++count !== 1) {
          throw new Error('Unexpected request destination or retry')
        }
        if (report.requests.length >= report.maxRequests) throw new Error('Probe request budget exceeded')
        const body = JSON.parse(init.body)
        if (body.model !== test.model) throw new Error('Unexpected model')
        if (bytes) {
          const parts = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
          const media = parts.filter(p => p.type !== 'text')
          if (media.length !== 1) throw new Error('Unexpected media count')
          const expectedType = {image:'image_url', video:'video_url', audio:'input_audio'}[test.modality]
          if (media[0].type !== expectedType) throw new Error('Unexpected media wire type')
          let encoded
          if (test.modality === 'audio') {
            if (media[0].input_audio.format !== 'mp3' || media[0].input_audio.data.startsWith('data:')) throw new Error('Unexpected audio envelope')
            encoded = media[0].input_audio.data
          } else {
            const url = media[0][expectedType].url
            const prefix = 'data:' + fixture.mediaType + ';base64,'
            if (!url.startsWith(prefix)) throw new Error('Unexpected media envelope')
            encoded = url.slice(prefix.length)
          }
          const decoded = Buffer.from(encoded, 'base64')
          result.bytes = bytes.length
          result.sourceSha256 = fixture.sha256
          result.wireSha256 = hash(decoded)
          result.bytesPreserved = decoded.equals(bytes)
          if (!result.bytesPreserved) throw new Error('Media bytes changed')
        }
        const request = {model:test.model, modality:test.modality, status:null}
        report.requests.push(request)
        const response = await fetch(input, {...init, redirect:'error'})
        request.status = response.status
        request.contentType = response.headers.get('content-type')
        request.requestId = scrub(response.headers.get('x-request-id') ?? response.headers.get('x-tt-logid'))
        if (!response.ok) {
          try {
            const payload = await response.clone().json()
            request.providerCode = scrub(payload?.error?.code ?? payload?.code).slice(0,100)
            request.diagnostic = scrub(payload?.error?.message ?? 'No structured provider diagnostic').slice(0,1000)
          } catch { request.diagnostic = 'Unstructured error omitted' }
        }
        return response
      },
    })
    try {
      const content = bytes
        ? buildMediaCommandContent(fixture.mediaType + ' -- ' + test.prompt, [{type:'file', attachment:{attachmentId:test.file,name:test.file,bytes:bytes.length}}])
        : [{type:'text',text:test.prompt}]
      for await (const chunk of adapter.stream({
        provider:'volcengine-coding-plan', model:test.model,
        maxTokens:test.modality === 'text' ? 256 : 1024,
        signal:AbortSignal.timeout(60_000),
        messages:[createUserMessage({content,source:{kind:'user'}})],
      })) {
        if (chunk.type === 'text-delta') result.text += chunk.text
        if (chunk.type === 'finish') result.finish = chunk.reason
        if (chunk.type === 'usage') result.usage = chunk.usage
      }
      result.completed = result.text.trim().length > 0 && result.finish?.kind === 'stop'
      result.semanticMatch = test.modality === 'text' ? result.text.trim() === 'OK' : matchesFixture(test.modality,result.text)
    } catch (error) {
      result.failure = {code:scrub(error?.code ?? error?.name ?? 'ERROR').slice(0,100), message:'See sanitized request diagnostic; raw exceptions omitted.'}
    }
    result.text = scrub(result.text).slice(0,2000)
  }
}
const safeReport = JSON.stringify(report, (_name,value) => typeof value === 'string' ? scrub(value) : value, 2)
await writeFile('live-review-results.json', safeReport + '\n')
console.log(safeReport)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '# Bounded alpha.9 live review\n\n<pre>' + safeReport.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</pre>\n')
if (!key || report.requests.length !== 7) process.exitCode = 1
