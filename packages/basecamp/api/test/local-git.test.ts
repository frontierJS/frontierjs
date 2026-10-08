// api/test/local-git.test.ts — the git checkouts under a folder on the operator's laptop.
//
// The parsers are fed strings; the scan runs the REAL git against repositories
// made in a temp directory, because branch, upstream and the dirty count are
// git's answer and a hand-written expectation of them would be a second
// implementation.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRoot, findRepoDirs, redactRemote, parseStatus, pickRemote, listLocalRepos } from '../src/core/local-git.ts'

describe('redactRemote', () => {
  test('a credential in an https remote is cut out, a bare username too', () => {
    expect(redactRemote('https://me:ghp_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(redactRemote('https://ghp_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git')
  })

  test('the ssh account stays — it is not a secret, and the URL needs it', () => {
    expect(redactRemote('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(redactRemote('ssh://git@host:2222/a/b.git')).toBe('ssh://git@host:2222/a/b.git')
    expect(redactRemote('ssh://git:pw@host/a/b.git')).toBe('ssh://host/a/b.git')
  })
})

test('parseStatus reads the branch headers and counts the entries', () => {
  const out = parseStatus([
    '# branch.oid 0123456789abcdef', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a b src/x.js', '? new.txt', '',
  ].join('\n'))
  expect(out).toEqual({ branch: 'main', head: '0123456', upstream: 'origin/main', ahead: 2, behind: 1, changes: 2 })
  expect(parseStatus('# branch.oid (initial)\n# branch.head (detached)\n')).toMatchObject({ branch: null, head: null })
})

test('pickRemote prefers origin, else the first', () => {
  expect(pickRemote('remote.upstream.url git@a:x.git\nremote.origin.url git@b:y.git\n')).toBe('git@b:y.git')
  expect(pickRemote('remote.fork.url git@a:x.git\n')).toBe('git@a:x.git')
  expect(pickRemote('')).toBeNull()
})

describe('resolveRoot', () => {
  test('refuses what is not an absolute, existing folder', () => {
    expect(resolveRoot('')).toHaveProperty('refused')
    expect(resolveRoot('code')).toMatchObject({ refused: expect.stringMatching(/absolute/) })
    expect(resolveRoot('/no/such/folder/here')).toMatchObject({ refused: expect.stringMatching(/does not exist/) })
  })

  test('~/ is the home folder', () => {
    expect(resolveRoot('~')).toHaveProperty('root')
  })
})

// ─── against real repositories ──────────────────────────────────────────────

let dir: string
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}
const repo = (rel: string) => {
  const p = join(dir, rel)
  mkdirSync(p, { recursive: true })
  sh(p, 'init', '-q', '-b', 'main')
  return p
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-git-'))
  const a = repo('work/alpha')
  writeFileSync(join(a, 'README'), 'x')
  sh(a, 'add', '.'); sh(a, 'commit', '-q', '-m', 'first')
  sh(a, 'remote', 'add', 'origin', 'https://me:tok@example.test/alpha.git')
  writeFileSync(join(a, 'dirty.txt'), 'y')
  repo('work/alpha/vendor-copy')            // inside a repository: not a second project
  repo('beta')                              // no commit at all
  repo('work/node_modules/pkg')             // skipped by name
  repo('.hidden/gamma')                     // skipped as hidden
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('finds the projects, not what sits inside one or under node_modules', () => {
  const { dirs } = findRepoDirs(dir)
  expect(dirs.map(d => d.slice(dir.length + 1)).sort()).toEqual(['beta', 'work/alpha'])
})

test('a scan stops at the limit and says so', () => {
  expect(findRepoDirs(dir, { limit: 1 })).toMatchObject({ truncated: true, dirs: [expect.any(String)] })
})

test('each repository is described by git itself, the token cut from its remote', async () => {
  const { repos } = await listLocalRepos(dir)
  const alpha = repos.find(r => r.name === 'alpha')!
  // dirty.txt, and the nested checkout git reports as one untracked entry
  expect(alpha).toMatchObject({ relative: 'work/alpha', branch: 'main', changes: 2, remote: 'https://example.test/alpha.git', lastCommit: 'first' })
  expect(alpha.head).toMatch(/^[0-9a-f]{7}$/)
  const beta = repos.find(r => r.name === 'beta')!
  expect(beta).toMatchObject({ branch: 'main', head: null, lastCommitAt: null, remote: null })
})

// A downloaded tree can carry a .git/config naming a command, and `git status`
// runs `core.fsmonitor` — a scan must not start it.
test('a repository\'s fsmonitor command is not run by a scan', async () => {
  const evil = repo('evil')
  const marker = join(dir, 'fsmonitor-ran')
  const hook = join(dir, 'hook.sh')
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`)
  chmodSync(hook, 0o755)
  sh(evil, 'config', 'core.fsmonitor', hook)
  await listLocalRepos(dir)
  expect(existsSync(marker)).toBe(false)
})
