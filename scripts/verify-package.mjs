import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
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
  const extracted = path.join(temporary, 'extracted')
  await mkdir(extracted)
  execFileSync('tar', ['-xf', path.join(temporary, packed.filename), '-C', extracted])
  const packageRoot = path.join(extracted, 'package')
  // Reuse the verified host peer set; this smoke requires no network or credentials.
  await symlink(path.resolve('node_modules'), path.join(packageRoot, 'node_modules'), 'dir')
  const require = createRequire(path.join(packageRoot, 'package.json'))
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const plugin = await import(pathToFileURL(require.resolve(manifest.name)).href)
  assert.equal(plugin.name, 'llm-volcengine')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal('default' in plugin, false, 'Cordis function plugin must keep named exports')
  assert.equal(Object.keys(plugin.resolveConfig({}).routes).length, 3)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
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
  assert(browser.inject.includes('remote.settings'))
  assert.equal((await readdir(temporary)).filter(name => name.endsWith('.tgz')).length, 1)
  process.stdout.write(`Package verified: ${packed.filename}; bundle metadata, host entry, browser ModuleLoader factory, declarations, and clean contents.\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
