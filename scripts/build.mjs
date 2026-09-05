import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' })
await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external',
})
await build({
  entryPoints: ['src/client/index.ts'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', external: ['react'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-volcengine-provider",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
})
