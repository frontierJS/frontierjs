// editor/test/source.test.js — a scene file read as placed tags and written
// back: untouched it is its own bytes, and an edit moves only its own
// characters; the tags bind one to one to the stage the scene draws; a
// pasted block of art is recognized as pieces; a history packs and unpacks.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readScene, writeScene } from '../source.js'
import { bind, placeOf, cellsOf, hit, snapshotEls, problems, editsOf, record, undo, redo, packHistory, unpackHistory, emptyHistory, remapOf, rekeyHistory, nextIdAfter } from '../doc.js'
import { recognize } from '../import.js'
import { piece } from '../../web/src/pieces/index.js'
import { table } from '../../web/src/pieces/table.js'
import { mountScene, SCENES, WEB } from '../../web/test/stage.mjs'

const SOURCES = Object.fromEntries(SCENES.map(({ name }) => [name, readFileSync(join(WEB, 'src/scenes', `${name}.mesa`), 'utf8')]))

// ─── the file as text ────────────────────────────────────────────────

// The workshop's benches stand where the register's counts put them, so the
// file is a loop and the editor refuses it by name.
for (const { name } of SCENES.filter((s) => s.name !== 'Workshop')) {
  test(`${name}: read as a flat list of placed tags`, () => {
    const scene = readScene(SOURCES[name])
    expect(scene.slug).toBe(name.toLowerCase())
    expect(scene.elements.length).toBeGreaterThan(5)
    expect(scene.elements[0]).toMatchObject({ id: 0, kind: 'Piece', attrs: { of: 'frame' } })
    expect(scene.elements.some((e) => e.kind === 'Door')).toBe(true)
  })

  test(`${name}: saved with no edit it is its own bytes`, () => {
    expect(writeScene(SOURCES[name], {})).toBe(SOURCES[name])
  })
}

test('Workshop: a computed room is refused by name, never read as a flat list', () => {
  expect(() => readScene(SOURCES.Workshop)).toThrow('a block in the markup')
})

test('an attribute edit moves only its own characters, and a missing one is added', () => {
  const src = SOURCES.Tavern
  const { elements } = readScene(src)
  const table0 = elements.find((e) => e.kind === 'Piece' && e.attrs.of === 'table')
  const out = writeScene(src, { elements: { [table0.id]: { x: 10 }, 0: { x: 1, y: 2 } } })
  expect(out).toContain('<Piece of={table}   x={10}  y={13} />')
  expect(out).toContain('<Piece of={frame} x={1} y={2} />')
  expect(out.length).toBe(src.length + 1 + ' x={1} y={2}'.length)
})

test('a removed tag takes its line with it, and an added one goes before </Scene> with an import', () => {
  const src = SOURCES.Tavern
  const { elements } = readScene(src)
  const barrel = elements.filter((e) => e.attrs.of === 'barrel').at(-1)
  const out = writeScene(src, {
    remove: [barrel.id],
    add: [
      { kind: 'Piece', attrs: { of: { expr: 'lamp' }, x: 40, y: 20 }, import: { ident: 'lamp', file: 'lamp.js' } },
      { kind: 'Door', attrs: { x: 3, y: 25, to: '/woods/' } },
    ],
  })
  expect(out).not.toContain(`x={${barrel.attrs.x}} y={${barrel.attrs.y}}`)
  expect(out.split('\n').length).toBe(src.split('\n').length - 1 + 2 + 1)
  expect(out).toContain("  import { lamp } from '@/pieces/lamp.js'\n")
  expect(out).toContain('  <Piece of={lamp} x={40} y={20} />\n')
  expect(out).toContain('  <Door x={3} y={25} to="/woods/" />\n</Scene>')
  // Read again: the added tags are the last two.
  const again = readScene(out)
  expect(again.elements.at(-2).attrs).toEqual({ of: 'lamp', x: 40, y: 20 })
  expect(again.elements.at(-1).attrs).toEqual({ x: 3, y: 25, to: '/woods/' })
})

test('a second import of a piece already imported is not written', () => {
  const src = SOURCES.Tavern
  const out = writeScene(src, { add: [{ kind: 'Piece', attrs: { of: { expr: 'table' }, x: 1, y: 1 }, import: { ident: 'table', file: 'table.js' } }] })
  expect(out.match(/import \{ table \}/g).length).toBe(1)
})

