// A line said in a room — the bubble over a figure, and the tavern's history.
//
// Broadcast to the room it was said in, graded per recipient by Message's read
// policy, so a banned member receives no line and nobody receives theirs. A
// whisper (`toId`) is private by that policy; a line said aloud is heard only
// by the figures within earshot of the speaker (`hearing.ts`, `FJS-D992`),
// which is fan-out alone — `find` still returns the room's history.
//
// `memberId` is a `@createdBy` stamp: a payload naming somebody else is
// overwritten with the caller.
import { createService } from '@frontierjs/junction'
import { rateLimitHook } from '@frontierjs/junction/hooks'
import type { App, Channel } from '@frontierjs/junction'

import { hears } from '../hearing.ts'
import type { Cell } from '../hearing.ts'
import { roomChannelName } from '../rooms.ts'

type Positions = { localPresence: (channel: string) => Array<{ connectionId: string, userId: string | number, meta: Record<string, unknown> }> }
type ChannelApp = App & { channel: (name: string) => Channel, channels: Positions }

export default createService({
  model:   'Message',
  methods: ['find', 'get', 'create'],
  channel: (row, ctx) => {
    // A write outside a service call carries no app to read presence from, and
    // a line without earshot would reach the whole room, so it is not announced.
    if (!ctx) return null
    const a = ctx.app as ChannelApp
    const line = row as { roomId: number, memberId: number, body: string, toId?: number | null }
    const name = roomChannelName(line.roomId)
    const room = a.channel(name)

    // A connection's cell is its presence meta; a speaker with two terminals
    // is heard from either.
    const roster  = a.channels.localPresence(name)
    const cells   = new Map<string, Cell>(roster.map(m => [m.connectionId, m.meta as Cell]))
    const speaker = roster.filter(m => String(m.userId) === String(line.memberId)).map(m => m.meta as Cell)
    return room.filter(conn =>
      String(conn.user?.userId) === String(line.memberId) || hears(line, speaker, cells.get(conn.id)))
  },
  hooks: {
    before: {
      // Per member, over either transport. A key minted in a loop is a new
      // member each time, which is the transport's per-IP limit to answer.
      create: [rateLimitHook({ max: 5, window: '10s', message: 'Slow down — five lines in ten seconds' })],
    },
  },
})
