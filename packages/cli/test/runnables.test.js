// runnables.test.js — what can run in this project.
//
// The engine behind the control surface's inventory, and what is worth testing
// is the READERS, for `repo-map.test.js`'s reason one door over: each one parses
// a file a human wrote and may reshape, and a reader that silently returns
// nothing is a group missing from the page — which reads as a project that does
// not have one rather than as a reader that stopped working.
//
// Two properties get their own tests because the page rests on them. Ids must be
// unique, since `/api/state` answers under them and a collision makes one row
// wear another's state. And the list must be deterministic: `repo-map` renders a
// COMMITTED file from these same readers, so an unstable order is a snapshot
// that fails on a tree nobody touched.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { runnables, probeState, KINDS, appDirs, driveRows, readCommands } from '../core/runnables.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// The broker sets these for a scaffolded app and they beat the formula, so a
// suite inheriting them from the shell would assert against whatever port the
// last `fli` run happened to claim.
const SAVED = { fe: process.env.FLI_PORT_FE, be: process.env.FLI_PORT_BE }

let root

function write(rel, body) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

beforeAll(() => {
  delete process.env.FLI_PORT_FE
  delete process.env.FLI_PORT_BE

  root = mkdtempSync(join(tmpdir(), 'fli-runnables-'))

  // The workspace's own scripts — tasks, and a `test` that fans out.
  write('package.json', JSON.stringify({
    name: 'ws', scripts: { ci: 'node scripts/ci.mjs', test: "bun run --filter '*' test" },
  }))

  // An app: a seed makes it one (`checks.js`'s findApps), and two surfaces.
  write('shop/db/schema.lite', 'model Order {\n  id Int @id\n}\n')
  write('shop/api/index.ts', '')
  write('shop/web/index.html', '')
  write('shop/package.json', JSON.stringify({
    name: 'shop',
    // `web` is deliberately absent: a surface the app declares no script for
    // must keep its row.
    scripts: { api: 'bun run api/index.ts', test: 'bun test', 'verify:live': 'node test/live.mjs' },
  }))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  if (SAVED.fe !== undefined) process.env.FLI_PORT_FE = SAVED.fe
  if (SAVED.be !== undefined) process.env.FLI_PORT_BE = SAVED.be
})

const rows  = () => runnables(root)
const kind  = k => rows().filter(r => r.kind === k)
const byId  = id => rows().find(r => r.id === id)

