// lanes.test.js — a lane sync survives the main tree changing under it.
//
// FJS-2776: the sync copies every untracked file of the main tree, and another
// session's test deletes its scratch files while that runs. A copy that threw
// on the vanished one meant the row never started.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { spawnSync } from 'node:child_process'

import { copyIfPresent, lanePatch } from '../../../scripts/lanes.mjs'

let base
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'fjs-lanes-test-')) })
afterEach(()  => rmSync(base, { recursive: true, force: true }))

describe('copyIfPresent', () => {
  test('copies a file into a directory that does not exist yet', () => {
    mkdirSync(join(base, 'main'))
    writeFileSync(join(base, 'main', 'a.js'), 'x')
    const dest = join(base, 'lane', 'deep', 'a.js')
    expect(copyIfPresent(join(base, 'main', 'a.js'), dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('x')
  })

  test('a source deleted since it was listed is skipped, not thrown', () => {
    const dest = join(base, 'lane', 'gone.js')
    expect(copyIfPresent(join(base, 'main', 'gone.js'), dest)).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })

  test('a failure that is not a vanished source still throws', () => {
    writeFileSync(join(base, 'src.js'), 'x')
    writeFileSync(join(base, 'blocker'), 'a file where the destination needs a directory')
    expect(() => copyIfPresent(join(base, 'src.js'), join(base, 'blocker', 'dest.js'))).toThrow()
  })
})

// FJS-3448: the snapshot is `git add -A` over the lane's working files, so a
// sidecar a test was still holding landed in the patch.
describe('lanePatch', () => {
  const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim()

  test('a sierra-fresh sidecar is no part of what the lane changed', () => {
    const dir = join(base, 'repo')
    mkdirSync(join(dir, 'src'), { recursive: true })
    spawnSync('git', ['init', '-q', dir])
    git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'a.js'), 'a')
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
    const lane = { dir, linked: false }
    const before = git(dir, 'rev-parse', 'HEAD^{tree}')

    writeFileSync(join(dir, 'real.js'), 'kept')
    writeFileSync(join(dir, 'src', '.sierra-fresh-123-0-meta.js'), 'scratch')
    const patch = lanePatch(lane, before).toString()
    expect(patch).toContain('real.js')
    expect(patch).not.toContain('sierra-fresh')
  })
})
