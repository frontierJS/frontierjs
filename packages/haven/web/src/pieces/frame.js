// src/pieces/frame.js — a scene's outer wall, 96 cells by 26 rows, drawn one
// column in so the picture has a margin. Only the border is drawn, so the
// room inside is free. A door in the wall is a `<Door>` placed over it.
import { piece } from './index.js'

const WIDTH = 96, HEIGHT = 26

const run = (end, mid) => ` ${end[0]}${mid.repeat(WIDTH - 2)}${end[1]}`
const art = [run(',.', '-'), ...Array(HEIGHT - 2).fill(run('||', ' ')), run("''", '-')]

export const frame = piece('frame', art.join('\n'), art.map((r) => r.replace(/[^ ]/g, 'f')).join('\n'))
