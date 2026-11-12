// web/test/home-board.test.js — a home's board: what `homeBoard()` reads off a
// command, and the text `home-board.js` lays over each piece of furniture, at
// a fixed clock. The homes' furniture itself is pinned by `scenes.test.js`.
import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { homeBoard, homeCommand, readBoard } from '../src/lib/hash/errand.js'
import { INK, ago, shortName, pinCards, screenLines, calendarLines, pingLines, ringing, post } from '../src/lib/home/home-board.js'
import { corkboard, screen, calendar } from '../src/pieces/home.js'
import { spotsOf } from '../src/pieces/index.js'
import { stageOf } from './stage.mjs'

const NOW = Date.parse('2026-10-15T01:00:00Z')
const hour = (h) => new Date(NOW - h * 3_600_000).toISOString()

const BOARD = {
  home: 'jordan',
  pins: [
    { name: 'greensweepnm.com', when: hour(4), fresh: 2 },
    { name: 'KBMS (app.maid.tech)', when: hour(24 * 240), fresh: 0 },
  ],
  inbox: [
    { project: 'cleaningforcecompany.com', who: 'Basecamp', text: 'Status update', when: hour(1), unread: true },
    { project: 'greensweepnm.com', who: 'Molly Moran', text: '@mentioned you: thanks Vlad Jordan', when: hour(4) },
  ],
  pings: [{ project: 'scrub-it-clean.com', who: 'Warren Weiss', text: 'The website form is working great.', when: hour(5) }],
  due: [
    { project: 'texmexcleaning.com', text: 'Test a massive review in the header', when: '2025-01-01' },
    { project: 'ELA', text: 'lead form', when: '2026-10-20' },
  ],
}

// ─── the opt-in ──────────────────────────────────────────────────────────────

test('no command is no board; the env var wins over the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-home-'))
  const file = join(dir, 'home')
  expect(homeCommand({ env: '', file })).toBe('')
  expect(await homeBoard({ cmd: '' })).toBeNull()
  writeFileSync(file, 'echo from-file\n')
  expect(homeCommand({ env: '', file })).toBe('echo from-file')
  expect(homeCommand({ env: 'echo from-env', file })).toBe('echo from-env')
  rmSync(dir, { recursive: true })
})

test('a board is read to the fields drawn, a row with no text dropped, a missing list empty', async () => {
  const b = await homeBoard({ cmd: `printf '%s' '${JSON.stringify({ ...BOARD, pings: [{ who: 'x' }], extra: 1 }).replace(/'/g, "'\\''")}'`, now: 1 })
  expect(b.home).toBe('jordan')
  expect(b.pins[0]).toEqual({ name: 'greensweepnm.com', when: hour(4), fresh: 2 })
  expect(readBoard(JSON.stringify({ home: 'jordan', pins: [{ name: 'x', open: '10', late: 4 }] })).pins[0]).toMatchObject({ open: 10, late: 4 })
  expect(b.inbox[1].unread).toBe(false)
  expect(b.pings).toEqual([])
  expect(readBoard('{"home":"vlad"}')).toEqual({ home: 'vlad', pins: [], inbox: [], pings: [], due: [] })
})

test('a board that names no home, or a home that is a path, is refused by name', () => {
  expect(() => readBoard('{"pins":[]}')).toThrow('HAVEN_HOME printed no { home')
  expect(() => readBoard('{"home":"../tavern"}')).toThrow('HAVEN_HOME printed no { home')
  expect(() => readBoard('[]')).toThrow('HAVEN_HOME printed no { home')
})

