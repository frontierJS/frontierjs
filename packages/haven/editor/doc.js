// editor/doc.js — the scene as the editor holds it: the file's placed tags
// bound one to one to the marks the mounted scene made on its stage, the
// edits made by click and key, and what is wrong.
//
// The preview IS the scene component, mounted on the page; an edit moves a
// mark on its stage and the stage repaints. The file is written only at
// Save, from the difference between the marks and the file's tags.
//
// Pure: no DOM, so the binding, the problems and the undo are a bun test.

/** The attributes a kind is placed by, in the order a tag writes them. */
const PLACED = {
  Piece: ['x', 'y'],
  Row:   ['x', 'y'],
  Door:  ['x', 'y', 'to', 'w', 'h'],
  Pacer: ['y', 'from', 'to'],
}

/**
 * The file's tags bound to the stage's marks, in document order. The scene
 * mounts its tags in the order they are written, so the i-th tag is the
 * i-th mark; a count that differs is a file the editor cannot bind.
 */
export function bind(parsed, stage) {
  const tags = parsed.elements, marks = stage.marks
  if (tags.length !== marks.length) {
    throw new Error(`the markup places ${tags.length} tags and the stage drew ${marks.length} marks — the editor binds one tag to one mark`)
  }
  return tags.map((t, i) => {
    const kind = { piece: 'Piece', door: 'Door', pacer: 'Pacer' }[marks[i].kind]
    const expected = t.kind === 'Row' ? 'Piece' : t.kind
    if (kind !== expected) throw new Error(`tag ${i} is <${t.kind}> but the stage drew a ${marks[i].kind}`)
    return { id: t.id, kind: t.kind, ident: t.attrs.of ?? null, file: null, mark: marks[i] }
  })
}

/** An element the editor added: its tag is written at Save. */
export const added = (id, kind, ident, file, mark) => ({ id, kind, ident, file, mark })

/** Where an element stands, as its tag's attributes. */
export function placeOf(el) {
  const m = el.mark
  if (el.kind === 'Door')  return { x: m.x, y: m.y, to: m.to, w: m.w, h: m.h }
  if (el.kind === 'Pacer') return { y: m.spec.y, from: m.spec.from, to: m.spec.to }
  return { x: m.x, y: m.y }
}

/** The cells an element covers, for a click to find it and a mark to show it. */
export function cellsOf(el) {
  const m = el.mark
  if (el.kind === 'Door') {
    const out = []
    for (let dy = 0; dy < m.h; dy++) for (let dx = 0; dx < m.w; dx++) out.push({ x: m.x + dx, y: m.y + dy })
    return out
  }
  if (el.kind === 'Pacer') {
    const out = []
    for (let x = m.spec.from; x <= m.spec.to; x++) out.push({ x, y: m.spec.y })
    return out
  }
  return m.piece.cells.map((c) => ({ x: m.x + c.dx, y: m.y + c.dy }))
}

/** The element on a cell: a door before the wall it is in, and the last placed otherwise. */
export function hit(els, x, y) {
  const on = (el) => cellsOf(el).some((c) => c.x === x && c.y === y)
  return els.find((el) => el.kind === 'Door' && on(el)) ?? [...els].reverse().find(on) ?? null
}

/** A snapshot of the elements, plain data the history keeps. */
export const snapshotEls = (els) => els.map((el) => ({
  id: el.id, kind: el.kind, ident: el.ident, file: el.file,
  piece: el.mark.piece ?? null, spec: el.mark.spec ?? null, name: el.mark.spec?.name ?? null, ...placeOf(el),
}))

// ─── problems ────────────────────────────────────────────────────────

const STEPS = [[0, 1], [0, -1], [1, 0], [-1, 0]]

/**
 * What is wrong with a stage, each with the cells it names: a spawn off the
 * floor, a door the spawn cannot reach, a pacer's row crossing a wall — the
 * rules `web/test/scenes.test.js` holds a scene to, asked while it is being
 * placed. Two pieces on one cell never get this far: the stage refuses the
 * move, and the page says so.
 */
