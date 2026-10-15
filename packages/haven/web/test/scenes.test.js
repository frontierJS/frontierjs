// web/test/scenes.test.js — every scene draws the picture committed beside it
// (`FJS-D997`), and the stage under it holds.
//
// A scene is a tree of pieces placed by hand, so the ways it goes wrong are a
// piece on the wrong cell, two pieces on one cell, a door the spawn cannot
// reach, and a pacer walking a wall — none of which fails at render: the
// frame just looks wrong. `<name>.frame.txt` is the picture, pinned row for
// row; `bun run frames` rewrites it, and the diff is the review.
import { test, expect } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SCENES, WEB, mountScene } from './stage.mjs'
import { pacerAt, createStage, follow, arrival, litAt, dim, INK, VIEW, EDGE, SIGHT, OUTDOORS, INDOORS } from '../src/stage.js'
import { piece } from '../src/pieces/index.js'
import { worldOf, worldJson } from '../src/world.js'
import { DAY_MS } from '../src/sky.js'

const STEPS = [[0, 1], [0, -1], [1, 0], [-1, 0]]
// Three quarters into the day is full night, when a `night` door is one.
const NIGHT = 3 * DAY_MS + DAY_MS * 0.75

const scenes = new Map()   // path → its stage, for the border across
for (const { name, slug, path } of SCENES) {
  const { stage, frame, capture } = await mountScene(name)
  scenes.set(path, stage)
  const expected = readFileSync(join(WEB, 'src/scenes', `${slug}.frame.txt`), 'utf8').replace(/\n$/, '').split('\n')

  test(`${slug}: the stage's picture is ${slug}.frame.txt`, () => {
    expect(stage.picture()).toEqual(expected)
  })

  test(`${slug}: the server's world is ${slug}.world.json`, () => {
    expect(worldJson(worldOf(stage))).toBe(readFileSync(join(WEB, 'src/scenes', `${slug}.world.json`), 'utf8'))
  })

  test(`${slug}: the terminal draws that picture, the view's slice of it from the spawn and from the far corner`, async () => {
    // A cycling cell may show another glyph of its `chars` at this tick, a
    // pacer stands somewhere on its row, and a night door is a door for a
    // third of every hour, so a cell is compared only where no clock moves
    // it. A stage no bigger than the view draws the same slice from both corners.
    const paced = (x, y) => stage.pacers.some((p) => p.y === y && x >= p.from && x <= p.to)
    const nightly = (x, y) => stage.doors.some((d) => d.night && d.x === x && d.y === y)
    const same = (drawn, v) => {
      for (let row = 0; row < v.h; row++) {
        for (let col = 0; col < v.w; col++) {
          const x = v.x + col, y = v.y + row
          if (stage.cycles(x, y) || paced(x, y) || nightly(x, y)) continue
          expect({ x, y, ch: drawn[row]?.[col] ?? ' ' }).toEqual({ x, y, ch: expected[y][x] })
        }
      }
    }
    // The first view is the spawn followed from the corner: the corner itself
    // for every scene whose spawn is on its first screen.
    const corner = { x: 0, y: 0, w: Math.min(VIEW.w, stage.width), h: Math.min(VIEW.h, stage.height) }
    expect(stage.view).toEqual(follow(corner, stage.spawn, stage))
    same(frame, stage.view)
    stage.follow(stage.width - 1, stage.height - 1)
    const far = stage.view
    expect(far.x).toBe(stage.width - far.w)
    same(await capture(), far)
    stage.follow(stage.spawn.x, stage.spawn.y)
  })

  test(`${slug}: a cycling cell changes over time and never moves a wall`, () => {
    const tick = stage.tickOf()
    expect(tick).toBeGreaterThan(0)
    let changed = false
    for (let y = 0; y < stage.height; y++) {
      for (let x = 0; x < stage.width; x++) {
        const a = stage.look(x, y, 0)
        const b = stage.look(x, y, tick * 7)
        if (a.ch !== b.ch || a.fg !== b.fg) changed = true
        expect(b.ch === ' ').toBe(expected[y][x] === ' ')
      }
    }
    expect(changed).toBe(true)
  })

  test(`${slug}: every painted cell has a glyph and a color at every tick`, () => {
    for (let ms = 0; ms < 200_000; ms += 37) {
      for (let y = 0; y < stage.height; y++) {
        for (let x = 0; x < stage.width; x++) {
          if (expected[y][x] === ' ') continue
          const { ch, fg } = stage.look(x, y, ms)
          if (typeof ch !== 'string' || typeof fg !== 'string') throw new Error(`${slug} ${x},${y} at ${ms}ms: ${ch} ${fg}`)
        }
      }
    }
  }, 30_000)

  test(`${slug}: the spawn is floor and every door is reached from it`, () => {
    const { spawn } = stage
    expect(stage.walkable(spawn.x, spawn.y)).toBe(true)
    const seen = new Set([`${spawn.x},${spawn.y}`])
    const queue = [spawn]
    while (queue.length) {
      const { x, y } = queue.shift()
      for (const [dx, dy] of STEPS) {
        const k = `${x + dx},${y + dy}`
        if (!seen.has(k) && stage.walkable(x + dx, y + dy)) { seen.add(k); queue.push({ x: x + dx, y: y + dy }) }
      }
    }
    expect(stage.doors.length).toBeGreaterThan(0)
    for (const d of stage.doors) {
      expect(stage.doorAt(d.x, d.y, d.night ? NIGHT : 0)).toEqual(d)
      expect(stage.walkable(d.x, d.y)).toBe(false)
      const reached = STEPS.some(([dx, dy]) => seen.has(`${d.x + dx},${d.y + dy}`))
      expect({ door: d.to, reached }).toEqual({ door: d.to, reached: true })
    }
  })

  test(`${slug}: every paint letter a piece uses is defined by the scene's palette or the piece's own`, () => {
    const undefinedLetters = new Set()
    for (const m of stage.marks) {
      if (m.kind !== 'piece') continue
      for (const c of m.piece.cells) if (c.key !== ' ' && !stage.entryOf(c.key)) undefinedLetters.add(`${m.piece.name}:${c.key}`)
    }
    expect([...undefinedLetters]).toEqual([])
  })

  test(`${slug}: every door leads to a scene with a door back, and a border has its run across at the matching row`, () => {
    const path = SCENES.find((s) => s.slug === slug).path
    for (const d of stage.doors) {
      const there = scenes.get(d.to)
      expect({ door: d.to, known: !!there, back: !!there?.doors.some((b) => b.to === path) }).toEqual({ door: d.to, known: true, back: true })
    }
    // A figure crossing a run lands beside the cell across at its row or
    // column, so a run that stops short drops it beside a cell it never crossed.
    for (const run of stage.marks.filter((m) => m.kind === 'door' && (m.w > 1 || m.h > 1))) {
      const there = scenes.get(run.to)
      for (let dy = 0; dy < run.h; dy++) for (let dx = 0; dx < run.w; dx++) {
        const cell = { x: run.x + dx, y: run.y + dy }
        const across = there.doors.find((b) => b.to === path && (run.h > 1 ? b.y === cell.y : b.x === cell.x))
        expect({ border: run.to, at: `${cell.x},${cell.y}`, across: !!across }).toEqual({ border: run.to, at: `${cell.x},${cell.y}`, across: true })
        const landed = arrival(there, { from: path, ...cell })
        expect(Math.abs(landed.x - across.x) + Math.abs(landed.y - across.y)).toBe(1)
      }
    }
  })

  test(`${slug}: from the spawn a figure sees round itself, not the whole scene, and every light's halo`, () => {
    const { spawn } = stage
    expect(litAt(stage, spawn.x, spawn.y, spawn)).toBe(true)
    const cells = []
    for (let y = 0; y < stage.height; y++) for (let x = 0; x < stage.width; x++) if (expected[y][x] !== ' ') cells.push({ x, y })
    const lit = cells.filter((c) => litAt(stage, c.x, c.y, spawn))
    expect(lit.length).toBeGreaterThan(0)
    expect(lit.length).toBeLessThan(cells.length)
    for (const l of stage.lights) {
      expect(Object.values({ ...stage.defaults, ...stage.palette }).some((e) => e.light === l.r)).toBe(true)
      expect(litAt(stage, l.x, l.y, { x: stage.width - 1, y: stage.height - 1 })).toBe(true)
    }
    // The picture is the art whoever stands where: fog is drawn, never claimed.
    expect(stage.picture()).toEqual(expected)
  })

  for (const p of stage.pacers) {
    test(`${slug}: the ${p.name} paces floor only, end to end and back`, () => {
      for (let x = p.from; x <= p.to; x++) expect({ x, floor: stage.walkable(x, p.y) }).toEqual({ x, floor: true })
      const lefts = new Set(), rights = new Set()
      for (let ms = 0; ms < 200_000; ms += p.ms) {
        const { x, y, text } = pacerAt(p, ms)
        expect(y).toBe(p.y)
        expect(x).toBeGreaterThanOrEqual(p.from)
        expect(x + text.length - 1).toBeLessThanOrEqual(p.to)
        lefts.add(x)
        rights.add(x + text.length - 1)
      }
      expect(Math.min(...lefts)).toBe(p.from)
      expect(Math.max(...rights)).toBe(p.to)
    })
  }
}