test('the command is asked once a minute, and a failure is asked again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-home-'))
  const count = join(dir, 'n')
  const cmd = `echo x >> ${count}; printf '%s' '{"home":"colin"}'`
  await homeBoard({ cmd, now: 1_000_000 })
  await homeBoard({ cmd, now: 1_030_000 })
  await homeBoard({ cmd, now: 1_070_000 })
  expect((await Bun.file(count).text()).trim().split('\n')).toHaveLength(2)
  await expect(homeBoard({ cmd: 'exit 3', now: 2_000_000 })).rejects.toThrow()
  await expect(homeBoard({ cmd: 'exit 3', now: 2_000_001 })).rejects.toThrow()
  rmSync(dir, { recursive: true })
})

// ─── what the furniture says ─────────────────────────────────────────────────

test('ago and a short name', () => {
  expect(ago(hour(0.5), NOW)).toBe('30m')
  expect(ago(hour(4), NOW)).toBe('4h')
  expect(ago(hour(24 * 240), NOW)).toBe('240d')
  expect(ago(hour(24 * 800), NOW)).toBe('2y')
  expect(ago('', NOW)).toBe('')
  expect(shortName('greensweepnm.com', 12)).toBe('greensweepnm')
  expect(shortName('KBMS (app.maid.tech)', 12)).toBe('KBMS')
  expect(shortName('cleaningforcecompany.com', 12)).toBe('cleaningfor…')
})

test('the cork board: a header, then one line a project, the last to move on top, its to-dos late/open', () => {
  const { w, h } = corkboard.inner
  const pins = [{ ...BOARD.pins[1], open: 3, late: 0 }, { ...BOARD.pins[0], open: 10, late: 4 }]
  const cards = pinCards(pins, corkboard.inner, NOW)
  for (const c of cards) {
    expect(c.dx + c.text.length).toBeLessThanOrEqual(w)
    expect(c.dy).toBeLessThan(h)
  }
  const line = (dy) => {
    const row = Array(w).fill(' ')
    for (const c of cards.filter((c) => c.dy === dy)) [...c.text].forEach((ch, i) => { row[c.dx + i] = ch })
    return row.join('').trimEnd()
  }
  expect(line(0)).toBe('  project           todos active for you')
  expect(line(1)).toBe('◆ greensweepnm       4/10     4h       2')
  expect(line(2)).toBe('◆ KBMS                0/3   240d')
  expect(cards.find((c) => c.dy === 1 && c.text === '4').color).toBe(INK.late)
  expect(cards.find((c) => c.dy === 2 && c.text === '0').color).not.toBe(INK.late)
  expect(cards.find((c) => c.dy === 1 && c.text.startsWith('◆')).color).not.toBe(cards.find((c) => c.dy === 2 && c.text.startsWith('◆')).color)
})

test('a pin with no to-do counts leaves the column blank; more pins than lines says how many are left over', () => {
  const pins = Array.from({ length: 11 }, (_, i) => ({ name: `p${i}`, when: hour(i + 1), fresh: 0 }))
  const cards = pinCards(pins, corkboard.inner, NOW)
  const names = cards.filter((c) => c.text.startsWith('◆'))
  expect(names).toHaveLength(corkboard.inner.h - 2)
  expect(names[0]).toMatchObject({ dy: 1, text: '◆ p0' })
  expect(cards.some((c) => c.text.includes('/'))).toBe(false)
  expect(cards.at(-1)).toMatchObject({ dy: corkboard.inner.h - 1, text: '+ 5 more' })
  expect(pinCards([], corkboard.inner, NOW)[0].text).toBe('nothing pinned')
})

test('the screen: only the unread; standing, as many as fit; sitting, all of them scrolling from the offset', () => {
  const { w, h } = screen.inner
  const stand = screenLines(BOARD.inbox, screen.inner, NOW)
  expect(stand).toHaveLength(1)
  expect(stand[0].text).toStartWith('● 1h cleaningf… Basecamp:')
  const many = Array.from({ length: 10 }, (_, i) => ({ ...BOARD.inbox[0], text: `line ${i}` }))
  const mixed = [...many, BOARD.inbox[1]]
  const full = screenLines(mixed, screen.inner, NOW)
  expect(full).toHaveLength(h)
  expect(full.at(-1)).toMatchObject({ dy: h - 1, text: `+ ${10 - h + 1} more · sit at the desk to scroll` })
  const sat = screenLines(mixed, screen.inner, NOW, { sitting: true, offset: 8 })
  expect(sat).toHaveLength(h)
  expect(sat[0].text).toEndWith('line 8')
  expect(sat[2].text).toEndWith('line 0')
  for (const l of [...full, ...sat]) expect(l.text.length).toBeLessThanOrEqual(w)
  expect(screenLines([BOARD.inbox[1]], screen.inner, NOW)[0].text).toBe('nothing unread')
})

