import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
    'default', 'LlmAdapter', 'LlmError', 'attributionHeaders', 'createUserMessage',
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

function packagePath(root, name) {
  const installed = join(root, 'node_modules', ...name.split('/'), 'package.json')
  if (existsSync(installed)) return installed
  const sourceDir = SOURCE_PACKAGE_DIRS[name]
  const source = sourceDir === undefined ? undefined : join(root, sourceDir, 'package.json')
  if (source !== undefined && existsSync(source)) return source
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

async function loadPackage(root, name) {
  const manifestPath = packagePath(root, name)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const modulePath = resolve(dirname(manifestPath), defaultExportTarget(manifest))
  const module = await import(`${pathToFileURL(modulePath).href}?host-abi=${encodeURIComponent(root)}`)
  return { manifest, module }
}

async function inspect(root) {
  const packages = {}
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
  return { root, packages, missing, compatible: missing.length === 0 }
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
