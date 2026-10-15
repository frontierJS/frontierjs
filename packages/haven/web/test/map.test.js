// web/test/map.test.js — the map (`IDEAS/haven.md` 6.4): a scene kept as a
// coarse snap, the snaps laid out from their doors, and `#seen` keeping them.
//
// The layout is derived, so the ways it goes wrong are quiet: a scene on the
// wrong side of its neighbor, two borders that do not line up, a house drawn
// as though it were a street, an unwalked scene drawn anyway. The scenes are
// the real ones, mounted headless; `#seen` is handed a directory, and the
// module's own default is this machine's `~/.fli/haven/seen/`.
import { test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCENES, mountScene } from './stage.mjs'
import { DOOR, GLYPH, SCALE, coarse, drawn, layoutOf, painted, recall, remember, valid } from '../src/map.js'

const base = mkdtempSync(join(tmpdir(), 'haven-seen-'))
let dir
beforeEach(() => { dir = mkdtempSync(join(base, 's-')) })
afterAll(() => rmSync(base, { recursive: true, force: true }))

const stages = new Map()
for (const { name, slug, path } of SCENES) stages.set(slug, { ...(await mountScene(name)), path })
const snapOf = (slug) => coarse(stages.get(slug).stage, stages.get(slug).path)
const tileOf = (layout, slug) => layout.tiles.find((t) => t.slug === slug)
const ALL = SCENES.map((s) => snapOf(s.slug))

test('a scene is its picture at SCALE: a glyph per block, a door wherever one is, the size and the doors kept', () => {
  const { stage } = stages.get('tavern')
  const snap = snapOf('tavern')
  expect(snap.fg.length).toBe(snap.rows.length)
  expect(snap.rows.length).toBe(Math.ceil(stage.height / SCALE.y))
  expect(snap.rows.every((r) => r.length === Math.ceil(stage.width / SCALE.x))).toBe(true)
  expect(snap.w).toBe(stage.width)
  const door = stage.doors.find((d) => d.to === '/')
  expect(snap.rows[Math.floor(door.y / SCALE.y)][Math.floor(door.x / SCALE.x)]).toBe(DOOR.ch)
  expect(snap.doors).toContainEqual({ x: door.x, y: door.y, w: 1, h: 1, to: '/' })
  expect(snap.rows.join('').trim()).not.toBe('')
  expect(valid(JSON.parse(JSON.stringify(snap)))).toBe(true)
})

test('the square is the middle: the woods west of it, the road east, the docks under it at the door both name', () => {
  const layout = layoutOf(ALL)
  const [square, woods, road, docks] = ['square', 'woods', 'road', 'docks'].map((s) => tileOf(layout, s))
  expect(woods.x + woods.w - 1).toBe(square.x)
  expect(road.x).toBe(square.x + square.w - 1)
  expect(woods.y).toBe(square.y)
  expect(road.y).toBe(square.y)
  expect(docks.y).toBe(square.y + square.h - 1)
  // The docks' door and the square's name the same column of the world.
  const here = stages.get('square').stage.marks.find((m) => m.kind === 'door' && m.to === '/docks/')
  const back = stages.get('docks').stage.marks.find((m) => m.kind === 'door' && m.to === '/')
  expect(docks.x + 1 + Math.floor(back.x / SCALE.x)).toBe(square.x + 1 + Math.floor(here.x / SCALE.x))
})

test('a hidden door is not on the map: the tavern keeps its square and stairs doors, and the rug glyph stays where the hole is', () => {
  const { stage } = stages.get('tavern')
  const hole = stage.doors.find((d) => d.hidden)
  const snap = snapOf('tavern')
  expect(snap.doors.map((d) => d.to).sort()).toEqual(['/', '/upstairs/'])
  expect(snap.rows[Math.floor(hole.y / SCALE.y)][Math.floor(hole.x / SCALE.x)]).not.toBe(DOOR.ch)
})

test('a house has no side: the tavern, the workshop and the cellar stand in a row under every street, apart', () => {
  const layout = layoutOf(ALL)
  const streets = ['square', 'woods', 'road', 'docks'].map((s) => tileOf(layout, s))
  const bottom = Math.max(...streets.map((t) => t.y + t.h)) - 1
  const houses = ['tavern', 'workshop', 'cellar'].map((s) => tileOf(layout, s))
  for (const h of houses) expect(h.y).toBe(bottom)
  const row = [...houses].sort((a, b) => a.x - b.x)
  for (let i = 1; i < row.length; i++) expect(row[i - 1].x + row[i - 1].w).toBeLessThan(row[i].x)
  expect(layout.tiles.length).toBe(SCENES.length)
})

