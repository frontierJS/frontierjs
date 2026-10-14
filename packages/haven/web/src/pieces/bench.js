// src/pieces/bench.js — a bench, and a bench with a package's name on it for
// the workshop (`namedBench`).
import { piece } from './index.js'

export const bench = piece('bench', '[=====]', 'eeeeeee')

/** The width of every named bench; the longest package name fits with a space either side. */
export const BENCH_WIDTH = 21

/**
 * A workshop bench: one width whatever the name, so a row of them lines up.
 * The name is painted `n`, which the workshop's palette makes a light, so a
 * bench is read from the door; `bench` is what `Workers.mesa` finds it by.
 */
export function namedBench(name) {
  const label = ` ${name} `
  if (label.length > BENCH_WIDTH - 2) throw new Error(`namedBench: "${name}" is longer than a bench`)
  const left = Math.floor((BENCH_WIDTH - 2 - label.length) / 2)
  const right = BENCH_WIDTH - 2 - label.length - left
  const art = `[${'='.repeat(left)}${label}${'='.repeat(right)}]`
  const paint = [...art].map((ch) => (ch === ' ' ? ' ' : /[\w-]/.test(ch) ? 'n' : 'w')).join('')
  return { ...piece('bench', art, paint), bench: name }
}