// ─── the workshop ─────────────────────────────────────────────────────

// A package with no bench is a session `Workers.mesa` cannot seat, and
// nothing on the screen says so: the bench set is read off the tree here.
test('workshop: a bench for every package, for example/ and for the rest of the tree, and none for anything else', () => {
  const packages = join(WEB, '../..')
  const names = readdirSync(packages, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(packages, d.name, 'package.json')))
    .map((d) => d.name)
  const benches = scenes.get('/workshop/').marks.filter((m) => m.piece?.bench).map((m) => m.piece.bench)
  expect([...benches].sort()).toEqual([...names, 'example', 'frontierjs'].sort())
})

test('workshop: the row under every bench is floor its whole width, where its workers stand and its count is drawn', () => {
  const stage = scenes.get('/workshop/')
  for (const b of stage.marks.filter((m) => m.piece?.bench)) {
    for (let dx = 0; dx < b.piece.art.length; dx++) {
      expect({ bench: b.piece.bench, x: b.x + dx, floor: stage.walkable(b.x + dx, b.y + 1) }).toEqual({ bench: b.piece.bench, x: b.x + dx, floor: true })
    }
  }
})

// The slips are what ISSUES.md counts for a package, so a pile that lost a
// slip, took another severity's color, or lay on the wrong bench would still
// draw a picture. A package with no issues has no pile and no table of its
// own: it is listed under `(no work)`.
test('workshop: on every bench with work a pile per severity, a slip in its color for each issue ledger.data.js counts for that package, lying on the bench', async () => {
  const { LEDGER } = await import('../src/ledger.data.js')
  const { PILE } = await import('../src/pieces/ledger.js')
  const stage = scenes.get('/workshop/')
  const benches = stage.marks.filter((m) => m.piece?.bench)
  const blocks = stage.marks.filter((m) => m.piece?.ledger)
  const busy = (name) => Object.values(LEDGER[name]).some((n) => n > 0)
  expect(blocks.map((b) => b.piece.ledger)).toEqual(benches.map((b) => b.piece.bench).filter(busy))
  for (const bench of benches.filter((b) => busy(b.piece.bench))) {
    const name = bench.piece.bench
    const block = blocks.find((b) => b.piece.ledger === name)
    const rows = block.piece.art.split('\n').length
    expect({ name, x: block.x, rests: block.y + rows }).toEqual({ name, x: bench.x, rests: bench.y })
    Object.entries({ S1: '1', S2: '2', S3: '3', S4: '4' }).forEach(([sev, key], pile) => {
      const lo = pile * (PILE + 1), hi = lo + PILE
      const slips = block.piece.cells.filter((c) => c.key === key)
      expect({ name, sev, slips: slips.length, inPile: slips.every((c) => c.dx >= lo && c.dx < hi) }).toEqual({ name, sev, slips: LEDGER[name][sev], inPile: true })
    })
  }
})

