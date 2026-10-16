// src/pieces/flower.js — one flower, walked over; a bed is a `<Row>` of them.
// A season is floor on the same cell, in letters of its own; the dormant one
// dyes nobody, since a figure stepping on it picks no color.
import { piece } from './index.js'

/** Tulips: pink, white and gold. */
const springFlower = piece('flower', '*', 'k', {
  floor: true,
  palette: { k: { fg: ['#f9a8d4', '#fef9c3', '#fbbf24', '#fda4af'], ms: 1500, flicker: true, dye: true } },
})

/** Asters, late: violet and rust. */
const fallFlower = piece('flower', '*', 'q', {
  floor: true,
  palette: { q: { fg: ['#a78bfa', '#c2410c', '#d97706', '#8b5cf6'], ms: 1500, flicker: true, dye: true } },
})

/** A dry stem in the snow. */
const winterFlower = piece('flower', ',', 'w', { floor: true, palette: { w: { fg: '#78716c' } } })

export const flower = piece('flower', '*', 'p', { floor: true, seasons: { spring: springFlower, fall: fallFlower, winter: winterFlower } })