export function problems(stage) {
  const out = []
  const { spawn } = stage
  if (!stage.walkable(spawn.x, spawn.y)) out.push({ kind: 'spawn', cells: [{ ...spawn }], text: `the spawn ${spawn.x},${spawn.y} is not floor` })
  else {
    const seen = reach(stage, spawn)
    for (const d of stage.doors) {
      const reached = STEPS.some(([dx, dy]) => seen.has(`${d.x + dx},${d.y + dy}`))
      if (!reached) out.push({ kind: 'door', cells: [d], text: `the door to ${d.to} at ${d.x},${d.y} — the spawn cannot reach it` })
    }
  }
  if (!stage.doors.length) out.push({ kind: 'door', cells: [], text: 'no door — a scene with no way out' })
  for (const p of stage.pacers) {
    const off = []
    for (let x = p.from; x <= p.to; x++) if (!stage.walkable(x, p.y)) off.push({ x, y: p.y })
    if (off.length) out.push({ kind: 'pacer', cells: off, text: `the ${p.name}'s row ${p.y}, ${p.from}–${p.to} crosses ${off.length} cell(s) that are not floor` })
  }
  return out
}

function reach(stage, from) {
  const seen = new Set([`${from.x},${from.y}`])
  const queue = [from]
  while (queue.length) {
    const { x, y } = queue.shift()
    for (const [dx, dy] of STEPS) {
      const k = `${x + dx},${y + dy}`
      if (!seen.has(k) && stage.walkable(x + dx, y + dy)) { seen.add(k); queue.push({ x: x + dx, y: y + dy }) }
    }
  }
  return seen
}

// ─── the palette and the edits ───────────────────────────────────────

/** An entry's hexes in the order its line writes them. */
export const hexesOf = (entry) => [entry?.fg].flat().filter((c) => typeof c === 'string')

/** `entry` with `hexes` written over its `fg`, keeping its shape. */
export function withHexes(entry, hexes) {
  return entry ? { ...entry, fg: Array.isArray(entry.fg) ? hexes : hexes[0] } : { fg: hexes[0] }
}

/**
 * What `writeScene` splices for `state` (`{ els, spawn, colors }`, the els a
 * snapshot) against the file as parsed: an attribute only when it moved, a
 * tag the file has and the state does not as a removal, one the state added
 * as a new tag, the spawn and a palette entry only when they changed — a
 * palette entry against `baseColors`, the file's hexes by key, since the
 * stage's own palette is edited in place — so an untouched file writes back
 * as its own bytes.
 */
export function editsOf(parsed, state, baseColors) {
  const edits = {}
  const live = new Map(state.els.map((el) => [el.id, el]))
  for (const tag of parsed.elements) {
    const el = live.get(tag.id)
    if (!el) { (edits.remove ??= []).push(tag.id); continue }
    const changed = {}
    for (const key of PLACED[tag.kind]) {
      // A tag writes no `x` for 0 and no size for one cell, the components' defaults.
      const was = tag.attrs[key] ?? (key === 'x' || key === 'y' ? 0 : key === 'w' || key === 'h' ? 1 : undefined)
      if (el[key] !== was) changed[key] = el[key]
    }
    if (Object.keys(changed).length) (edits.elements ??= {})[tag.id] = changed
  }
  for (const el of state.els) {
    if (el.id < parsed.elements.length) continue
    const attrs = el.kind === 'Door'
      ? { x: el.x, y: el.y, to: el.to, w: el.w > 1 ? el.w : undefined, h: el.h > 1 ? el.h : undefined }
      : { of: { expr: el.ident }, x: el.x, y: el.y }
    const add = { kind: el.kind, attrs }
    if (el.file) add.import = { ident: el.ident, file: el.file }
    ;(edits.add ??= []).push(add)
  }
  if (state.spawn.x !== parsed.spawn.x || state.spawn.y !== parsed.spawn.y) edits.spawn = { ...state.spawn }
  for (const [key, hexes] of Object.entries(state.colors)) {
    if (hexes.join() !== (baseColors[key] ?? []).join()) (edits.palette ??= {})[key] = hexes
  }
  return edits
}

// ─── undo ────────────────────────────────────────────────────────────