test('workshop: a package with no issues takes no table, and is listed under (no work) in a row below every table', async () => {
  const { LEDGER } = await import('../src/ledger.data.js')
  const stage = scenes.get('/workshop/')
  const idle = Object.keys(LEDGER).filter((n) => Object.values(LEDGER[n]).every((c) => c === 0)).sort()
  const listed = stage.marks.filter((m) => m.piece?.bench && idle.includes(m.piece.bench))
  expect(listed.map((m) => m.piece.bench).sort()).toEqual(idle)
  expect(listed.every((m) => m.piece.art.length === m.piece.bench.length + 4)).toBe(true)
  const heading = stage.marks.find((m) => m.piece?.name === 'heading')
  expect(heading.piece.art).toBe('(no work)')
  const lowest = Math.max(...stage.marks.filter((m) => m.piece?.ledger).map((m) => m.y))
  expect(listed.every((m) => m.y > lowest && m.y === heading.y)).toBe(true)
})

// His figure and the row he speaks on are the desk's, and a desk that sat on a
// wall or under a bench's workers would be found only by a drive.
test('workshop: the taskmaster\'s desk is no bench, stands on the left by the door, and has floor for him and his line', () => {
  const stage = scenes.get('/workshop/')
  const desk = stage.marks.find((m) => m.piece?.name === 'taskmaster')
  expect(desk.piece.bench).toBeUndefined()
  expect(desk.x).toBeLessThan(8)
  const door = stage.doors.find((d) => d.to === '/')
  expect(desk.y).toBeGreaterThan(Math.max(...stage.marks.filter((m) => m.piece?.bench).map((m) => m.y)))
  expect(desk.y).toBeLessThan(door.y)
  for (let dy = 1; dy <= 2; dy++) for (let dx = 0; dx < desk.piece.art.length; dx++) expect(stage.walkable(desk.x + dx, desk.y + dy)).toBe(true)
})

