import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCE_PACKAGE_DIRS = {
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-settings': 'packages/settings/settings',
  '@deepseek-ai/dsh-credentials': 'packages/credentials/credentials',
  '@deepseek-ai/dsh-launch-environment': 'packages/util/launch-environment',
}

const REQUIRED_EXPORTS = {
  '@deepseek-ai/dsh-llm': [
    'default', 'LlmAdapter', 'LlmError', 'attributionHeaders', 'createUserMessage', 'freezeMessage',
    'normalizeApiKey', 'ProviderRequestId',
  ],
  '@deepseek-ai/dsh-settings': ['default'],
  '@deepseek-ai/dsh-credentials': ['credentialRef'],
  '@deepseek-ai/dsh-launch-environment': ['launchEnvironmentOf'],
}

const REQUIRED_LLM_METHODS = [
  'registerAdapter', 'listProviders',
  'registerConfigurableProviders', 'listConfigurableProviders',
  'registerModelDiscovery',
]

const REQUIRED_CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-input-trigger',
]

const REQUIRED_CLIENT_SYMBOLS = {
  '@deepseek-ai/dsh-client-connection': ['ConnectionHandle'],
  '@deepseek-ai/dsh-client-ui-conversation': ['IConversation'],
  '@deepseek-ai/dsh-client-ui-input-trigger': [
    'InputTriggerServiceContract', 'InputTriggerSource', 'ReferenceInsert',
  ],
}

function packagePath(root, name) {
  const installed = join(root, 'node_modules', ...name.split('/'), 'package.json')
  if (existsSync(installed)) return installed
  const sourceDir = SOURCE_PACKAGE_DIRS[name]
  const source = sourceDir === undefined ? undefined : join(root, sourceDir, 'package.json')
  if (source !== undefined && existsSync(source)) return source
  // An installed CLI may use a pnpm dependency closure instead of a flat
  // node_modules tree. Resolve through that Host package's public exports.
  try { return createRequire(join(root, 'package.json')).resolve(`${name}/package.json`) } catch {}
  throw new Error(`${name} is not resolvable below ${root}`)
}

function defaultExportTarget(manifest) {
  const rootExport = manifest.exports?.['.']
  if (typeof rootExport === 'string') return rootExport
  if (rootExport !== null && typeof rootExport === 'object') {
    for (const key of ['default', 'import', 'node']) {
      if (typeof rootExport[key] === 'string') return rootExport[key]
    }
  }
  if (typeof manifest.main === 'string') return manifest.main
  throw new Error(`${manifest.name} has no importable root export`)
}

function typeExportTarget(manifest, subpath) {
  const entry = manifest.exports?.[subpath]
  if (entry !== null && typeof entry === 'object' && typeof entry.types === 'string') return entry.types
  throw new Error(`${manifest.name} has no public ${subpath} types export`)
}

async function declarationFiles(path) {
  const rows = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) rows.push(...await declarationFiles(child))
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) rows.push(child)
  }
  return rows
}

function exportsType(entry, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `export\\s+(?:declare\\s+)?(?:interface|type|class)\\s+${escaped}\\b`
      + `|export\\s+(?:type\\s+)?\\{[\\s\\S]*?\\b${escaped}\\b[\\s\\S]*?\\}`,
    'u',
  ).test(entry)
}

function hasAll(corpus, patterns) {
  return patterns.every(pattern => pattern.test(corpus))
}

