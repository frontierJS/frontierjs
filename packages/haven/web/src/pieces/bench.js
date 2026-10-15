// src/pieces/bench.js — a bench, and a bench with a package's name on it for
// the workshop (`namedBench`).
import { piece } from './index.js'

export const bench = piece('bench', '[=====]', 'eeeeeee')

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
 */
export function namedBench(name, width = BENCH_WIDTH) {
  const label = ` ${name} `
  if (label.length > width - 2) throw new Error(`namedBench: "${name}" is longer than a bench`)
  const left = Math.floor((width - 2 - label.length) / 2)
  const right = width - 2 - label.length - left
  const art = `[${'='.repeat(left)}${label}${'='.repeat(right)}]`
  const paint = [...art].map((ch) => (ch === ' ' ? ' ' : /[\w-]/.test(ch) ? 'n' : 'w')).join('')
  return { ...piece('bench', art, paint, { spots: SLOTS }), bench: name }
}