// ─── the cellar ──────────────────────────────────────────────────────

// A secret is a door nothing draws, so the only things that say it is there
// are these: one way down, hidden, painted as the rug around it, and a figure
// coming back up standing beside it.
test('cellar: the one way down is the tavern rug, a door drawn as the rug it is in', () => {
  const tavern = scenes.get('/tavern/')
  const ways = [...scenes].flatMap(([path, stage]) => stage.doors.filter((d) => d.to === '/cellar/' && !d.night).map((d) => ({ path, ...d })))
  expect(ways).toEqual([expect.objectContaining({ path: '/tavern/', hidden: true })])
  const { x, y } = ways[0]
  expect(tavern.walkable(x, y)).toBe(false)
  const beside = tavern.look(x - 1, y)
  expect(tavern.look(x, y)).toEqual(beside)
  expect(beside.ch).toBe(':')
  expect(tavern.picture()[y][x]).toBe(':')
})

test('cellar: a figure coming up from it stands on the rug beside the hole, not at the tavern door', () => {
  const tavern = scenes.get('/tavern/')
  const hole = tavern.doors.find((d) => d.to === '/cellar/')
  const landed = arrival(tavern, { from: '/cellar/', x: 48, y: 1 })
  expect(Math.abs(landed.x - hole.x) + Math.abs(landed.y - hole.y)).toBe(1)
  expect(tavern.walkable(landed.x, landed.y)).toBe(true)
})

// ─── the glade and the tunnel ─────────────────────────────────────────

// The glade is the woods' second secret and the oak its third. Nothing drawn
// says either is there, so these are what does: the plank drawn as fence, the
// oak's foot and the cellar's wall drawn as themselves by day, and each a door
// at night that leads to the other.
test('glade: the one way in is a plank of the woods\' fence, drawn as the fence', () => {
  const woods = scenes.get('/woods/')
  const ways = [...scenes].flatMap(([path, stage]) => stage.doors.filter((d) => d.to === '/glade/' && !d.night).map((d) => ({ path, ...d })))
  expect(ways).toEqual([expect.objectContaining({ path: '/woods/', hidden: true })])
  const { x, y } = ways[0]
  expect(woods.picture()[y][x]).toBe('|')
  expect(woods.look(x, y)).toEqual(woods.look(x, y - 1))
  const landed = arrival(woods, { from: '/glade/', x: 96, y: 12 })
  expect(landed).toEqual({ x: x + 1, y })
})

