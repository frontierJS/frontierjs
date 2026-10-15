// src/pieces/stone.js — rock that was never carved, out of doors: a standing
// stone and a boulder. Paint letters are the scene's (`s` stone, `b` boulder).
import { piece } from './index.js'

export const stone = piece('stone', String.raw`
 _
| |
|_|
`, String.raw`
 s
s s
sss
`)

export const boulder = piece('boulder', '(__)', 'bbbb')
