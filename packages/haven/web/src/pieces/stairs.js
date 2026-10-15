// src/pieces/stairs.js — the tavern's stairs, rising toward the room's centre
// from the bottom-left corner. The top step is a `<Door>` (`scenes/Tavern.mesa`)
// to the loft and the loft's own stairs stand on the same cells, so a figure
// who climbs arrives where the other room's top step is.
import { piece } from './index.js'

export const stairs = piece('stairs', String.raw`
            ____
        ____|
    ____|
____|
`, String.raw`
            uuuu
        uuuuu
    uuuuu
uuuuu
`)