test('the tunnel: the oak\'s foot and the cellar\'s west wall are each other\'s night door, and by day neither is a door', () => {
  const glade = scenes.get('/glade/'), cellar = scenes.get('/cellar/')
  const oak = glade.doors.find((d) => d.to === '/cellar/')
  const wall = cellar.doors.find((d) => d.to === '/glade/')
  expect([oak.night, wall.night]).toEqual([true, true])
  for (const [stage, d] of [[glade, oak], [cellar, wall]]) {
    expect(stage.doorAt(d.x, d.y, 0)).toBeNull()
    expect(stage.doorAt(d.x, d.y, NIGHT)).toEqual(d)
    expect(stage.look(d.x, d.y, 0).ch).toBe(stage.picture()[d.y][d.x])
    expect(stage.look(d.x, d.y, NIGHT).ch).toBe('n')
    expect(stage.walkable(d.x, d.y)).toBe(false)
  }
  const up = arrival(glade, { from: '/cellar/', x: wall.x, y: wall.y })
  expect(Math.abs(up.x - oak.x) + Math.abs(up.y - oak.y)).toBe(1)
  expect(glade.walkable(up.x, up.y)).toBe(true)
  const down = arrival(cellar, { from: '/glade/', x: oak.x, y: oak.y })
  expect(Math.abs(down.x - wall.x) + Math.abs(down.y - wall.y)).toBe(1)
})

// ─── the stage's own rules ───────────────────────────────────────────

test('the view follows a figure only when it nears an edge, and stays inside the stage', () => {
  const extent = { width: 160, height: 40 }
  const home = { x: 0, y: 0, w: VIEW.w, h: VIEW.h }
  expect(follow(home, { x: 30, y: 20 }, extent)).toEqual(home)
  expect(follow(home, { x: VIEW.w - EDGE.x - 1, y: 20 }, extent)).toEqual(home)
  const panned = follow(home, { x: VIEW.w - EDGE.x, y: 20 }, extent)
  expect(panned).toEqual({ ...home, x: 1 })
  expect(follow(panned, { x: VIEW.w - EDGE.x - 1, y: 20 }, extent)).toEqual(panned)
  expect(follow(panned, { x: EDGE.x, y: 20 }, extent)).toEqual({ ...home, x: 0 })
  expect(follow(home, { x: 159, y: 39 }, extent)).toEqual({ x: 160 - VIEW.w, y: 40 - VIEW.h, w: VIEW.w, h: VIEW.h })
  expect(follow(home, { x: 0, y: 0 }, extent)).toEqual(home)
  const small = { width: 60, height: 20 }
  expect(follow(home, { x: 59, y: 19 }, small)).toEqual({ x: 0, y: 0, w: 60, h: 20 })
})

test('a stage shows the view it is told to follow and the whole of itself to the editor', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  stage.stamp(piece('dot', '.', 'f'), 199, 29)
  expect(stage.view).toEqual({ x: 0, y: 0, w: VIEW.w, h: VIEW.h })
  const seen = []
  stage.subscribe(() => seen.push(stage.view.x))
  stage.follow(150, 10)
  expect(stage.view).toEqual({ x: 150 + EDGE.x - VIEW.w + 1, y: 0, w: VIEW.w, h: VIEW.h })
  stage.follow(150, 10)
  expect(seen).toEqual([62])
  stage.showAll()
  expect(stage.view).toEqual({ x: 0, y: 0, w: 200, h: 30 })
})

const wall  = piece('wall', '|', 'w')
const table = piece('table', 'o|o', 'tct')

