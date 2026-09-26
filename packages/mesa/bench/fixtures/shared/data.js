/*
 * data.js — the workload every bench fixture runs, as pure functions over a
 * rows array.
 *
 * Both the Mesa fixture and the vanilla floor import THIS module, so the two
 * differ only in how a new array reaches the DOM. A transform written twice
 * would let one side do less work and read as faster.
 *
 * Seeded rather than Math.random: the runner compares the rendered table
 * between fixtures and asserts a DOM mutation count per operation, and both
 * need the same shuffle and the same labels on every load. The word lists are
 * js-framework-benchmark's.
 */

const adjectives = [
  'pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome',
  'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful',
  'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive', 'cheap',
  'expensive', 'fancy'
]
const colors = [
  'red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown',
  'white', 'black', 'orange'
]
const nouns = [
  'table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie',
  'sandwich', 'burger', 'pizza', 'mouse', 'keyboard'
]

// mulberry32 — small, fast, and the same sequence in every engine.
let seed = 0x9e3779b9
function rnd(max) {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (((t ^ (t >>> 14)) >>> 0) % max)
}

let nextId = 1

export function buildData(count) {
  const out = new Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = {
      id:    nextId++,
      label: `${adjectives[rnd(adjectives.length)]} ${colors[rnd(colors.length)]} ${nouns[rnd(nouns.length)]}`
    }
  }
  return out
}

// ─── js-framework-benchmark operations ───────────────────────────────────────

export const run     = ()     => buildData(1000)
export const runLots = ()     => buildData(10000)
export const add     = (rows) => rows.concat(buildData(1000))
export const clear   = ()     => []

export function update(rows) {
  const next = rows.slice()
  for (let i = 0; i < next.length; i += 10)
    next[i] = { id: next[i].id, label: next[i].label + ' !!!' }
  return next
}

export function swapRows(rows) {
  if (rows.length < 999) return rows
  const next = rows.slice()
  const tmp  = next[1]
  next[1]    = next[998]
  next[998]  = tmp
  return next
}

export const remove = (rows, id) => rows.filter(r => r.id !== id)

// ─── keyed reorders ──────────────────────────────────────────────────────────
//
// The shapes a keyed reconciler gets wrong: a full reverse, a random
// permutation, a one-step rotation (one move, if the diff finds it), and
// insertions and removals away from the ends.

export const reverse = (rows) => rows.slice().reverse()

export function shuffle(rows) {
  const next = rows.slice()
  for (let i = next.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    const t = next[i]; next[i] = next[j]; next[j] = t
  }
  return next
}

export const rotate        = (rows) => rows.length ? [rows[rows.length - 1], ...rows.slice(0, -1)] : rows
export const prepend100    = (rows) => buildData(100).concat(rows)
export const insertMid100  = (rows) => { const m = rows.length >> 1; return [...rows.slice(0, m), ...buildData(100), ...rows.slice(m)] }
export const removeFirst   = (rows) => rows.slice(1)
export const removeEvery10 = (rows) => rows.filter((_, i) => i % 10 !== 0)
