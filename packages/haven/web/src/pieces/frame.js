// src/pieces/frame.js — a scene's outer wall, drawn one column in so the
// picture has a margin. Only the border is drawn, so the room inside is
// free. A door in the wall is a `<Door>` placed over it. `frame` is the
// wall of a scene one screen wide (`VIEW` in stage.js); a scene bigger than
// the screen makes its own with `framed(width, height)` — the square's.
import { piece } from './index.js'

/** A frame piece `width` cells wide by `height` rows, the margin column outside it. */
export function framed(width, height) {
  const run = (end, mid) => ` ${end[0]}${mid.repeat(width - 2)}${end[1]}`
  const art = [run(',.', '-'), ...Array(height - 2).fill(run('||', ' ')), run("''", '-')]
  return piece('frame', art.join('\n'), art.map((r) => r.replace(/[^ ]/g, 'f')).join('\n'))
}

export const frame = framed(96, 26)
