// The loft's band (`setlist.ts`): `cue` is where a room counts its songs from,
// read by a screen as it walks in, and `request` puts a song on at the next bar
// line and tells the room `song` with the new cue. The caller must stand in
// the room, as a roller of the dice must.
import { createService, $, BadRequest } from '@frontierjs/junction'
import { rateLimitHook } from '@frontierjs/junction/hooks'
import type { Channel } from '@frontierjs/junction'

import type { HavenApp } from '../app.ts'
import { roomChannelName } from '../rooms.ts'
import { BAND_ROOMS } from '../setlist.ts'
import { MAX_SONG, songOf } from '../../../web/src/lib/band/band.js'

type Roster = { localPresence: (channel: string) => Array<{ userId: string | number }> }

type BandApp = HavenApp & { channel: (name: string) => Channel, channels: Roster }

const haven = () => $.app as BandApp

async function bandRoom () {
  const { roomId } = ($.data ?? {}) as { roomId?: unknown }
  const row = await ($.db as any).room.findFirst({ where: { id: roomId }, select: { id: true, slug: true } })
  if (!row) throw new BadRequest('No such room')
  if (!BAND_ROOMS.has(row.slug)) throw new BadRequest('No band plays here')
  return row as { id: number, slug: string }
}

export default createService({
  model:   'Room',
  methods: ['cue', 'request'],
  hooks: {
    before: {
      request: [rateLimitHook({ max: 3, window: '30s', message: 'Slow down — let the band play a while' })],
    },
  },

  /** `{ roomId }` — `{ first, at }`: song `first` starts at wall-clock `at`. */
  async cue () {
    const row = await bandRoom()
    $.dispatch = false
    return haven().setlist.cueOf(row.id)
  },

  /** `{ roomId, song }` — answers the cue and the song's name; the room hears `song` with the cue. */
  async request () {
    const me = Number(($.user as { id?: string } | undefined)?.id)
    if (!Number.isInteger(me)) throw new BadRequest('Walk in first: nobody asked')
    const { song } = ($.data ?? {}) as { song?: unknown }
    if (!Number.isInteger(song) || (song as number) < 0 || (song as number) > MAX_SONG) throw new BadRequest(`A song is a number from 0 to ${MAX_SONG}`)
    const row     = await bandRoom()
    const channel = roomChannelName(row.id)
    if (!haven().channels.localPresence(channel).some(m => Number(m.userId) === me)) throw new BadRequest('Stand in the room first')
    const cue = haven().setlist.request(row.id, song as number)
    // The answer is not a Room row for the bus to announce; the cue is told below.
    $.dispatch = false
    haven().channel(channel).send('song', cue)
    return { ...cue, name: songOf(cue.first).name }
  },
})
