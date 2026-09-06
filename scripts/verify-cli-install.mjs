import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Optional acceptance check against an already installed Harness CLI. It never
// downloads a Host, starts the browser server, or sends a provider request.
const [cliArgument, packageArgument] = process.argv.slice(2)
assert(cliArgument && packageArgument,
  'usage: node scripts/verify-cli-install.mjs <installed-dsh-bin.js> <precompiled-plugin.tgz>')
const cli = path.resolve(cliArgument)
const tarball = path.resolve(packageArgument)
const home = await mkdtemp(path.join(tmpdir(), 'volcengine-cli-'))
try {
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  const run = args => execFileSync(process.execPath, [cli, ...args], {
    env, cwd: home, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  })
  const hostVersion = run(['--version']).trim()
  // Use the package manager cache populated by the normal dependency install.
  // --ignore-scripts is appropriate for the precompiled release tarball, and
  // this isolated acceptance profile never authorizes a git prepare script.
  run(['plugin', '--profile', 'web', 'add', '--offline', '--ignore-scripts', tarball])
  const profile = path.join(home, 'profiles', 'web')
  const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
  assert(manifest.dependencies?.['dsh-volcengine-provider'], 'The CLI did not install the plugin dependency')
  assert.equal(manifest.dsh?.profile?.bundles?.filter(name => name === 'dsh-volcengine-provider').length, 1,
    'The installed package must contribute exactly one bundle layer')
  const installed = JSON.parse(await readFile(path.join(profile, 'node_modules', 'dsh-volcengine-provider', 'package.json'), 'utf8'))
  // Validate the public contracts from this CLI's actual dependency closure,
  // including the full-width media dock; no plugin-side Host version lock.
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./verify-host-abi.mjs', import.meta.url)), path.dirname(path.dirname(await realpath(cli))),
  ], { env, encoding: 'utf8', timeout: 30_000 })
  const dumps = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const dump = run(['--profile', 'web', '--dump-config'])
    assert.equal([...dump.matchAll(/^\s*name:\s*['"]?dsh-volcengine-provider['"]?\s*$/gm)].length, 1,
      'The CLI composition must contain exactly one provider row')
    dumps.push(dump)
  }
  assert.equal(dumps[0], dumps[1], 'Independent CLI invocations must compose the same profile')
  process.stdout.write(`CLI install verified: Harness ${hostVersion}; plugin ${installed.version}; one installed bundle and two identical composition dumps.\n`)
} finally {
  await rm(home, { recursive: true, force: true })
}
