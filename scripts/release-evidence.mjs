import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const directory = path.resolve('release')
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const verification = JSON.parse(await readFile(path.join(directory, 'package-verification.json'), 'utf8'))
const live = JSON.parse(await readFile(path.join(directory, 'live-review-results.json'), 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(process.env.GITHUB_SHA, commit, 'Release must use the checked-out workflow commit')
assert.equal(verification.package.version, manifest.version)
assert.equal(live.packageVersion, manifest.version)
assert.equal(live.productionSourceCommit, commit)
assert.equal(live.ok, true, 'Live release gate must pass')
const cliEvidence = await readFile(path.join(directory, 'cli-install-verification.txt'), 'utf8')
assert(cliEvidence.includes(`CLI install verified: Harness 0.1.1-rc.2; plugin ${manifest.version};`),
  'The isolated CLI check must complete and produce its success record')
const hashFile = async name => createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex')
assert.equal(await hashFile(verification.package.filename), verification.package.sha256)

const archive = `dsh-volcengine-provider-${commit.slice(0, 7)}-source.zip`
execFileSync('git', ['archive', '--format=zip', '--output', path.join(directory, archive), commit])
const run = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
const prerelease = manifest.version.slice(manifest.version.indexOf('-') + 1)
const notes = await readFile(`docs/releases/${prerelease}.md`, 'utf8')
await writeFile(path.join(directory, 'RELEASE-NOTES.md'), `${notes}\n\n## 本次发布证据\n\n- 候选提交：\`${commit}\`\n- 验证流程：[Linux / Windows 与原包实测](${run})\n- 安装包：\`${verification.package.filename}\`\n- 包 SHA-256：\`${verification.package.sha256}\`\n- 真实请求 ${live.requests.length} 次，完成回复 ${live.cases.filter(x => x.completed).length} 次；媒体原字节校验 ${live.cases.filter(x => x.bytesPreserved).length}/5。语义结果、真实拒绝和请求 ID 见附件 \`live-review-results.json\`。\n- 桌面浏览器外观、IME、操作系统文件选择器与您日常启动命令的验收留待实机检查。\n`)
const files = [verification.package.filename, archive, 'package-verification.json', 'live-review-results.json', 'cli-install-verification.txt', 'RELEASE-NOTES.md']
const checksums = await Promise.all(files.map(async name => `${await hashFile(name)}  ${name}`))
await writeFile(path.join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
console.log(`Release evidence prepared for v${manifest.version} at ${commit}`)