test("the spawn, a door's target and a palette entry are spliced in place", () => {
  const src = SOURCES.Tavern
  const { elements } = readScene(src)
  const door = elements.find((e) => e.kind === 'Door')
  const out = writeScene(src, { spawn: { x: 50, y: 20 }, elements: { [door.id]: { to: '/square/' } }, palette: { f: ['#000000'], y: ['#111111', '#222222', '#333333'] } })
  expect(out).toContain('spawn={{ x: 50, y: 20 }}')
  expect(out).toContain('<Door  x={48} y={25} to="/square/" />')
  expect(out).toContain("    f: { fg: '#000000' },")
  expect(out).toContain("    y: { fg: ['#111111', '#222222', '#333333'], chars: 'i!i', ms: 300, flicker: true },")
})

test('another shape of file is refused by name', () => {
  expect(() => readScene('<script></script>\n<Scene slug="x" spawn={{ x: 1, y: 1 }}>{#each a as b}<Piece of={b} />{/each}</Scene>')).toThrow('a block in the markup')
  expect(() => readScene('<script></script>\n<Scene slug="x" spawn={{ x: 1, y: 1 }}><Figure x={1} /></Scene>')).toThrow('<Figure> is not a tag the stage knows')
  expect(() => readScene('<script></script>\n<Scene palette={P}><Piece of={a} /></Scene>')).toThrow('needs `slug=')
})

// ─── the tags and the stage ──────────────────────────────────────────

const { stage: tavern } = await mountScene('Tavern')
const tavernEls = bind(readScene(SOURCES.Tavern), tavern)

test('every tag binds to the mark the scene drew for it, in order', () => {
  expect(tavernEls.length).toBe(tavern.marks.length)
  const cat = tavernEls.find((e) => e.kind === 'Pacer')
  expect(placeOf(cat)).toEqual({ y: 12, from: 66, to: 86 })
  const door = tavernEls.find((e) => e.kind === 'Door')
  expect(placeOf(door)).toEqual({ x: 48, y: 25, to: '/', w: 1, h: 1 })
  expect(cellsOf(door)).toEqual([{ x: 48, y: 25 }])
})

test('a click finds the door before the wall it is in, and the last placed piece on a cell', () => {
  expect(hit(tavernEls, 48, 25).kind).toBe('Door')
  expect(hit(tavernEls, 1, 1).ident).toBe('frame')
  expect(hit(tavernEls, 10, 14).ident).toBe('table')
  expect(hit(tavernEls, 70, 12).kind).toBe('Pacer')
  expect(hit(tavernEls, 40, 20)).toBeNull()
})

test('a file whose tag count is not the stage\'s is refused', () => {
  const parsed = readScene(SOURCES.Tavern)
  expect(() => bind({ ...parsed, elements: parsed.elements.slice(1) }, tavern)).toThrow('binds one tag to one mark')
})

test('the problems a stage has: a spawn off the floor, a door out of reach', () => {
  expect(problems(tavern)).toEqual([])
  const stage = { spawn: { x: 0, y: 0 }, doors: [{ x: 5, y: 0, to: '/' }], pacers: [], walkable: (x, y) => y === 0 && x >= 0 && x < 3 }
  expect(problems(stage).map((p) => p.text)).toEqual(['the door to / at 5,0 — the spawn cannot reach it'])
  expect(problems({ ...stage, spawn: { x: 9, y: 9 } })[0].text).toBe('the spawn 9,9 is not floor')
})

test('edits are the difference between the marks and the file, nothing when nothing moved', () => {
  const parsed = readScene(SOURCES.Tavern)
  const colors = Object.fromEntries(Object.entries(tavern.palette).map(([k, v]) => [k, [v.fg].flat().filter((c) => typeof c === 'string')]))
  const state = { els: snapshotEls(tavernEls), spawn: { ...parsed.spawn }, colors }
  expect(editsOf(parsed, state, colors)).toEqual({})
  const table0 = tavernEls.find((e) => e.ident === 'table')
  table0.mark.move(10, 13)
  const moved = { ...state, els: snapshotEls(tavernEls).filter((e) => e.ident !== 'barrel'), spawn: { x: 50, y: 20 } }
  moved.els.push({ id: 99, kind: 'Piece', ident: 'lamp', file: 'lamp.js', x: 40, y: 20 })
  const edits = editsOf(parsed, { ...moved, colors: { ...colors, f: ['#000000'] } }, colors)
  expect(edits.elements).toEqual({ [table0.id]: { x: 10 } })
  expect(edits.remove.length).toBe(3)
  expect(edits.add).toEqual([{ kind: 'Piece', attrs: { of: { expr: 'lamp' }, x: 40, y: 20 }, import: { ident: 'lamp', file: 'lamp.js' } }])
  expect(edits.spawn).toEqual({ x: 50, y: 20 })
  expect(edits.palette).toEqual({ f: ['#000000'] })
  table0.mark.move(9, 13)
})