describe('the shape', () => {
  test('every row carries the keys a tile reads', () => {
    for (const r of rows()) {
      expect(KINDS).toContain(r.kind)
      expect(typeof r.id).toBe('string')
      expect(r.id.length).toBeGreaterThan(0)
      expect(typeof r.name).toBe('string')
      expect(typeof r.dir).toBe('string')
      expect(Array.isArray(r.needs)).toBe(true)
      // Stated, never absent: `null` is *nothing here starts it* and a missing
      // key is a reader that forgot.
      expect(r).toHaveProperty('start')
      expect(r).toHaveProperty('port')
      expect(r).toHaveProperty('open')
      expect(typeof r.source).toBe('string')
    }
  })

  test('ids are unique, because state is answered under them', () => {
    const ids = rows().map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('two collects over one tree answer one list', () => {
    expect(JSON.stringify(rows())).toBe(JSON.stringify(rows()))
  })
})

describe('surfaces', () => {
  test('a seed makes a directory an app, and its surfaces take the formula\'s ports', () => {
    const api = byId('surface:shop/api')
    const web = byId('surface:shop/web')

    // scaffold = project 0, so dev/be is 8100 and dev/fe is 8000.
    expect(api.port).toBe(8100)
    expect(web.port).toBe(8000)
    expect(api.start).toBe('bun run api')
    expect(api.open).toBe('http://localhost:8100')
    expect(api.dir).toBe('shop')
  })

  test('a surface with no script keeps its row and says so', () => {
    // The directory exists and nothing here starts it, which is a different
    // sentence from the surface not being there — dropping the row makes the
    // two look identical.
    expect(byId('surface:shop/web').start).toBeNull()
  })

  test('a directory with no seed is not an app', () => {
    mkdirSync(join(root, 'notanapp', 'api'), { recursive: true })
    writeFileSync(join(root, 'notanapp', 'package.json'), '{"name":"notanapp"}')
    expect(kind('surface').some(r => r.dir === 'notanapp')).toBe(false)
    rmSync(join(root, 'notanapp'), { recursive: true, force: true })
  })
})

describe('drives, suites and tasks', () => {
  test('a verify* script is a drive and not a suite', () => {
    const drive = byId('drive:shop/verify:live')
    expect(drive.start).toBe('bun run verify:live')
    expect(drive.dir).toBe('shop')
    expect(kind('suite').some(r => r.name === 'verify:live')).toBe(false)
  })

  test("a suite runs the package's OWN runner, from the package's directory", () => {
    const suite = byId('suite:shop')
    // `bun test` instead of `bun run test` runs bun's own runner over whatever
    // it finds, which is the trap this field exists for.
    expect(suite.start).toBe('bun run test')
    expect(suite.dir).toBe('shop')
  })

  test('the workspace root is a task, never a suite', () => {
    // The root's `test` fans out to every member; behind a button that looks
    // like one package's, it is a twenty-package run nobody asked for.
    expect(kind('suite').some(r => r.dir === '.')).toBe(false)
    expect(byId('task:ci').start).toBe('bun run ci')
    expect(byId('task:test')).toBeTruthy()
  })
})

describe('tools', () => {
  const tools = () => runnables(REPO).filter(r => r.kind === 'tool')

  test('every reserved slot is a row, derived from ports.js', () => {
    const names = tools().map(t => t.name).sort()
    expect(names).toContain('gui')
    expect(names).toContain('studio')
    expect(names).toContain('devtools')
  })

  test('the command that starts one is matched by its own port default', () => {
    const gui = tools().find(t => t.name === 'gui')
    expect(gui.port).toBe(8500)
    // The alias, because that is what a person types and what every example uses.
    expect(gui.start).toBe('fli gui')
    expect(gui.source).toMatch(/commands\/fli\/gui\.md$/)
  })

  test('a slot no command claims answers null rather than a guess', () => {
    // devtools is the honest case and the only one left: an APP configures it,
    // through `app.configure(devtools())`, so `fli` cannot start it and a
    // plausible command here would be a guess that fails when pressed.
    expect(tools().find(t => t.name === 'devtools').start).toBeNull()
  })

  test('studio is startable, because its command and the schema agree on 8502', () => {
    // This assertion is the whole of `FJS-557`. The reserved slot answered
    // nothing and the tool ran on 5001, which the scheme had never heard of —
    // so the documented port was free and the tool was outside the range. The
    // symptom was this tile having no start button, and it is the only thing
    // that noticed.
    const studio = tools().find(t => t.name === 'studio')
    expect(studio.port).toBe(8502)
    expect(studio.start).toBe('fli studio')
    expect(studio.source).toMatch(/commands\/db\/studio\.md$/)
  })
})

describe('the tools group is derived, not listed', () => {
  // The claim step 6 rests on: a slot added to `ports.js` § GLOBAL is a tile
  // with nothing edited here. A hand-written name→command table would be the
  // one list in this module that could go stale, and it would go stale exactly
  // when somebody reserves a port — which is the moment they most need to see
  // it on the page.
  test('a new reserved slot becomes a row with no edit to this module', async () => {
    const { GLOBAL } = await import('../core/ports.js')
    const before = runnables(REPO).filter(r => r.kind === 'tool').length

    GLOBAL.__probe = 8509
    try {
      const tools = runnables(REPO).filter(r => r.kind === 'tool')
      expect(tools.length).toBe(before + 1)

      const added = tools.find(t => t.name === '__probe')
      expect(added.port).toBe(8509)
      // No command declares 8509, so it answers null rather than a guess.
      expect(added.start).toBeNull()
      expect(added.source).toBe('packages/cli/core/ports.js')
    } finally {
      delete GLOBAL.__probe
    }
  })
})

describe('probeState', () => {
  const rows = [
    { id: 'a', port: 65535 },   // nothing will be listening here
    { id: 'b', port: null   },
  ]
  const ports = {
    busyPorts:        async (list) => list.filter(r => r.port === 1234),
    getSessionStatus: () => [],
  }

  test('a row with no port is unknown, never down', async () => {
    // *Nothing here can tell* is a different sentence from *not running*, and
    // collapsing them makes every drive and every suite read as stopped.
    const state = await probeState(rows, { ports })
    expect(state.b.state).toBe('unknown')
    expect(state.a.state).toBe('down')
  })

  test('a claimed port that answers nothing is its own state', async () => {
    const claimed = {
      busyPorts:        async () => [],
      getSessionStatus: () => [{ ports: { fe: [65535] } }],
    }
    const state = await probeState(rows, { ports: claimed })
    expect(state.a.state).toBe('claimed-dead')
  })

  test('a child is reported for every kind, including the rows with no port', async () => {
    // Without this a page could start a suite — which has no port and is
    // therefore `unknown` — and then show no way to stop it.
    const state = await probeState(rows, {
      ports,
      childOf: (id) => id === 'b' ? { pid: 99, startedAt: 1, exit: null } : null,
    })
    expect(state.b).toEqual({ state: 'unknown', pid: 99, startedAt: 1, exit: null, last: null })

    // The other reader on the same row, and it outlives the child: a suite is
    // `unknown` forever, which answers *is it running* and says nothing about
    // whether it passed. A row this page never ran carries no record rather
    // than a blank one, so `never run here` and `ran and failed` cannot read
    // the same on screen.
    const withLast = await probeState(rows, {
      ports,
      childOf: () => null,
      lastOf:  (id) => id === 'b' ? { at: 5, ms: 120, exit: { code: 1 }, stopped: false } : null,
    })
    expect(withLast.b.last.exit.code).toBe(1)
    expect(withLast.a.last).toBeUndefined()
    expect(state.a.pid).toBeUndefined()
  })
})

describe('the readers repo-map shares', () => {
  test('appDirs finds the root, its children and packages/*', () => {
    const dirs = appDirs(root).map(d => d.replace(root, '.') || '.')
    expect(dirs).toContain('.')
    expect(dirs.some(d => d.endsWith('shop'))).toBe(true)
  })

  test('driveRows is what repo-map renders as its drive table', () => {
    expect(driveRows(root)).toEqual([{ where: 'shop', script: 'verify:live', run: 'node test/live.mjs' }])
  })

  test('readCommands reads the name a person types and the port a flag declares', () => {
    const dir = join(REPO, 'packages', 'cli', 'commands')
    const cmds = readCommands(dir, REPO, [])
    const gui = cmds.find(c => c.name === 'fli:gui')
    expect(gui.alias).toBe('gui')
    expect(gui.port).toBe(8500)
    // Almost every command takes no port, and null is the answer for those.
    expect(cmds.filter(c => c.port !== null).length).toBeLessThan(cmds.length / 2)
  })
})

describe('sources', () => {
  test('every row names a file that exists', () => {
    for (const r of rows()) {
      const base = r.source.startsWith('packages/') ? REPO : root
      expect(existsSync(join(base, r.source))).toBe(true)
    }
  })

  // Over the REAL tree, because the fixture has no snapshots and no packages —
  // and the kinds a fixture cannot produce are the ones that went wrong. The
  // snapshot rows joined `dir` to a `file` that was already a path from the
  // root, so every id and every source named
  // `example/db/example/db/access.snapshot.md`: a file that resolves to
  // nothing, which reads as a snapshot that has gone missing.
  test('and that holds for the kinds only a real workspace has', () => {
    const real = runnables(REPO)
    const kinds = new Set(real.map(r => r.kind))
    expect(kinds.has('snapshot')).toBe(true)
    expect(kinds.has('suite')).toBe(true)

    const missing = real.filter(r => !existsSync(join(REPO, r.source)))
    expect(missing.map(r => `${r.id} → ${r.source}`)).toEqual([])

    const ids = real.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Every row that can be started carries the command as ARGV, so a runner
  // needs no shell and no re-split. A string would have to be parsed by
  // whoever runs it, and that parser is where a command with a space in it
  // becomes two commands.
  test('a startable row carries argv, and it matches what it displays', () => {
    for (const r of runnables(REPO)) {
      if (!r.start) { expect(r.argv).toBeNull(); continue }
      expect(Array.isArray(r.argv)).toBe(true)
      expect(r.argv.join(' ')).toBe(r.start)
    }
  })
})
