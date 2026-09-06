import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

function execNpm(args, options) {
  if (process.platform !== 'win32') return execFileSync('npm', args, options)

  // Node cannot execute npm.cmd through execFileSync without a shell. Invoke
  // npm's JavaScript entry point with the current Node executable instead, so
  // package verification stays shell-free and works from PowerShell/pnpm.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  assert(existsSync(npmCli), `npm CLI was not found next to Node: ${npmCli}`)
  return execFileSync(process.execPath, [npmCli, ...args], options)
}

const temporary = await mkdtemp(path.join(tmpdir(), 'volcengine-package-'))
try {
  const packed = JSON.parse(execNpm(['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary], { encoding: 'utf8' }))[0]
  assert(packed.files.some(file => file.path === 'dist/index.js'))
  assert(packed.files.some(file => file.path === 'dist/client.js'))
  assert(packed.files.some(file => file.path === 'dist/types/index.d.ts'))
  assert(packed.files.some(file => file.path === 'cordis.patch.yml'))
  for (const file of packed.files) {
    assert(!/^(src|tests|node_modules)\//.test(file.path), `Development residue in package: ${file.path}`)
    assert(!/(^|\/)\.env(?:\.|$)/.test(file.path), 'Environment file in package')
  }
  // Recreate the profile layout used by DSH: the plugin has no private copy of
  // Host packages, and resolves them through profiles/node_modules maintained
  // from the active DSH installation's dependency closure.
  const profileModules = path.join(temporary, 'profiles', 'web', 'node_modules')
  await mkdir(profileModules, { recursive: true })
  execFileSync('tar', ['-xf', path.join(temporary, packed.filename), '-C', profileModules])
  const packageRoot = path.join(profileModules, 'dsh-volcengine-provider')
  await rename(path.join(profileModules, 'package'), packageRoot)
  await symlink(path.resolve('node_modules'), path.join(temporary, 'profiles', 'node_modules'), 'dir')
  const require = createRequire(path.join(packageRoot, 'package.json'))
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(
    Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-')),
    [],
    'Harness prerelease packages are Host capabilities, not plugin peer-version locks',
  )
  const serverBundle = await readFile(path.join(packageRoot, 'dist', 'index.js'), 'utf8')
  for (const dependency of [
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/schemastery',
  ]) {
    assert(serverBundle.includes(`from \"${dependency}\"`) || serverBundle.includes(`from '${dependency}'`),
      `Host dependency must remain external in the server bundle: ${dependency}`)
  }
  const plugin = await import(pathToFileURL(require.resolve(manifest.name)).href)
  assert.equal(plugin.name, 'llm-volcengine')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal('default' in plugin, false, 'Cordis function plugin must keep named exports')
  assert.equal(Object.keys(plugin.resolveConfig({}).routes).length, 3)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  for (const dependency of [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-input-trigger',
    '@deepseek-ai/dsh-client-ui-settings-models',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-api-remotes',
  ]) {
    assert(manifest.dsh.client.inject.includes(dependency), `Missing client injection: ${dependency}`)
  }
  const bundlePatch = await readFile(path.join(packageRoot, manifest.dsh.bundle.patch), 'utf8')
  assert.match(bundlePatch, /^\s*- insert:/m)
  assert.match(bundlePatch, /^\s+- id: llm-volcengine$/m)
  assert.match(bundlePatch, /^\s+name: dsh-volcengine-provider$/m)
  const mediaOverlay = await readFile(path.join(packageRoot, 'examples', 'coding-plan-media.yml'), 'utf8')
  assert.match(mediaOverlay, /^\s*- id: llm-volcengine$/m)
  assert.doesNotMatch(mediaOverlay, /^\s*- insert:/m, 'An installed-bundle overlay must patch, not duplicate, the provider row')

  let handoff
  vm.runInNewContext(await readFile(require.resolve(`${manifest.name}/client`), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { handoff = value } } },
  }, { filename: 'packaged-volcengine-client.js' })
  assert.equal(handoff.id, manifest.name)
  const browser = handoff.factory(id => {
    assert.equal(id, 'react', `Unexpected browser external: ${id}`)
    return require(id)
  })
  assert.equal(typeof browser.apply, 'function')
  assert(browser.inject.includes('slots'))
  assert.equal(browser.inject.length, 1, 'Client runtime must not require one version-specific settings transport')
  assert(!browser.inject.includes('remote.settings'))
  assert(!browser.inject.includes('remote.credentials'))
  assert.equal((await readdir(temporary)).filter(name => name.endsWith('.tgz')).length, 1)
  process.stdout.write(`Package verified: ${packed.filename}; bundle metadata, host entry, browser ModuleLoader factory, declarations, and clean contents.\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
