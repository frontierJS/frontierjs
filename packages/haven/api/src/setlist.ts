// api/src/setlist.ts
// Song requests in the loft: `/song 42` puts song 42 on for every screen in the
// room at the band's next bar line, and the songs after it follow on in order.
// Every song is drawn by `web/src/band.js` from its number alone, so a request
// is a cue of two numbers -- the song and the wall-clock ms it starts -- and is
// the one thing the server sends about the music.
//
// Held in memory per room, as the room's memory is (`FJS-D993`): a restart puts
// the room back on the clock's songs, and a screen already in the loft keeps
// counting from the old cue until it walks in again.

import { CLOCK, cueAt } from '../../web/src/band.js'

/** The rooms with a band in them. */
export const BAND_ROOMS = new Set(['upstairs'])

/** How far ahead of the request a cue starts: the socket's trip, and the
 *  `AHEAD_MS` a screen has already pulled, both fit inside it. */
export const LEAD_MS = 1500

export type Cue = { first: number, at: number }

export function createSetlist ({ now = Date.now }: { now?: () => number } = {}) {
  const cues = new Map<number, Cue>()
  return {
    /** The cue room `roomId` counts its songs from. */
    cueOf (roomId: number): Cue {
      return cues.get(roomId) ?? CLOCK
    },
    /** Song `k` from the next bar line. A cue whose bar has not come yet is
     *  replaced at its own `at`, so two requests a moment apart are one switch. */
    request (roomId: number, k: number): Cue {
      const t   = now()
      const cur = cues.get(roomId) ?? CLOCK
      const cue = cur.at > t ? { first: k, at: cur.at } : cueAt(t + LEAD_MS, k, cur)
      cues.set(roomId, cue)
      return cue
    },
  }
}

export type Setlist = ReturnType<typeof createSetlist>
