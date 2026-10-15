/**
 * web/test/verify-booth.mjs — two members sit across a tavern table and talk
 * in a booth of their own. Started by `bun run verify:booth`; needs no Chrome
 * and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam and Ana are
 * Sierra's interactive shell under a pty each, in a HOME each. Both walk into
 * the tavern and to the table at (49, 16); Sam sits on the left stool and
 * nothing happens, Ana sits on the right and both screens become the booth.
 * What Sam says is a bubble on the left of his own screen and on the right of
 * Ana's, the next line is under it, and Ana's reply is the other way round.
 * Sam stands up (Esc) beside the stool, Ana's screen says so and keeps the
 * lines; she stands up, and the two are back in the tavern, standing, not
 * sent to the booth again. That a third member reads and says nothing in a
 * booth is `api/test/booth.test.ts`'s, over real sockets.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - A move past 10 a second is dropped by the server, so the walk waits for
 *   the figure at each cell before the next key.
 * - Two members on the stools are asked about by BOTH clients at once; the
 *   booth is made once, and a drive that sat them in the same instant would
 *   find one row, not two.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { cellOf, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB    = join(import.meta.dir, '..')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-booth', port: 0 }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')
const ana = await signIn(env.port, 'ana')
const homes = [mkdtempSync(join(tmpdir(), 'haven-booth-sam-')), mkdtempSync(join(tmpdir(), 'haven-booth-ana-'))]

const KEY = { '0,-1': '\x1b[A', '0,1': '\x1b[B', '1,0': '\x1b[C', '-1,0': '\x1b[D' }

/** The cells from `from` to `to` over floor, by breadth first. */
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

/** A member under a pty: its terminal, and a walk that waits for each step to be on its own screen. */
function member(token, home) {
  const term = terminal(API, token, square, { HOME: home })
  const at = (x, y, stage) => cellOf(term.screen(), x, y, 1, stage)
  async function walk(stage, cells, arrived) {
    if (!cells) return false
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1], b = cells[i]
      term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
      const last = i === cells.length - 1
      if (!await until(() => (last && arrived ? arrived() : at(b.x, b.y, stage) === '@'), 3000)) return false
    }
    return true
  }
  // A route opens in NORMAL, where `i` starts the line (`verify-explore.mjs`).
  async function draft(text) {
    if (!term.screen().includes('-- INSERT --')) {
      term.shell.stdin.write('i')
      await until(() => term.screen().includes('-- INSERT --'))
    }
    term.shell.stdin.write(text)
  }
  const type = (text) => draft(`${text}\r`)
  // The booth candle's tip, the three cells over the `(.)` of its flame; null once it is blown out.
  function tip() {
    const rows = term.screen().split('\n')
    const r = rows.findIndex((l) => l.includes('(.)'))
    return r > 0 ? rows[r - 1].substr(rows[r].indexOf('(.)'), 3) : null
  }
  // The cells where the flame was, two rows over the holder's `_|_`.
  function wick() {
    const rows = term.screen().split('\n')
    const r = rows.findIndex((l) => l.includes('_|_'))
    return r > 1 ? rows[r - 2].substr(rows[r].indexOf('_|_'), 3) : null
  }
  return { term, at, walk, draft, type, tip, wick }
}

const s = member(sam.token, homes[0])
const a = member(ana.token, homes[1])

async function intoTavern(m, who) {
  check(await until(() => m.term.screen().includes('j/k moves, Enter opens')), `${who}: the shell lists the routes`, m.term.screen())
  m.term.shell.stdin.write('\r')
  check(await until(() => m.at(square.spawn.x, square.spawn.y, square) === '@'), `${who}: Enter opens the square`, m.term.screen())
  const door = square.doors.find((d) => d.to === '/tavern/')
  const back = tavern.doors.find((d) => d.to === '/')
  const inside = { x: back.x, y: back.y - 1 }
  check(await m.walk(square, route(square, square.spawn, door), () => m.at(inside.x, inside.y, tavern) === '@' && m.term.screen().includes('The tavern')),
    `${who} comes into the tavern`, m.term.screen())
  return inside
}

const inside = await intoTavern(s, 'Sam')
await intoTavern(a, 'Ana')

// The table at (49, 16): its seats are the stools, and the cell outside each is where a figure stands up.
const table = tavern.marks.find((m) => m.piece?.name === 'table' && m.x === 49 && m.y === 16)
const left  = table.spot('west')
const right = table.spot('east')
const seat  = tavern.seatAt(left.x, left.y)
const outsideLeft = seat.stand
const outsideRight = tavern.seatAt(right.x, right.y).stand
check(table && tavern.walkable(left.x, left.y) && tavern.walkable(right.x, right.y), 'the tavern table at (49, 16) has two stools a figure can stand on')

// ─── sitting ──────────────────────────────────────────────────────────

const wick = { x: table.x + 5, y: table.y + 1 }
check(a.at(wick.x, wick.y, tavern) === '.' && s.at(wick.x, wick.y, tavern) === '.', 'with nobody on a stool the candle is a white dot', a.term.screen())