async function inspectClientDeclarations(manifestPath, manifest) {
  const packageDir = dirname(manifestPath)
  const clientTypes = resolve(packageDir, typeExportTarget(manifest, './client'))
  if (!existsSync(clientTypes)) throw new Error(`${manifest.name} public client declaration is missing`)
  const entry = await readFile(clientTypes, 'utf8')
  const declarationRoot = resolve(packageDir, dirname(manifest.types ?? typeExportTarget(manifest, '.')))
  const files = await declarationFiles(declarationRoot)
  const corpus = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n')
  const missing = []
  for (const symbol of REQUIRED_CLIENT_SYMBOLS[manifest.name] ?? []) {
    if (!exportsType(entry, symbol)) missing.push(`public type ${symbol}`)
  }

  let lifecycle
  if (manifest.name === '@deepseek-ai/dsh-client-connection') {
    if (!hasAll(corpus, [
      /interface\s+ConnectionHandle\b/u,
      /readonly\s+isLoopback\s*:\s*boolean/u,
      /readonly\s+rpc\s*:\s*ClientConnectionRpc/u,
    ])) missing.push('ConnectionHandle isLoopback/rpc structure')
    const generation = hasAll(corpus, [
      /readonly\s+generation\s*:\s*ConnectionGenerationState/u,
      /interface\s+ConnectionGenerationState\b/u,
      /getSnapshot\(\)\s*:\s*ConnectionGeneration\s*\|\s*undefined/u,
      /subscribe\(listener\s*:\s*\(\)\s*=>\s*void\)\s*:\s*\(\)\s*=>\s*void/u,
    ])
    const hostDescription = hasAll(corpus, [
      /readonly\s+hostDescription\s*:\s*HostDescriptionSource/u,
      /interface\s+HostDescriptionSource\b/u,
      /getSnapshot\(\)\s*:\s*HostDescription\s*\|\s*undefined/u,
      /subscribe\(listener\s*:\s*\(\)\s*=>\s*void\)\s*:\s*\(\)\s*=>\s*void/u,
    ])
    lifecycle = generation ? 'generation' : hostDescription ? 'hostDescription' : undefined
    if (lifecycle === undefined) missing.push('Connection generation or hostDescription observable lifecycle')
  }

  if (manifest.name === '@deepseek-ai/dsh-client-ui-conversation' && !hasAll(corpus, [
    /interface\s+IConversation\b/u,
    /readonly\s+input\s*:\s*SessionInputResolver/u,
    /interface\s+SessionInputResolver\b/u,
    /\bfor\([^)]*\)\s*:\s*SessionInput/u,
    /interface\s+SessionInput\b/u,
    /setDraft\(text\s*:\s*string\)\s*:\s*void/u,
    /insertReference\([^)]*\)\s*:\s*boolean/u,
    /notify\(level\s*:\s*'info'\s*\|\s*'error',\s*text\s*:\s*string\)\s*:\s*void/u,
  ])) missing.push('IConversation SessionInput public structure')

  if (manifest.name === '@deepseek-ai/dsh-client-ui-conversation') {
    for (const slot of ['conversation.input.left', 'conversation.input.dock']) {
      const escaped = slot.replaceAll('.', '\\.')
      if (!new RegExp(`['"]${escaped}['"]\\s*:\\s*\\{\\s*kind\\s*:\\s*'list';\\s*scope\\s*:\\s*'session'`, 'u').test(corpus)) {
        missing.push(`public session list slot ${slot}`)
      }
    }
  }

  if (manifest.name === '@deepseek-ai/dsh-client-ui-input-trigger') {
    const sourceContract = hasAll(corpus, [
      /interface\s+InputTriggerServiceContract\b/u,
      /registerSource\([^)]*InputTriggerSource[^)]*\)\s*:\s*\(\)\s*=>\s*void/u,
      /interface\s+InputTriggerSource\b/u,
      /matchEnter\?/u,
      /readonly\s+codec\?/u,
    ])
    const localReference = hasAll(corpus, [
      /interface\s+ReferenceInsert\b/u,
      /readonly\s+clipboardText\s*:\s*string/u,
    ])
    // 0.1.1 owns ReferenceInsert in Conversation and publicly re-exports it;
    // 0.1.2 moved ownership into Input Trigger. Both are public type paths.
    const conversationReference = /export\s+type\s+\{[\s\S]*?\bReferenceInsert\b[\s\S]*?\}\s+from\s+'@deepseek-ai\/dsh-client-ui-conversation\/client'/u.test(corpus)
    if (!sourceContract || !localReference && !conversationReference) {
      missing.push('input-trigger source/reference public structure')
    }
  }

  return {
    missing,
    evidence: {
      clientTypes: clientTypes.slice(packageDir.length + 1).replaceAll('\\', '/'),
      declarationFiles: files.length,
      ...(lifecycle === undefined ? {} : { lifecycle }),
    },
  }
}

async function loadPackage(root, name) {
  const manifestPath = packagePath(root, name)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const modulePath = resolve(dirname(manifestPath), defaultExportTarget(manifest))
  const module = await import(`${pathToFileURL(modulePath).href}?host-abi=${encodeURIComponent(root)}`)
  return { manifest, module }
}

async function inspect(root) {
  const packages = {}
  const clientEvidence = {}
  const missing = []
  for (const [name, exports] of Object.entries(REQUIRED_EXPORTS)) {
    const loaded = await loadPackage(root, name)
    packages[name] = loaded.manifest.version
    for (const symbol of exports) {
      if (!(symbol in loaded.module)) missing.push(`${name} export ${symbol}`)
    }
    if (name === '@deepseek-ai/dsh-llm' && typeof loaded.module.default === 'function') {
      for (const method of REQUIRED_LLM_METHODS) {
        if (typeof loaded.module.default.prototype?.[method] !== 'function') {
          missing.push(`${name} LlmRuntime.${method}`)
        }
      }
    }
    if (name === '@deepseek-ai/dsh-settings' && typeof loaded.module.default === 'function'
      && typeof loaded.module.default.prototype?.register !== 'function') {
      missing.push(`${name} SettingsProvider.register`)
    }
  }
  for (const name of REQUIRED_CLIENT_PACKAGES) {
    try {
      const manifestPath = packagePath(root, name)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      packages[name] = manifest.version
      const inspected = await inspectClientDeclarations(manifestPath, manifest)
      clientEvidence[name] = inspected.evidence
      missing.push(...inspected.missing.map(item => `${name} ${item}`))
    } catch (error) {
      missing.push(`${name} package (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { root, packages, clientEvidence, missing, compatible: missing.length === 0 }
}

const roots = process.argv.slice(2).map(root => resolve(root))
if (roots.length === 0) {
  process.stderr.write('usage: node scripts/verify-host-abi.mjs <installed-or-source-root> [...]\n')
  process.exitCode = 2
} else {
  const results = []
  for (const root of roots) {
    try {
      results.push(await inspect(root))
    } catch (error) {
      results.push({ root, compatible: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  if (results.some(result => !result.compatible)) process.exitCode = 1
}
