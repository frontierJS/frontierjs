// src/pieces/bar.js — the tavern's bar, with a stool at each of seven places
// along it. A stool is a solo seat: sat on and paired with nobody, so it is
// never a booth. `Bar.mesa` finds the bar by this piece and reads its stools.
import { piece } from './index.js'

export const STOOLS = [2, 8, 14, 20, 26, 32, 38]

export const bar = piece('bar', String.raw`
________________________________________
|======================================|
'--------------------------------------'
  o     o     o     o     o     o     o
`, String.raw`
wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww
wWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWw
wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww
  t     t     t     t     t     t     t
`, { spots: Object.fromEntries(STOOLS.map((dx, i) => [`stool-${i}`, { kind: 'seat', dx, dy: 3, stand: { dx, dy: 4 }, solo: true }])) })