test('a figure sees within SIGHT over floor, a wall blocks the line, and a light is seen from anywhere', () => {
  const stage = createStage({ slug: 'probe', palette: { w: { fg: '#ffffff' }, y: { fg: '#ffff00', light: 2 } }, spawn: { x: 0, y: 0 } })
  stage.stamp(piece('far', '.', 'w'), 60, 20)
  stage.stamp(piece('wall', '|\n|\n|', 'w\nw\nw'), 25, 9)
  stage.stamp(piece('lamp', 'o', 'y'), 50, 2)
  const me = { x: 20, y: 10 }
  expect(litAt(stage, 20, 10, me)).toBe(true)
  expect(litAt(stage, 20 - 2 * SIGHT, 10, me)).toBe(true)
  expect(litAt(stage, 20 - 2 * SIGHT - 1, 10, me)).toBe(false)
  expect(litAt(stage, 20, 10 - SIGHT, me)).toBe(true)
  expect(litAt(stage, 20, 10 - SIGHT - 1, me)).toBe(false)
  expect(litAt(stage, 25, 10, me)).toBe(true)     // the wall itself is seen
  expect(litAt(stage, 27, 10, me)).toBe(false)    // the cell behind it is not
  expect(litAt(stage, 27, 13, me)).toBe(true)     // round its end it is
  expect(litAt(stage, 50, 2, me)).toBe(true)      // the lamp, from across the stage
  expect(litAt(stage, 52, 3, me)).toBe(true)      // and its halo
  expect(litAt(stage, 55, 3, me)).toBe(false)     // which ends
  expect(stage.lights).toEqual([{ x: 50, y: 2, r: 2 }])
  expect(litAt(stage, 60, 20, null)).toBe(true)
})

test('a stage with a seer draws lit cells, remembers them dim, and blanks the rest; with none it draws everything', () => {
  const stage = createStage({ layers: [...OUTDOORS, 'fog'], slug: 'probe', palette: { w: { fg: '#ff0000' }, k: { fg: ['#ffffff', '#000000'], chars: 'ab', ms: 100 } }, spawn: { x: 0, y: 0 } })
  stage.stamp(piece('wall', '|', 'w'), 2, 0)
  stage.stamp(piece('water', '~', 'k'), 3, 0)
  stage.stamp(piece('post', '!', ' '), 4, 0)
  stage.stamp(piece('far', '#', 'w'), 40, 5)
  expect(stage.light(40, 5)).toBe('lit')
  expect(stage.look(40, 5, 0)).toEqual({ ch: '#', fg: '#ff0000', bg: undefined })
  const drawn = []
  stage.subscribe(() => drawn.push(1))
  stage.see(3, 2)
  expect(drawn).toEqual([1])
  expect(stage.light(2, 0)).toBe('lit')
  expect(stage.light(40, 5)).toBe('dark')
  expect(stage.look(40, 5, 0)).toEqual({ ch: ' ', fg: undefined, bg: undefined })
  expect(stage.look(3, 0, 100)).toEqual({ ch: 'b', fg: '#000000', bg: undefined })
  stage.see(30, 2)
  expect(stage.light(2, 0)).toBe('dim')
  expect(stage.light(40, 5)).toBe('lit')
  expect(stage.look(2, 0, 0)).toEqual({ ch: '|', fg: dim('#ff0000'), bg: undefined })
  expect(stage.look(4, 0, 0)).toEqual({ ch: '!', fg: dim(INK), bg: undefined })
  expect(stage.look(3, 0, 100)).toEqual({ ch: 'a', fg: dim('#ffffff'), bg: undefined })   // a memory does not move
  expect(stage.look(1, 0, 0)).toEqual({ ch: ' ', fg: undefined, bg: undefined })
  expect(dim('#ff0000')).toBe('#660000')
  // A piece placed in the dark is not seen until the figure comes near.
  stage.stamp(piece('crate', '#', 'w'), 16, 5)
  expect(stage.light(16, 5)).toBe('dark')
  stage.stamp(piece('crate', '#', 'w'), 31, 0)
  expect(stage.light(31, 0)).toBe('lit')
  expect(stage.picture()[0].length).toBe(41)
})

