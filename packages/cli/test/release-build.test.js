// ─── release-build.test.js — what a release is built from ───────────────────
//
// `stageRelease` is the one source both doors of `fli deploy` build (FJS-D1967,
// FJS-D1968): HEAD as committed, the Dockerfile judged against that tree, the
// web env asserted. Run over a real temp git repository, because a fake `git`
// would agree with anything.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync }                                     from 'child_process'
import { tmpdir }                                        from 'os'
import { join }                                          from 'path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'

import { stageRelease, webBuildEnv, envPrefix } from '../core/release-build.js'

let repo
const warnings = []
const log = { warn: (m) => warnings.push(m), info() {}, detail() {}, done() {} }

const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], { cwd: repo, encoding: 'utf8' })
const put = (rel, text) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text) }

/** One commit: an app with a source file and deploy/Dockerfile that installs from nothing. */
beforeEach(() => {
  warnings.length = 0
  repo = mkdtempSync(join(tmpdir(), 'fjs-release-'))
  put('api/index.js', 'export const v = 1\n')
  put('deploy/Dockerfile', 'FROM busybox:1.36\nCOPY api /api\n')
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'v1')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const stage = (opts = {}) => {
  const staged = stageRelease({ appRoot: repo, log, ...opts })
  cleanups.push(staged.cleanup)
  return staged
}
let cleanups = []
afterEach(() => { for (const c of cleanups) c(); cleanups = [] })

describe('stageRelease', () => {
  test('stages the commit, and names its sha', () => {
    const s = stage()
    expect(s.sha).toBe(git('rev-parse', 'HEAD').stdout.trim())
    expect(s.short).toBe(git('rev-parse', '--short', 'HEAD').stdout.trim())
    expect(readFileSync(join(s.dir, 'api/index.js'), 'utf8')).toBe('export const v = 1\n')
    expect(s.dirty).toEqual([])
  })

  test('an uncommitted edit is not in dir, and is reported dirty', () => {
    put('api/index.js', 'export const v = 2\n')
    put('api/new.js', 'export const n = 1\n')
    const s = stage()
    expect(readFileSync(join(s.dir, 'api/index.js'), 'utf8')).toBe('export const v = 1\n')
    expect(existsSync(join(s.dir, 'api/new.js'))).toBe(false)
    expect(s.dirty.length).toBe(2)
    expect(warnings[0]).toContain('2 uncommitted change(s)')
  })

  test('an app inside a bigger repository stages its own directory, pathspec-scoped', () => {
    put('other/x.js', 'x\n')
    put('app/api/index.js', 'a\n')
    put('app/deploy/Dockerfile', 'FROM busybox:1.36\n')
    git('add', '.'); git('commit', '-q', '-m', 'v2')
    put('other/x.js', 'changed\n')
    const s = stageRelease({ appRoot: join(repo, 'app'), log })
    cleanups.push(s.cleanup)
    expect(s.appRel).toBe('app')
    expect(existsSync(join(s.dir, 'api/index.js'))).toBe(true)
    expect(existsSync(join(s.dir, 'other'))).toBe(false)
    expect(s.dirty).toEqual([])
  })

  test('an untracked Dockerfile is never chosen', () => {
    put('Dockerfile', 'FROM scratch\n')
    const s = stage()
    expect(s.dockerfile).toBe('deploy/Dockerfile')
    expect(existsSync(join(s.dir, 'Dockerfile'))).toBe(false)
  })

  test('a repository with no Dockerfile committed reports none present', () => {
    git('rm', '-q', 'deploy/Dockerfile'); git('commit', '-q', '-m', 'drop')
    put('Dockerfile', 'FROM scratch\n')
    const s = stage()
    expect(s.present).toBe(false)
    expect(s.vendors).toBe(false)
  })

  test('the told Dockerfile wins over the stored copy and the default', () => {
    put('ops/Dockerfile.prod', 'FROM busybox:1.36\n')
    git('add', '.'); git('commit', '-q', '-m', 'ops')
    const s = stage({ told: 'ops/Dockerfile.prod', stored: 'FROM stored\n' })
    expect(s.dockerfile).toBe('ops/Dockerfile.prod')
    expect(s.present).toBe(true)
    expect(existsSync(join(s.dir, 'Dockerfile.basecamp'))).toBe(false)
  })

  test('a stored copy lands in dir and the working tree is unchanged', () => {
    const s = stage({ stored: 'FROM stored\n' })
    expect(s.dockerfile).toBe('Dockerfile.basecamp')
    expect(readFileSync(join(s.dir, 'Dockerfile.basecamp'), 'utf8')).toBe('FROM stored\n')
    expect(existsSync(join(repo, 'Dockerfile.basecamp'))).toBe(false)
    expect(git('status', '--porcelain').stdout.trim()).toBe('')
  })

  test('vendors follows the Dockerfile text, and a comment does not count', () => {
    const plain = stage({ dry: true })
    expect(plain.vendors).toBe(false)

    const comment = stage({ dry: true, stored: '# installs from deploy/generated\nFROM busybox:1.36\n' })
    expect(comment.vendors).toBe(false)

    const installs = stage({ dry: true, stored: 'FROM oven/bun\nCOPY deploy/generated/ ./deploy/generated/\n' })
    expect(installs.vendors).toBe(true)
    expect(existsSync(join(installs.dir, 'deploy/generated'))).toBe(false)
  })

  test('image: false chooses no Dockerfile and vendors nothing', () => {
    const s = stage({ image: false })
    expect(s.dockerfile).toBeNull()
    expect(s.vendors).toBe(false)
  })

  test('a repository with no commit refuses by name', () => {
    const bare = mkdtempSync(join(tmpdir(), 'fjs-release-bare-'))
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: bare })
      expect(() => stageRelease({ appRoot: bare, log })).toThrow('not inside a git repository with a commit')
    } finally { rmSync(bare, { recursive: true, force: true }) }
  })

  test('cleanup removes the scratch directory', () => {
    const s = stageRelease({ appRoot: repo, log })
    expect(existsSync(s.dir)).toBe(true)
    s.cleanup()
    expect(existsSync(s.dir)).toBe(false)
  })
})

describe('webBuildEnv', () => {
  test('carries the build stamp, and the API origin only when there is one', () => {
    expect(webBuildEnv({ commit: 'abc1234', apiOrigin: null })).toEqual({ VITE_FJS_BUILD: 'abc1234' })
    expect(webBuildEnv({ commit: 'abc1234' })).toEqual({ VITE_FJS_BUILD: 'abc1234' })
    expect(webBuildEnv({ commit: 'abc1234', apiOrigin: 'https://api.example.com' }))
      .toEqual({ VITE_FJS_BUILD: 'abc1234', FRONTIER_PUBLIC_API_URL: 'https://api.example.com' })
  })

  test('refuses a commit that is not a sha', () => {
    for (const bad of ['', 'main', 'abc12', 'abc1234; rm -rf /', undefined, null])
      expect(() => webBuildEnv({ commit: bad })).toThrow('is not a sha')
  })

  test('envPrefix is the shell form', () => {
    expect(envPrefix(webBuildEnv({ commit: 'abc1234', apiOrigin: 'https://a.example.com' })))
      .toBe('VITE_FJS_BUILD=abc1234 FRONTIER_PUBLIC_API_URL=https://a.example.com')
  })
})
