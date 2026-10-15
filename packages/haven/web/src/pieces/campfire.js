// src/pieces/campfire.js — a fire out of doors, a flame of radius 3 and a
// flicker. Its `h` is the light; a scene that wants another radius names `h`.
import { piece } from './index.js'

export const campfire = piece('campfire', '^', 'h', {
  palette: { h: { fg: ['#f97316', '#fb923c', '#fde047', '#fb923c'], ms: 300, flicker: true, light: 3 } },
})
