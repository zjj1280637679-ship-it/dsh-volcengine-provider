import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const temporary = await mkdtemp(path.join(tmpdir(), 'volcengine-package-'))
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary], { encoding: 'utf8' }))[0]
  assert(packed.files.some(file => file.path === 'dist/index.js'))
  assert(packed.files.some(file => file.path === 'dist/client.js'))
  assert(packed.files.some(file => file.path === 'dist/types/index.d.ts'))
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
  assert.equal(manifest.dsh.client.platform, 'web')

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
  process.stdout.write(`Package verified: ${packed.filename}; Host entry, browser ModuleLoader factory, declarations, and clean contents.\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