/**
 * An element's id is its tag's position in the file, and a save renumbers
 * the file: a removed tag's line is gone and an added tag comes last. So a
 * history kept across a save is rekeyed by this map — old id → the id the
 * saved file gives it — before it is packed, or a step would move the wrong
 * tags and place a piece as the cat. An id the saved file no longer has
 * (a tag removed before the save) gets a fresh id past the file's, so a step
 * that still holds it places it again as an added tag.
 */
export function remapOf(parsed, savedEls) {
  const map = new Map()
  let n = 0
  const kept = new Set(savedEls.map((el) => el.id))
  for (const tag of parsed.elements) if (kept.has(tag.id)) map.set(tag.id, n++)
  for (const el of savedEls) if (!map.has(el.id)) map.set(el.id, n++)
  return { map, next: n }
}

export function rekeyHistory(history, { map, next }) {
  const fresh = new Map()
  const key = (id) => {
    if (map.has(id)) return map.get(id)
    if (!fresh.has(id)) fresh.set(id, next++)
    return fresh.get(id)
  }
  const rekey = (s) => ({ ...s, els: s.els.map((el) => ({ ...el, id: key(el.id) })) })
  return { ...history, past: history.past.map(rekey), future: history.future.map(rekey) }
}

/** The first id no step of the history uses, so an added element never collides with one. */
export const nextIdAfter = (history, from) =>
  Math.max(from, ...[...history.past, ...history.future].flatMap((s) => s.els.map((el) => el.id + 1)))

const LIMIT = 200
const RUN_MS = 1000

/** No step to undo or redo. */
export const emptyHistory = () => ({ past: [], future: [], kind: null, at: 0 })

/**
 * `history` with `state` — the editor's state BEFORE an edit — kept as a step
 * to undo back to. An edit of the same `kind` within a second of the last
 * joins that step, so a run of arrow presses or a color dragged undoes as
 * one; a null `kind` is always a step of its own. Any edit drops what could
 * be redone.
 */
export function record(history, state, kind, now = Date.now()) {
  if (kind && kind === history.kind && now - history.at < RUN_MS) return { ...history, at: now }
  return { past: [...history.past, state].slice(-LIMIT), future: [], kind, at: now }
}

/** `{ history, state }` one step back, `state` being what to show now; null when there is none. */
export function undo(history, current) {
  if (!history.past.length) return null
  return { history: { past: history.past.slice(0, -1), future: [...history.future, current], kind: null, at: 0 }, state: history.past.at(-1) }
}

/** `{ history, state }` one step forward again; null when there is none. */
export function redo(history, current) {
  if (!history.future.length) return null
  return { history: { past: [...history.past, current], future: history.future.slice(0, -1), kind: null, at: 0 }, state: history.future.at(-1) }
}

/**
 * `history` as JSON for `sessionStorage`, anchored to `source`, the file's
 * text it ends at. A piece object is kept by its element's ident and found
 * again on the way back.
 */
export function packHistory(history, source) {
  const pack = (s) => ({ ...s, els: s.els.map(({ piece, spec, ...el }) => el) })
  return JSON.stringify({ source, past: history.past.map(pack), future: history.future.map(pack) })
}

/**
 * The history `packHistory` wrote, or an empty one when it ends at another
 * text than `source` — the file was changed by something else since — or
 * names a piece `known` (ident → piece) no longer has. A pacer's spec is
 * the live one of its name.
 */
export function unpackHistory(json, source, known, pacers) {
  try {
    const kept = JSON.parse(json)
    if (kept?.source !== source) return emptyHistory()
    const unpack = (s) => ({
      ...s,
      els: s.els.map((el) => {
        if (el.kind === 'Door') return { ...el, piece: null, spec: null }
        if (el.kind === 'Pacer') {
          const spec = pacers.find((p) => p.name === el.name) ?? pacers[0]
          if (!spec) throw new Error('a pacer is gone')
          return { ...el, piece: null, spec }
        }
        const piece = known.get(el.ident)
        if (!piece) throw new Error(`piece ${el.ident} is gone`)
        return { ...el, piece, spec: null }
      }),
    })
    return { past: kept.past.map(unpack), future: kept.future.map(unpack), kind: null, at: 0 }
  } catch {
    return emptyHistory()
  }
}
