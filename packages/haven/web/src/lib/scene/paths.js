// src/paths.js — walking a stage by its floor: the flood fill the door-reach
// check runs, and the shortest walk to a figure that `f` takes (`IDEAS/haven.md`
// 9.6), and how far each stop Tab names is walked (Phase 19). Pure, so it is
// a bun test. Steps are the four a figure takes, never a diagonal, so the walk
// drawn is the walk a key would have made.

export const STEPS = [[0, 1], [0, -1], [1, 0], [-1, 0]]

const key = (x, y) => `${x},${y}`

/** Every floor cell a figure at `from` can walk to, as `'x,y'` keys — `from` included. */
export function reach(stage, from) {
  return new Set(flood(stage, from).keys())
}

/** Every floor cell a figure at `from` can walk to, as `{ x, y, n }`, `n` the steps there. */
export function walked(stage, from) {
  return [...flood(stage, from).values()].map(({ x, y, n }) => ({ x, y, n }))
}

/** Each reached cell's `{ x, y, prev, n }`, `prev` the key of the cell it was entered from. */
function flood(stage, from) {
  const cells = new Map([[key(from.x, from.y), { x: from.x, y: from.y, prev: null, n: 0 }]])
  const queue = [from]
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i]
    const n = cells.get(key(x, y)).n + 1
    for (const [dx, dy] of STEPS) {
      const k = key(x + dx, y + dy)
      if (!cells.has(k) && stage.walkable(x + dx, y + dy)) {
        cells.set(k, { x: x + dx, y: y + dy, prev: key(x, y), n })
        queue.push({ x: x + dx, y: y + dy })
      }
    }
  }
  return cells
}

/** The cells walked from `from` to the cell keyed `to`, `from` left out. */
function walkTo(cells, to) {
  const out = []
  for (let c = cells.get(to); c?.prev != null; c = cells.get(c.prev)) out.unshift({ x: c.x, y: c.y })
  return out
}

/**
 * The shortest walk from `from` to stand beside `goal`, as the cells stepped
 * onto in order — empty when already beside it, null when no floor beside it
 * can be reached. A figure is walked up to, never onto.
 */
export function pathBeside(stage, from, goal) {
  return nearestOf(flood(stage, from), from, [goal])?.path ?? null
}

function nearestOf(cells, from, goals) {
  let best = null
  for (const goal of goals) {
    for (const [dx, dy] of STEPS) {
      const k = key(goal.x + dx, goal.y + dy)
      if (!cells.has(k)) continue
      const path = k === key(from.x, from.y) ? [] : walkTo(cells, k)
      if (!best || path.length < best.path.length) best = { goal, path }
    }
  }
  return best
}

/**
 * `f` and a letter: the figure whose nick starts with it, nearest by the walk
 * rather than by the crow, and the walk there — or null when none can be
 * reached. `figures` are `{ nick, x, y }`, this screen's own figure left out by
 * the caller. A tie goes to the nick first in order, so two screens agree.
 */
export function findByNick(stage, from, figures, letter) {
  const l = String(letter ?? '').toLowerCase()
  if (!l) return null
  const named = figures
    .filter((f) => String(f.nick ?? '').toLowerCase().startsWith(l))
    .sort((a, b) => String(a.nick).localeCompare(String(b.nick)))
  if (!named.length) return null
  const found = nearestOf(flood(stage, from), from, named)
  return found && { figure: found.goal, path: found.path }
}
