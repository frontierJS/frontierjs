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

import { copyIfPresent, lanePatch, laneDirty, markSynced, dropStaleDatabases, releaseLane, stopLeftovers } from '../../../scripts/lanes.mjs'
import { readLock } from '../core/ports.js'

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

// FJS-3804, FJS-D2047: a lane is a worktree that stays checked out between
// runs, so the branch block its drive claimed was never given back; five lanes
// and agent worktrees held all five and the next drive's portFor threw.
describe('releaseLane', () => {
  test('forgets every app root inside the lane and nothing outside it', () => {
    const lockFile = join(base, 'sessions.lock')
    const lane = join(base, 'frontierjs-3')
    const entry = (branch, worktree) => ({ branch, repo: '/m/.git', worktree, slot: 0, env: 'dev' })
    writeFileSync(lockFile, JSON.stringify({
      [join(lane, 'packages', 'basecamp')]:      entry(3, lane),
      [join(lane, 'example')]:                   entry(3, lane),
      [`${lane}-other/example`]:                 entry(4, `${lane}-other`),
      '/m/example':                              { slot: 0, env: 'dev' },
    }))

    releaseLane({ dir: lane }, { lockFile })

    expect(Object.keys(readLock(lockFile)).sort()).toEqual(['/m/example', `${lane}-other/example`])
  })
})

// FJS-4625: a server the last session left running in a lane held 37110 for
// a day, and every later row's drive refused the port it already answered.
describe('stopLeftovers', () => {
  // Orphaned through `sh`, so its death is reaped and never read as a zombie.
  const startIn = cwd => {
    mkdirSync(cwd, { recursive: true })
    const out = spawnSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { cwd, encoding: 'utf8' })
    return Number(out.stdout.trim())
  }
  const running = pid => {
    try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false }
  }
  const pids = []
  afterEach(() => { for (const p of pids.splice(0)) try { process.kill(p, 'SIGKILL') } catch {} })

  test('stops what runs inside the lane, deleted or not, and nothing beside it', () => {
    const lane = join(base, 'frontierjs-1')
    const inside = startIn(join(lane, 'example'))
    const gone = startIn(join(lane, 'scratch'))
    const beside = startIn(join(base, 'frontierjs-10'))
    pids.push(inside, gone, beside)
    rmSync(join(lane, 'scratch'), { recursive: true, force: true })

    const stopped = stopLeftovers({ dir: lane })

    expect(stopped.sort()).toEqual([inside, gone].sort())
    expect(running(inside)).toBe(false)
    expect(running(gone)).toBe(false)
    expect(running(beside)).toBe(true)
  })
})

// FJS-3448: the snapshot is `git add -A` over the lane's working files, so a
// sidecar a test was still holding landed in the patch.
// FJS-3945: a reused lane keeps the gitignored database an earlier drive made,
// and a schema change since then blocks the next seed.
describe('dropStaleDatabases', () => {
  test('removes ignored runtime databases and nothing else ignored or tracked', () => {
    const dir = join(base, 'repo')
    mkdirSync(join(dir, 'app', 'db', 'shops'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    spawnSync('git', ['init', '-q', dir])
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndb/*.db*\napp/db/*.db*\napp/db/shops/\n.env\n')
    writeFileSync(join(dir, 'app', 'db', 'schema.lite'), 'model A {}')
    spawnSync('git', ['-C', dir, 'add', '-A'])
    for (const f of ['app/db/shop.db', 'app/db/shop.db-wal', 'app/db/shops/a.db', 'node_modules/x/index.js', '.env']) writeFileSync(join(dir, f), 'x')

    dropStaleDatabases(dir)

    for (const f of ['app/db/shop.db', 'app/db/shop.db-wal', 'app/db/shops/a.db']) expect(existsSync(join(dir, f))).toBe(false)
    for (const f of ['app/db/schema.lite', 'node_modules/x/index.js', '.env']) expect(existsSync(join(dir, f))).toBe(true)
  })
})

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

// FJS-D2000: a sync copies the main tree's uncommitted diff in, so `git status`
// is dirty on every working laptop; dirty is measured from the sync marker.
describe('laneDirty', () => {
  const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim()
  const repo = () => {
    const dir = join(base, 'repo')
    mkdirSync(dir, { recursive: true })
    spawnSync('git', ['init', '-q', dir])
    git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'a.js'), 'a')
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
    writeFileSync(join(dir, 'a.js'), 'the main tree\'s uncommitted edit, carried in by the sync')
    return { dir, linked: false }
  }

  test('with no marker, any change counts', () => {
    const lane = repo()
    expect(laneDirty(lane)).toBe(true)
    git(lane.dir, 'checkout', '--', 'a.js')
    expect(laneDirty(lane)).toBe(false)
  })

  test('what the sync wrote is not dirty; what the lane wrote after it is', () => {
    const lane = repo()
    git(lane.dir, 'add', '-A')
    markSynced(lane, git(lane.dir, 'write-tree'))
    expect(laneDirty(lane)).toBe(false)
    writeFileSync(join(lane.dir, 'new.js'), 'a file nothing else has')
    expect(laneDirty(lane)).toBe(true)
    rmSync(join(lane.dir, 'new.js'))
    expect(laneDirty(lane)).toBe(false)
  })
})
