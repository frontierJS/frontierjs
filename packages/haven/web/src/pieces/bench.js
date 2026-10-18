// src/pieces/bench.js — a bench, and a bench with a package's name on it for
// the workshop (`namedBench`).
import { piece } from './index.js'

// Three solo seats along the plank, so `/sit` beside a bench sits on it
// (`Emotes.mesa`); each stands up to the cell in front of it.
export const bench = piece('bench', '[=====]', 'eeeeeee', {
  spots: Object.fromEntries([1, 3, 5].map((dx, i) => [`seat-${i}`, { kind: 'seat', dx, dy: 0, stand: { dx, dy: 1 }, solo: true }])),
})

/** Where the Claude sessions at a bench stand on the row below it, and the slot after the last, where its count is written (`Workers.mesa`). */
export const SLOTS = Object.fromEntries([0, 1, 2, 3].map((i) => [`slot-${i}`, { dx: 2 + 2 * i, dy: 1 }]))

/** The width of every named bench; the longest package name fits with a space either side, and a ledger's four piles lie across it (`ledger.js`). */
export const BENCH_WIDTH = 23

/**
 * A workshop bench: one width whatever the name, so a column of them lines
 * up. A bench with no work lists beside its neighbours at just its own name's
 * width (`width`).
 * The name is painted `n`, which the workshop's palette makes a light, so a
 * bench is read from the door; `bench` is what `Workers.mesa` finds it by.
 * A `count` (its open issues) is written after the name, `site-kit (3)`; the
 * spaces either side give way first, since `frontierjs-vscode (1)` fills a
 * bench to its brackets.
 */
export function namedBench(name, width = BENCH_WIDTH, count = null) {
  const text = count == null ? name : `${name} (${count})`
  const label = text.length + 2 > width - 2 ? text : ` ${text} `
  if (label.length > width - 2) throw new Error(`namedBench: "${text}" is longer than a bench`)
  const left = Math.floor((width - 2 - label.length) / 2)
  const right = width - 2 - label.length - left
  const art = `[${'='.repeat(left)}${label}${'='.repeat(right)}]`
  const paint = [...art].map((ch) => (ch === ' ' ? ' ' : /[\w-]/.test(ch) ? 'n' : 'w')).join('')
  return { ...piece('bench', art, paint, { spots: SLOTS }), bench: name }
}
