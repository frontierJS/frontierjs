// src/pieces/lamp.js — a street lamp. Its bulb is `Y`, the palette's light,
// so a scene that places one names `Y` with a `light`.
import { piece } from './index.js'

export const lamp = piece('lamp', String.raw`
(o)
 |
 |
_|_
`, String.raw`
lYl
 l
 l
lll
`)
