/**
 * web/test/verify-ledger.mjs — `/ledger` in the workshop. Started by
 * `bun run verify:ledger`; needs no Chrome and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam's
 * `HAVEN_LEDGER_ROOT` is a root made here, with three packages and an
 * `ISSUES.md` of a few rows, so the count never writes this tree's
 * `ledger.data.js`. Sam walks into the workshop drawn from the committed
 * snapshot; `/ledger` writes the root's file and the room is mounted again on
 * its counts — the legend's totals are the root's — and a second `/ledger`
 * says nothing moved. A row added to the register and a third `/ledger`
 * redraws again. A root with no register has no `/ledger`.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - A scene opens in NORMAL, so the first `/` command is typed after an `i`;
 *   after Enter it is still in INSERT. A remount opens the scene in NORMAL again.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { cellOf, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'
import { dataFile } from '../src/lib/hash/ledger.js'

const WEB      = join(import.meta.dir, '..')
const square   = await stageOf('Square')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

// ─── a root with a small register ─────────────────────────────────────

const samHome = mkdtempSync(join(tmpdir(), 'haven-sam-'))
const fake    = mkdtempSync(join(tmpdir(), 'haven-ledger-root-'))
const bare    = mkdtempSync(join(tmpdir(), 'haven-bare-'))
for (const p of ['litestone', 'mesa', 'haven']) {
  mkdirSync(join(fake, 'packages', p), { recursive: true })
  writeFileSync(join(fake, 'packages', p, 'package.json'), '{}')
}
mkdirSync(join(fake, 'packages/haven/web/src/lib/hash'), { recursive: true })
const row = (id, pkg) => `| <a id="fjs-${id}"></a>FJS-${id} | ${pkg} | a title |`
const register = (rows) => writeFileSync(join(fake, 'ISSUES.md'), ['# Issues', '', '## S2 — serious', '', row(1, 'litestone'), '## S3 — minor', '', ...rows].join('\n'))
register([row(2, 'mesa'), row(3, 'mesa')])

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-ledger', port: 0 }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')

const KEY = { '0,-1': '\x1b[A', '0,1': '\x1b[B', '1,0': '\x1b[C', '-1,0': '\x1b[D' }

/** The cells from `from` to `to` over floor, by breadth first; `to` may be a door. */
function route(stage, from, to) {
  const prev = new Map([[`${from.x},${from.y}`, null]])
  const queue = [from]
  while (queue.length) {
    const c = queue.shift()
    if (c.x === to.x && c.y === to.y) break
    for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
      const n = { x: c.x + dx, y: c.y + dy }
      const k = `${n.x},${n.y}`
      if (prev.has(k) || !(stage.walkable(n.x, n.y) || (n.x === to.x && n.y === to.y))) continue
      prev.set(k, c)
      queue.push(n)
    }
  }
  const cells = []
  for (let c = to; c; c = prev.get(`${c.x},${c.y}`)) cells.unshift(c)
  return cells[0]?.x === from.x && cells[0]?.y === from.y ? cells : null
}

/** Sam's terminal walked into the workshop, with `root` as the ledger's. */
async function walkIn(root) {
  const term = terminal(API, sam.token, square, { HOME: samHome, HAVEN_LEDGER_ROOT: root })
  const at = (x, y) => cellOf(term.screen(), x, y, 1, square)
  await until(() => term.screen().includes('j/k moves, Enter opens'))
  term.shell.stdin.write('\r')
  await until(() => at(square.spawn.x, square.spawn.y) === '@')
  const cells = route(square, square.spawn, square.doors.find((d) => d.to === '/workshop/'))
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i]
    term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    const last = i === cells.length - 1
    await until(() => last ? term.screen().includes('The workshop · 1 here') : at(b.x, b.y) === '@', 3000)
  }
  return term
}

/** A command typed into the line; a scene opens in NORMAL, which `i` leaves, and Enter stays in INSERT. */
const say = (term, line) => term.shell.stdin.write(`${term.screen().includes('-- NORMAL') ? 'i' : ''}${line}\r`)

async function quit(term) {
  term.shell.stdin.write('\x03')
  const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
  if (code === 'timeout') term.shell.kill('SIGKILL')
  return code
}

// ─── the snapshot, then the root's count ──────────────────────────────

const { LEDGER } = await import('../src/lib/hash/ledger.data.js')
const total = (s) => Object.values(LEDGER).reduce((n, c) => n + c[s], 0)
const SNAPSHOT = `━ S3 ${total('S3')}   ━ S4 ${total('S4')} ]`
const COUNTED  = '━ S1 0   ━ S2 1   ━ S3 2   ━ S4 0 ]'

let term = await walkIn(fake)
check(term.screen().includes('The workshop · 1 here') && term.screen().includes(SNAPSHOT),
  'Sam walks into the workshop drawn from the committed snapshot', term.screen())

say(term, '/ledger')
check(await until(() => term.screen().includes(COUNTED) && term.screen().includes('The workshop · 1 here'), 8000),
  '/ledger mounts the room again on the root\'s count: the legend\'s totals are its register\'s', term.screen())
check(readFileSync(dataFile(fake), 'utf8').includes('mesa: { S1: 0, S2: 0, S3: 2, S4: 0 },'),
  'and writes the root\'s ledger.data.js', readFileSync(dataFile(fake), 'utf8'))

say(term, '/ledger')
check(await until(() => term.screen().includes('the ledger is as it was — 3 open')),
  'a second /ledger says nothing moved, and the room stays', term.screen())

register([row(2, 'mesa'), row(3, 'mesa'), row(4, 'litestone')])
say(term, '/ledger')
check(await until(() => term.screen().includes('━ S1 0   ━ S2 1   ━ S3 3   ━ S4 0 ]'), 8000),
  'a row added to the register and a third /ledger redraws again', term.screen())
check(await quit(term) === 0, 'Ctrl+C exits 0')

// ─── a root with no register ──────────────────────────────────────────

term = await walkIn(bare)
say(term, '/ledger')
check(await until(() => term.screen().includes('no command /ledger')), 'a root with no ISSUES.md has no /ledger', term.screen())
await quit(term)

// ─── done ─────────────────────────────────────────────────────────────

await env.close()
for (const d of [samHome, fake, bare]) rmSync(d, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
