// web/src/lib/band/listening.js — whether this screen wants the band heard, and
// how loud. A screen's own choice, not the clock's: the band is the same on
// every screen (`shared/band.js`), but one member may mute it. It lives here
// rather than beside the band because it reads the environment and is mutated
// by `/music` and `/volume`, and shared code is pure.

/** Whether this machine wants the band heard — `/music` turns it, and `HAVEN_MUSIC=off` starts it off — and how loud, 0 to 100 (`/volume`). */
export const listening = { heard: globalThis.process?.env?.HAVEN_MUSIC !== 'off', volume: 100 }
