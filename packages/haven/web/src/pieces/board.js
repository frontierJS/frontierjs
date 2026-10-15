// src/pieces/board.js — the notice board on the square (`IDEAS/haven.md` 7.5),
// a board on two posts. `Notices.mesa` finds it by this piece and reads what is
// pinned from its `middle` spot outward.
import { piece } from './index.js'

export const noticeBoard = piece('notice board', String.raw`
.-------.
|NOTICES|
'-------'
 |     |
`, String.raw`
eeeeeeeee
essssssse
eeeeeeeee
 l     l
`, { spots: { middle: { dx: 4, dy: 1 } } })