// ─── a pasted block of art ───────────────────────────────────────────

const wall = piece('wall', '|', 'w')

test('a block of art is recognized as the pieces at hand, largest first', () => {
  const out = recognize('o|o |\n', [{ ident: 'wall', piece: wall }, { ident: 'table', piece: piece('table', 'o|o', 'tct') }])
  expect(out.placements.map(({ ident, x, y }) => ({ ident, x, y }))).toEqual([{ ident: 'table', x: 0, y: 0 }, { ident: 'wall', x: 4, y: 0 }])
  expect(out.twice).toEqual([])
  expect(out.unclaimed).toEqual([])
})

test('two pieces of one size on a cell, and a glyph no piece draws, are named with the cell', () => {
  const across = piece('across', 'ab', 'xx')
  const down   = piece('down', 'a\nb', 'y\ny')
  expect(recognize('ab\nb', [{ ident: 'across', piece: across }, { ident: 'down', piece: down }]).twice).toEqual([{ x: 0, y: 0, pieces: ['across', 'down'] }])
  expect(recognize(' |?', [{ ident: 'wall', piece: wall }]).unclaimed).toEqual([{ x: 2, y: 0, ch: '?' }])
})

test('two tables drawn side by side are two placements', () => {
  const art = table.art.split('\n').map((r) => `${r.padEnd(11)}   ${r}`).join('\n')
  const out = recognize(art, [{ ident: 'table', piece: table }])
  expect(out.placements.map((p) => [p.x, p.y])).toEqual([[0, 0], [14, 0]])
})

// ─── undo ────────────────────────────────────────────────────────────

test('a run of one kind is one step; a history packs and unpacks on the text it was saved with', () => {
  let h = emptyHistory()
  h = record(h, { els: [], spawn: { x: 1, y: 1 }, colors: {} }, 'move:1', 1000)
  h = record(h, { els: [], spawn: { x: 2, y: 1 }, colors: {} }, 'move:1', 1500)
  h = record(h, { els: [{ id: 0, kind: 'Piece', ident: 'table', file: null, piece: table, spec: null, x: 1, y: 1 }], spawn: { x: 3, y: 1 }, colors: {} }, null, 1600)
  expect(h.past.length).toBe(2)
  const current = { els: [], spawn: { x: 9, y: 9 }, colors: {} }
  const back = undo(h, current)
  expect(back.state.spawn).toEqual({ x: 3, y: 1 })
  expect(redo(back.history, back.state).state).toEqual(current)
  const json = packHistory(h, 'text')
  expect(json).not.toContain('"cells"')
  const known = new Map([['table', table]])
  expect(unpackHistory(json, 'text', known, []).past[1].els[0].piece).toBe(table)
  expect(unpackHistory(json, 'other text', known, [])).toEqual(emptyHistory())
  expect(unpackHistory(json, 'text', new Map(), [])).toEqual(emptyHistory())
})

test('a history kept across a save is rekeyed to the saved file, a removed tag getting a fresh id', () => {
  const parsed = { elements: [{ id: 0 }, { id: 1 }, { id: 2 }] }
  // Saved: tag 1 removed, an element 7 added → the file is [0, 2, 7] as ids 0, 1, 2.
  const { map, next } = remapOf(parsed, [{ id: 0 }, { id: 2 }, { id: 7 }])
  expect([...map]).toEqual([[0, 0], [2, 1], [7, 2]])
  expect(next).toBe(3)
  const h = { past: [{ els: [{ id: 0 }, { id: 1 }, { id: 2 }] }, { els: [{ id: 0 }, { id: 2 }, { id: 7 }, { id: 1 }] }], future: [], kind: null, at: 0 }
  const out = rekeyHistory(h, { map, next })
  expect(out.past[0].els.map((e) => e.id)).toEqual([0, 3, 1])
  expect(out.past[1].els.map((e) => e.id)).toEqual([0, 1, 2, 3])
  expect(nextIdAfter(out, 3)).toBe(4)
})
