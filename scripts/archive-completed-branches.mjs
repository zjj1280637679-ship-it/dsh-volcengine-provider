import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const checkOnly = process.argv.includes('--check')
const plan = JSON.parse(await readFile('.github/branch-archive-plan.json', 'utf8'))
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
assert.match(plan.date, /^\d{4}-\d{2}-\d{2}$/)
assert.equal(plan.repository, 'zjj1280637679-ship-it/dsh-volcengine-provider')
if (!checkOnly) {
  assert.equal(process.env.GITHUB_REPOSITORY, plan.repository)
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  assert.equal(git(['status', '--porcelain']), '', 'Archive from a clean checkout')
}

const refs = new Map(git(['ls-remote', '--heads', '--tags', 'origin']).split('\n').map(line => {
  const [sha, ref] = line.split(/\s+/)
  return [ref, sha]
}))
assert.equal(refs.get(`refs/tags/${plan.releaseTag}`), plan.releaseCommit, 'Published release tag moved')
if (!checkOnly) assert.equal(refs.get('refs/heads/main'), process.env.GITHUB_SHA, 'Main advanced; review a fresh snapshot')

const leases = []
const updates = []
const names = new Set()
for (const branch of plan.branches) {
  assert.notEqual(branch.name, 'main')
  assert(!names.has(branch.name), 'Duplicate branch in archive plan')
  names.add(branch.name)
  assert.match(branch.sha, /^[a-f0-9]{40}$/)
  const head = `refs/heads/${branch.name}`
  const tag = `refs/tags/archive/${plan.date}/${branch.name}`
  git(['check-ref-format', head])
  git(['check-ref-format', tag])
  const current = refs.get(head)
  const archived = refs.get(tag)
  if (archived !== undefined) assert.equal(archived, branch.sha, `Archive tag differs: ${tag}`)
  if (current === undefined) {
    assert.equal(archived, branch.sha, `Missing branch without matching archive: ${branch.name}`)
    continue
  }
  assert.equal(current, branch.sha, `Branch advanced: ${branch.name}`)
  git(['cat-file', '-e', `${branch.sha}^{commit}`])
  if (branch.merged) {
    assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', branch.sha, plan.releaseCommit]).status, 0,
      `Completed branch is absent from the release: ${branch.name}`)
  } else {
    // Keep audit-only commits reachable; do not mistake them for merged product code.
    const paths = git(['diff', '--name-only', `${plan.releaseCommit}...${branch.sha}`]).split('\n').filter(Boolean).sort()
    assert.deepEqual(paths, [...branch.unmergedPaths].sort(), `Unreviewed changes in ${branch.name}`)
    assert(paths.every(name => name.startsWith('.github/workflows/') || name === 'scripts/review-live-2026-09-06.mjs'))
  }
  if (archived === undefined) updates.push(`${branch.sha}:${tag}`)
  leases.push(`--force-with-lease=${head}:${branch.sha}`)
  updates.push(`:${head}`)
}

if (checkOnly) {
  console.log(`Archive preflight passed: ${plan.branches.length} exact tips; release unchanged; ${updates.length} ref operations.`)
} else if (updates.length > 0) {
  // One server transaction creates all archive tags and removes only the exact
  // snapshotted heads. A concurrent branch update rejects the whole operation.
  execFileSync('git', ['push', '--atomic', ...leases, 'origin', ...updates], { stdio: 'inherit' })
} else {
  console.log('All planned branches are already archived.')
}