test('the calendar: today, the count, the late, and the next not yet late', () => {
  const lines = calendarLines(BOARD.due, calendar.inner, Date.parse('2026-10-14T18:00:00Z')).map((l) => l.text)
  expect(lines).toEqual(['OCT 14', '2 due', '1 late', 'next OCT 20'])
  expect(calendarLines([BOARD.due[0]], calendar.inner, NOW).map((l) => l.text).at(-1)).toBe('from JAN 1')
})

test('the bell rings for an unread ping or one inside the hour, and the post counts what is unread', () => {
  expect(ringing(BOARD.pings, NOW)).toBe(false)
  expect(ringing([{ ...BOARD.pings[0], when: hour(0.5) }], NOW)).toBe(true)
  expect(ringing([{ ...BOARD.pings[0], unread: true }], NOW)).toBe(true)
  expect(post(BOARD)).toBe(1)
  const lines = pingLines(BOARD.pings, 56, 6, NOW)
  expect(lines[0].text).toBe('— pings —')
  expect(lines[1].text).toBe('· 5h Warren (scrub-it-cl…): The website form is working…')
})

// ─── the furniture ───────────────────────────────────────────────────────────

test('what the board writes in lies on blank cells inside each frame', () => {
  for (const p of [corkboard, screen, calendar]) {
    const rows = p.art.split('\n')
    const { dx, dy, w, h } = p.inner
    for (let y = dy; y < dy + h; y++) expect(rows[y].slice(dx, dx + w)).toBe(' '.repeat(w))
    expect(rows[dy][dx - 2]).toBe('|')
    expect(rows[dy][dx + w]).toBe(' ')
    expect(rows[dy][dx + w + 1]).toBe('|')
  }
})

test('every home has each piece the board writes on, the chair a seat paired with nobody', async () => {
  for (const name of ['Jordan', 'Vlad', 'Colin']) {
    const stage = await stageOf(name)
    const of = (n) => stage.marks.filter((m) => m.kind === 'piece' && m.piece.name === n)
    for (const n of ['corkboard', 'screen', 'desk', 'calendar', 'bell', 'doormat']) expect(of(n)).toHaveLength(1)
    const desk = of('desk')[0]
    const [seat] = spotsOf(desk.piece, 'seat')
    expect(stage.walkable(desk.x + seat.dx, desk.y + seat.dy)).toBe(true)
    expect(stage.walkable(desk.x + seat.stand.dx, desk.y + seat.stand.dy)).toBe(true)
    expect(stage.seatAt(desk.x + seat.dx, desk.y + seat.dy)).toBeNull()
  }
})

test('the lane: a cottage per home, its door leading there, a mailbox nearer it than any other door', async () => {
  const lane = await stageOf('Lane')
  for (const home of ['jordan', 'vlad', 'colin']) {
    expect(lane.marks.some((m) => m.kind === 'piece' && m.piece.home === home)).toBe(true)
    const door = lane.doors.find((d) => d.to === `/${home}/`)
    const box = lane.marks.filter((m) => m.kind === 'piece' && m.piece.name === 'mailbox')
      .sort((a, b) => Math.abs(a.x - door.x) - Math.abs(b.x - door.x))[0]
    expect(Math.abs(box.x - door.x)).toBeLessThan(12)
  }
})