test('a scene nobody has walked into is not drawn, and the map is the same however the snaps arrive', () => {
  const some = layoutOf(ALL.filter((s) => ['square', 'road'].includes(s.slug)))
  expect(some.tiles.map((t) => t.slug).sort()).toEqual(['road', 'square'])
  expect(layoutOf([...ALL].reverse()).tiles.map((t) => [t.slug, t.x, t.y]).sort())
    .toEqual(layoutOf(ALL).tiles.map((t) => [t.slug, t.x, t.y]).sort())
  expect(layoutOf([])).toEqual({ tiles: [], w: 0, h: 0 })
})

test('a machine that has only been in a house has the house alone, and the root returns the square to the middle when it comes', () => {
  const inside = layoutOf([snapOf('tavern')])
  expect(inside.tiles.map((t) => [t.slug, t.x, t.y])).toEqual([['tavern', 0, 0]])
  const both = layoutOf([snapOf('tavern'), snapOf('square')])
  expect(tileOf(both, 'square').x).toBe(0)
  expect(tileOf(both, 'tavern').y).toBe(tileOf(both, 'square').h - 1)
})

test('the figure is an @ on the block it stands in, in its own scene and no other', () => {
  const layout = layoutOf(ALL)
  const { stage } = stages.get('docks')
  const rows = drawn(layout, { route: '/docks/', x: stage.spawn.x, y: stage.spawn.y })
  const docks = tileOf(layout, 'docks')
  expect(rows[docks.y + 1 + Math.floor(stage.spawn.y / SCALE.y)][docks.x + 1 + Math.floor(stage.spawn.x / SCALE.x)]).toBe('@')
  expect(rows.join('').split('@').length - 1).toBe(1)
  expect(rows[docks.y].slice(docks.x + 2, docks.x + 9)).toBe(' docks ')
  expect(drawn(layout, { route: '/nowhere/', x: 0, y: 0 }).join('')).not.toContain('@')
})

test('a map drawn into a smaller pane is cut, not wrapped', () => {
  const rows = drawn(layoutOf(ALL), null, { w: 30, h: 10 })
  expect(rows.length).toBe(10)
  expect(rows.every((r) => r.length <= 30)).toBe(true)
})

test('#seen keeps a scene as its file and returns it; a second visit replaces the first', async () => {
  const { stage } = stages.get('road')
  await remember(stage, '/road/', { dir })
  await remember(stages.get('square').stage, '/', { dir })
  expect(readdirSync(dir).sort()).toEqual(['road.json', 'square.json'])
  const back = await recall({ dir })
  expect(back.map((s) => s.slug)).toEqual(['road', 'square'])
  expect(back[0].rows).toEqual(snapOf('road').rows)
  await remember(stage, '/road/', { dir })
  expect((await recall({ dir })).length).toBe(2)
})

test('a torn file, a file in another shape and a slug that is a path are no scene and fail nothing', async () => {
  await remember(stages.get('road').stage, '/road/', { dir })
  writeFileSync(join(dir, 'torn.json'), '{"slug":"torn","rou')
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ slug: 'other', route: '/o/', w: 'wide', h: 1, rows: [], doors: [] }))
  expect((await recall({ dir })).map((s) => s.slug)).toEqual(['road'])
  expect(await recall({ dir: join(dir, 'missing') })).toEqual([])
  await remember({ ...stages.get('road').stage, slug: '../escape', marks: [], width: 0, height: 0 }, '/x/', { dir })
  expect(readdirSync(dir).sort()).toEqual(['other.json', 'road.json', 'torn.json'])
  expect(valid({ ...snapOf('road'), slug: '../escape' })).toBe(false)
})

test('a block is a kind of ground in the scene\'s own ink: water is ≈ and blue, a tree ♣ and green, a house wall is never a letter', () => {
  const kinds = new Map()
  for (const s of ALL) s.rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== ' ') kinds.set(ch, s.fg[j][i]) }))
  expect(kinds.get(GLYPH.water)).toMatch(/^#/)
  expect(kinds.get(GLYPH.tree)).toMatch(/^#/)
  const allowed = new Set([...Object.values(GLYPH), DOOR.ch])
  for (const s of ALL) for (const row of s.rows) for (const ch of row) if (ch !== ' ') expect(allowed.has(ch)).toBe(true)
  expect(snapOf('docks').rows.join('')).toContain(GLYPH.water)
  expect(snapOf('woods').rows.join('')).toContain(GLYPH.tree)
})

test('painted is drawn with ink: neighbors share a frame edge, the scene the figure is in is the bright one, and @ is the only cell on a ground', () => {
  const layout = layoutOf(ALL)
  const grid = painted(layout, { route: '/', x: 3, y: 3 })
  const square = tileOf(layout, 'square'), woods = tileOf(layout, 'woods')
  expect(grid[square.y][square.x].fg).toBe('#e2e8f0')
  expect(grid[woods.y + 2][woods.x + 2].fg).not.toBe('#e2e8f0')
  expect(grid[square.y][square.x].ch).toBe('┬')
  expect(grid.flat().filter((c) => c.ch === '@').length).toBe(1)
  expect(grid.flat().every((c) => c.ch === ' ' || c.fg)).toBe(true)
})
