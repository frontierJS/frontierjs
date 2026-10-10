// ─── preview.test.js — a preview branch changes web/ and nothing else ───────
//
// Real git throughout: a clone (so origin/HEAD is set the way a clone sets it),
// a linked worktree on a wb/* branch, and the marker written where Open writes
// it. The rule is graded through `runChecks`, the door `fli check` uses.

import { describe, test, expect, afterAll, beforeAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runChecks } from '../core/checks.js'
import { MARKER, markerPath, markPreview, previewScope } from '../core/preview.js'

const dir  = mkdtempSync(join(tmpdir(), 'fli-preview-'))
const src  = join(dir, 'src')
const work = join(dir, 'work')
const wt   = join(dir, 'wt')
const git  = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const put  = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
const check = () => runChecks({ root: wt, only: ['preview-ui-only'] })

beforeAll(() => {
  git(dir, 'init', '-q', '-b', 'main', src)
  git(src, 'config', 'user.email', 'test@example.test')
  git(src, 'config', 'user.name', 'Test')
  put(src, 'web/src/Page.mesa', '<h1>Hi</h1>\n')
  put(src, 'db/schema.lite', 'model Lead { id Int @id }\n')
  git(src, 'add', '.')
  git(src, 'commit', '-q', '-m', 'base')
  git(dir, 'clone', '-q', src, work)
  git(work, 'config', 'user.email', 'test@example.test')
  git(work, 'config', 'user.name', 'Test')
  git(work, 'worktree', 'add', '-q', '-b', 'wb/trial', wt)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('a directory outside any checkout cannot be marked', () => {
  expect(() => markPreview(tmpdir())).toThrow(/not in a git checkout/)
})

describe('preview-ui-only', () => {

  test('a worktree with no marker is not a preview, and the rule says it skipped', () => {
    put(wt, 'db/schema.lite', 'model Lead { id Int @id  name String }\n')
    const out = check()
    expect(out.skipped).toEqual([{ rule: 'preview-ui-only', why: expect.stringContaining(MARKER) }])
    expect(out.findings).toEqual([])
    git(wt, 'checkout', '--', 'db/schema.lite')
  })

  test('the marker is in the worktree\'s own git directory, so the tree stays clean', () => {
    expect(markPreview(wt)).toBe(markerPath(wt))
    expect(markerPath(wt)).toContain(join('.git', 'worktrees'))
    expect(markerPath(work)).not.toBe(markerPath(wt))
    expect(git(wt, 'status', '--porcelain')).toBe('')
  })

  test('a .mesa edit passes', () => {
    put(wt, 'web/src/Page.mesa', '<h1>Hello</h1>\n')
    put(wt, 'web/src/New.mesa', '<p>new</p>\n')
    const out = check()
    expect(out.ran).toEqual(['preview-ui-only'])
    expect(out.findings).toEqual([])
  })

  test('a .lite edit fails, named — uncommitted, committed or untracked alike', () => {
    put(wt, 'db/schema.lite', 'model Lead { id Int @id  name String }\n')
    expect(check().findings.map(f => f.file)).toEqual([join(wt, 'db/schema.lite')])

    git(wt, 'add', '.')
    git(wt, 'commit', '-q', '-m', 'schema too')
    put(wt, 'api/src/new.service.ts', 'export {}\n')
    const out = check()
    expect(out.findings.map(f => f.file)).toEqual([join(wt, 'api/src/new.service.ts'), join(wt, 'db/schema.lite')])
    expect(out.findings[0]).toMatchObject({ severity: 'error', message: expect.stringContaining('origin/main') })
  })

  test('the base is where the branch meets origin/HEAD, not the fork point', () => {
    // A commit on the parent that origin never saw is in the pull request too.
    rmSync(join(wt, 'api'), { recursive: true })
    git(wt, 'reset', '-q', '--hard', 'origin/main')
    put(work, 'db/schema.lite', 'model Lead { id Int @id  phone String }\n')
    git(work, 'commit', '-q', '-am', 'unpushed')
    git(wt, 'reset', '-q', '--hard', 'main')
    expect(previewScope(wt, join(wt, 'web'))).toMatchObject({ preview: true, into: 'origin/main', outside: ['db/schema.lite'] })
  })

  test('with origin/HEAD unset there is nothing to grade from, and that is a red', () => {
    git(work, 'remote', 'set-head', 'origin', '--delete')
    const out = check()
    expect(out.findings).toEqual([expect.objectContaining({ file: wt, message: expect.stringContaining('origin/HEAD is not set') })])
    git(work, 'remote', 'set-head', 'origin', 'main')
  })

})