test('two pieces on one cell are refused naming the cell and both', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  stage.stamp(table, 0, 0)
  expect(() => stage.stamp(wall, 1, 0)).toThrow('cell 1,0 is claimed by both table and wall')
})

test('a door replaces the wall under it and comes back when removed', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  stage.stamp(wall, 2, 0)
  const door = stage.door(2, 0, '/out/')
  expect(stage.picture()).toEqual(['  n'])
  expect(stage.doorAt(2, 0)).toEqual({ x: 2, y: 0, to: '/out/' })
  expect(stage.walkable(2, 0)).toBe(false)
  door.remove()
  expect(stage.picture()).toEqual(['  |'])
  expect(stage.doorAt(2, 0)).toBeNull()
})

test('a door with a size is a run of door cells, one mark, moved and removed together', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  stage.stamp(piece('wall', '|\n|\n|\n|', 'w\nw\nw\nw'), 0, 0)
  const run = stage.door(0, 1, '/east/', { h: 3 })
  expect(stage.marks).toEqual([expect.objectContaining({ kind: 'piece' }), expect.objectContaining({ kind: 'door', x: 0, y: 1, w: 1, h: 3 })])
  expect(stage.picture()).toEqual(['|', 'n', 'n', 'n'])
  expect(stage.doors).toEqual([{ x: 0, y: 1, to: '/east/' }, { x: 0, y: 2, to: '/east/' }, { x: 0, y: 3, to: '/east/' }])
  run.retarget('/west/')
  expect(stage.doorAt(0, 3)).toEqual({ x: 0, y: 3, to: '/west/' })
  run.move(2, 0)
  expect(stage.picture()).toEqual(['| n', '| n', '| n', '|  '])
  run.remove()
  expect(stage.picture()).toEqual(['|', '|', '|', '|'])
  expect(stage.doors).toEqual([])
})

test('a figure arrives beside the door that leads back, nearest the cell it crossed, else at the spawn', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 5, y: 5 } })
  stage.stamp(piece('wall', '|\n|\n|\n|\n|\n|\n|\n|\n|\n|', 'w'.repeat(19).replace(/ww/g, 'w\n')), 9, 0)
  stage.door(9, 2, '/', { h: 5 })
  stage.stamp(piece('wall', '---', 'www'), 2, 0)
  stage.door(3, 0, '/tavern/')
  expect(arrival(stage, { from: '/', x: 0, y: 4 })).toEqual({ x: 8, y: 4 })
  expect(arrival(stage, { from: '/', x: 0, y: 0 })).toEqual({ x: 8, y: 2 })
  expect(arrival(stage, { from: '/tavern/', x: 40, y: 20 })).toEqual({ x: 3, y: 1 })
  expect(arrival(stage, { from: '/nowhere/', x: 0, y: 0 })).toEqual({ x: 5, y: 5 })
  expect(arrival(stage, {})).toEqual({ x: 5, y: 5 })
  stage.stamp(piece('crate', '#', 'w'), 3, 1)
  expect(arrival(stage, { from: '/tavern/', x: 0, y: 0 })).toEqual({ x: 5, y: 5 })
})

test('a moved piece frees the cells it left, and a removed one frees them all', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  const mark = stage.stamp(table, 0, 0)
  mark.move(4, 0)
  expect(stage.picture()).toEqual(['    o|o'])
  expect(stage.walkable(0, 0)).toBe(true)
  stage.stamp(wall, 1, 0)
  mark.remove()
  expect(stage.picture()).toEqual([' |'])
})

test('a floor piece is walked on, a wall is not, and the edge is a wall', () => {
  const rug = piece('rug', ':::', 'mmm', { floor: true })
  const stage = createStage({ slug: 'probe', palette: { m: { fg: '#000000' } }, spawn: { x: 0, y: 0 } })
  stage.stamp(rug, 0, 1)
  stage.stamp(wall, 3, 1)
  expect([0, 1, 2, 3].map((x) => stage.walkable(x, 1))).toEqual([true, true, true, false])
  expect(stage.walkable(0, 0)).toBe(true)
  expect(stage.walkable(4, 1)).toBe(false)
  expect(stage.look(1, 1, 0)).toEqual({ ch: ':', fg: '#000000', bg: undefined })
})