check(await s.walk(tavern, route(tavern, inside, left)), 'Sam walks onto the left stool', s.term.screen())
await new Promise((r) => setTimeout(r, 800))
check(!s.term.screen().includes('across the table') && s.at(left.x, left.y, tavern) === '@', 'sitting alone takes nobody anywhere', s.term.screen())
check(await until(() => /[i!]/.test(a.at(wick.x, wick.y, tavern) ?? '')), "one on a stool lights it on both screens, Ana's too", a.term.screen())

check(await a.walk(tavern, route(tavern, inside, right), () => /across the table/.test(a.term.screen())), 'Ana walks onto the right stool, and her screen is a booth', a.term.screen())
check(await until(() => /across the table/.test(s.term.screen())), "and Sam's screen is the booth too", s.term.screen())
check(await until(() => /You and ana,/.test(s.term.screen()) && /You and sam,/.test(a.term.screen())), 'each is told whom they are across from', s.term.screen() + a.term.screen())
// Their head faces left, its eye the mirror of `(o`; the bubbles say nothing with an `o)` in it.
const theirFace = (m) => m.term.screen().includes('o)')
check(theirFace(s) && theirFace(a), "each sees the other's head on the right", s.term.screen() + a.term.screen())

// ─── talking ──────────────────────────────────────────────────────────

const rowOf = (m, text) => m.term.screen().split('\n').findIndex((l) => l.includes(text))
const colOf = (m, text) => { const r = m.term.screen().split('\n')[rowOf(m, text)]; return r ? r.indexOf(text) : -1 }

check(s.tip() === ' ) ' && a.tip() === ' ) ', 'the candle burns upright between them', s.term.screen())
await s.draft('hello from sam')
check(await until(() => s.tip() === '\\  ' && a.tip() === '  /'), "while Sam types the flame leans toward him: left on his screen, right on Ana's", s.term.screen() + a.term.screen())
await s.draft('\r')
check(await until(() => s.tip() === ' ) ' && a.tip() === ' ) '), 'said, it stands upright again', s.term.screen() + a.term.screen())
check(await until(() => rowOf(a, '( hello from sam )') !== -1 && rowOf(s, '( hello from sam )') !== -1), 'a line Sam says is a bubble on both screens', s.term.screen() + a.term.screen())
check(colOf(s, '( hello from sam )') < 50 && colOf(a, '( hello from sam )') > 50, "on the left of his own screen and the right of Ana's", `${colOf(s, '( hello from sam )')} ${colOf(a, '( hello from sam )')}`)

await a.type('hi sam, it is ana')
check(await until(() => rowOf(s, '( hi sam, it is ana )') !== -1 && rowOf(a, '( hi sam, it is ana )') !== -1), "Ana's reply reaches both screens", s.term.screen())
check(rowOf(s, '( hi sam, it is ana )') > rowOf(s, '( hello from sam )') && rowOf(a, '( hi sam, it is ana )') > rowOf(a, '( hello from sam )'),
  'the new bubble is under the old, and the old one stays', s.term.screen())
check(colOf(s, '( hi sam, it is ana )') > 50 && colOf(a, '( hi sam, it is ana )') < 50, "hers on the right of Sam's screen and the left of her own", '')

// ─── a third member ───────────────────────────────────────────────────

const rows = await env.system.room.findMany({ where: { slug: { startsWith: 'booth-' } } })
check(rows.length === 1 && rows[0].pairLoId === Math.min(sam.id, ana.id) && rows[0].pairHiId === Math.max(sam.id, ana.id),
  'both asked, and the room was made once, for the pair', JSON.stringify(rows))

// ─── standing up ──────────────────────────────────────────────────────

s.term.shell.stdin.write('\x1b')
check(await until(() => s.at(outsideLeft.x, outsideLeft.y, tavern) === '@' && s.term.screen().includes('The tavern')), 'Esc stands Sam up in the tavern, beside the stool', s.term.screen())
check(await until(() => /they have stood up/.test(a.term.screen())), "Ana's screen says Sam has stood up", a.term.screen())
check(rowOf(a, '( hello from sam )') !== -1, 'and keeps the lines', a.term.screen())
check(await until(() => !theirFace(a)), "Sam's head is gone from Ana's screen", a.term.screen())
check(/sam left/.test(a.term.screen()), "and his nameplate reads 'sam left'", a.term.screen())
check(await until(() => a.tip() === null && a.wick() === ' . '), "and the candle on Ana's table is blown out to an ember", a.term.screen())

a.term.shell.stdin.write('\x1b')
check(await until(() => a.at(outsideRight.x, outsideRight.y, tavern) === '@' && a.term.screen().includes('The tavern')), 'Ana stands up beside her stool', a.term.screen())
await new Promise((r) => setTimeout(r, 1000))
check(!/across the table/.test(s.term.screen()) && !/across the table/.test(a.term.screen()), 'neither is sent back to the booth', s.term.screen() + a.term.screen())

// ─── done ─────────────────────────────────────────────────────────────

for (const m of [s, a]) m.term.shell.stdin.write('\x03')
const codes = await Promise.all([s, a].map((m) => Promise.race([m.term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])))
check(codes.every((c) => c === 0), 'Ctrl+C exits 0', `exit: ${codes}`)
for (const m of [s, a]) m.term.shell.kill('SIGKILL')
await env.close()
for (const h of homes) rmSync(h, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
