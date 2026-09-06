import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Called by verify-package after extracting the tarball into a disposable
// profile. Resolve every Host module from that profile's dependency closure;
// the Loader imports the package itself, without a source-module lookup table.
const [profileArgument, phase] = process.argv.slice(2)
assert(profileArgument && ['write', 'restart'].includes(phase),
  'usage: node --expose-internals scripts/verify-package-host.mjs <profile> <write|restart>')
const profile = path.resolve(profileArgument)
const require = createRequire(path.join(profile, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const [{ Context }, { default: Loader }, { default: Include }, { createUserMessage }] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/cordis-plugin-loader'),
  load('@deepseek-ai/cordis-plugin-include'),
  load('@deepseek-ai/dsh-llm'),
])
const namespace = 'llm-volcengine'
const provider = 'volcengine-coding-plan'
const settingsPath = path.join(profile, 'settings.json')
const configPath = path.join(profile, 'cordis.yml')
const home = path.join(profile, 'home')
await mkdir(home, { recursive: true })
process.env.DSH_HOME = home
// A synthetic value used only by the loopback fixture; no user credential or
// ambient provider reference participates in package verification.
process.env.DSH_VOLCENGINE_PACKAGE_TEST_KEY = 'package-test-only'

const requests = []
const server = createServer((request, response) => {
  const bytes = []
  request.on('data', chunk => bytes.push(chunk))
  request.on('end', () => {
    requests.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(bytes).toString('utf8')) })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: `packaged-${phase}` }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''))
  })
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
assert(address && typeof address !== 'string')
const ctx = new Context()
let disposed = false
try {
  // Include accepts JSON as YAML. Keeping the real package names in the file
  // proves root exports and Node resolution from an installed profile.
  await writeFile(configPath, JSON.stringify([
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'settings', name: '@deepseek-ai/dsh-settings-file', config: { path: settingsPath, watch: false } },
    { id: 'llm-volcengine', name: 'dsh-volcengine-provider', config: { routes: {
      'coding-plan': {
        kind: 'coding-plan', baseURL: `http://127.0.0.1:${address.port}/api/coding/v3`,
        apiKeyEnv: 'DSH_VOLCENGINE_PACKAGE_TEST_KEY', models: [{ id: 'entry-model' }],
      },
    } } },
  ], null, 2))
  ctx.baseUrl = `${pathToFileURL(profile).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const llm = ctx.llm
  assert.deepEqual(llm.listProviders().map(row => row.id), [provider])
  assert.deepEqual(ctx.settings.describe().map(row => row.ns), [namespace])
  assert.equal(requests.length, 0, 'Host boot and model catalogs must not make provider requests')

  if (phase === 'write') {
    assert.deepEqual((await llm.listModels(provider)).map(row => row.id), ['entry-model'])
    await ctx.settings.update(namespace, { routes: { 'coding-plan': { models: [{
      id: 'persisted-package-model', customBody: '{"package_verification":"persisted"}',
    }] } } })
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(persisted[namespace].routes['coding-plan'].models[0].id, 'persisted-package-model')
  }

  const models = await llm.listModels(provider)
  assert.deepEqual(models.map(row => row.id), ['persisted-package-model'])
  assert.equal(Object.hasOwn(models[0], 'inputModalities'), false)
  const chunks = []
  for await (const chunk of llm.stream({
    provider, model: models[0].id,
    messages: [createUserMessage({
      content: [{ type: 'text', text: `verify packaged ${phase}` }], source: { kind: 'user' },
    })],
  })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === `packaged-${phase}`))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].path, '/api/coding/v3/chat/completions')
  assert.equal(requests[0].body.model, 'persisted-package-model')
  assert.equal(requests[0].body.package_verification, 'persisted')
  await ctx.fiber.dispose()
  disposed = true
  assert.deepEqual(llm.listProviders(), [])
  assert.deepEqual(llm.listConfigurableProviders(), [])
  process.stdout.write(`${JSON.stringify({ phase, pid: process.pid, model: models[0].id, requests: requests.length, disposed })}\n`)
} finally {
  if (!disposed) await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