test('a hidden door draws what is under it and is still a door; lifted, the cell is as it was', () => {
  const palette = { w: { fg: '#ffffff' } }
  const stage = createStage({ slug: 'probe', palette, spawn: { x: 0, y: 0 } })
  stage.stamp(piece('rug', '::', 'ww', { floor: true }), 0, 0)
  const hole = stage.door(0, 0, '/down/', { hidden: true })
  const blank = stage.door(5, 0, '/blank/', { hidden: true })
  expect(stage.doorAt(0, 0)).toEqual({ x: 0, y: 0, to: '/down/', hidden: true })
  expect(stage.walkable(0, 0)).toBe(false)
  expect(stage.look(0, 0)).toEqual({ ch: ':', fg: '#ffffff', bg: undefined })
  expect(stage.picture()[0].slice(0, 2)).toBe('::')
  expect(stage.look(5, 0)).toEqual({ ch: ' ', fg: undefined, bg: undefined })
  expect(stage.doors).toEqual([{ x: 0, y: 0, to: '/down/', hidden: true }, { x: 5, y: 0, to: '/blank/', hidden: true }])
  hole.remove()
  blank.remove()
  expect(stage.doorAt(0, 0)).toBeNull()
  expect(stage.walkable(0, 0)).toBe(true)
  expect(stage.look(0, 0).ch).toBe(':')
})

test('a night door is the cell under it by day and a door at full night; an indoor stage redraws for it on the sky\'s step', () => {
  const palette = { w: { fg: '#ffffff' } }
  const stage = createStage({ slug: 'probe', palette, spawn: { x: 0, y: 1 }, layers: INDOORS })
  expect(stage.tickOf(0)).toBe(0)
  stage.stamp(wall, 0, 0)
  const gate = stage.door(0, 0, '/out/', { night: true })
  expect(stage.doorAt(0, 0, 0)).toBeNull()
  expect(stage.doorAt(0, 0, NIGHT)).toEqual({ x: 0, y: 0, to: '/out/', night: true })
  expect(stage.doors).toEqual([{ x: 0, y: 0, to: '/out/', night: true }])
  expect(stage.look(0, 0, 0)).toEqual({ ch: '|', fg: '#ffffff', bg: undefined })
  expect(stage.look(0, 0, NIGHT).ch).toBe('n')
  expect(stage.picture()[0]).toBe('|')
  expect(stage.walkable(0, 0)).toBe(false)
  expect(stage.tickOf(0)).toBe(DAY_MS / 30)
  gate.remove()
  expect(stage.doors).toEqual([])
  expect(stage.look(0, 0, NIGHT).ch).toBe('|')
})


test('a piece with `overhead` rows is walked under: its top rows are walkable, drawn over the figures, and see-through; the rest is wall', () => {
  const canopy = piece('canopy', '&&\n||', 'tt\nuu', { overhead: 1 })
  const stage = createStage({ slug: 'probe', palette: { t: { fg: '#00ff00' }, u: { fg: '#886600' } }, spawn: { x: 0, y: 0 } })
  stage.stamp(canopy, 0, 1)
  expect([0, 1].map((x) => stage.walkable(x, 1))).toEqual([true, true])
  expect([0, 1].map((x) => stage.walkable(x, 2))).toEqual([false, false])
  expect(stage.look(0, 1)).toEqual({ ch: '&', fg: '#00ff00', bg: undefined, overhead: true })
  expect(stage.look(0, 2).overhead).toBeUndefined()
  expect(litAt(stage, 0, 0, { x: 1, y: 0 })).toBe(true)
  expect(() => stage.stamp(piece('crate', '#', 'w'), 1, 1)).toThrow(/claimed by both/)
})

test("the square's hedge is a wall and its flowers are floor", () => {
  const stage = scenes.get('/')
  const hedge = [5, 21, 37, 53, 67, 83].map((x) => stage.walkable(x, 23))
  expect(hedge).toEqual([false, false, false, false, false, false])
  expect(stage.walkable(6, 24)).toBe(true)
})
