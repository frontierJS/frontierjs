// The town hall's votes (`IDEAS/haven.md` Phase 15). A member says aye or nay
// to the delegate beside them; the hall is told an idea's count moved, and
// each screen asks `tally` again through its own client, so the Vote read
// policy -- a banned member's votes count for nobody -- is the only rule for
// what a count includes.
//
// No CRUD verb is a method: `cast` is the one write, an upsert keyed on the
// member and the idea that also refuses an idea the hall does not hold.
import { createService, $, BadRequest, rateLimitHook } from '@frontierjs/junction'
import type { App, Channel } from '@frontierjs/junction'

import { roomChannelName } from '../rooms.ts'
import { HALL, hallIdeas, tallyOf } from '../townhall.ts'

type HallApp = App & { channel: (name: string) => Channel }

export default createService({
  model:   'Vote',
  methods: ['tally', 'cast'],
  hooks: {
    before: {
      cast: [rateLimitHook({ max: 10, window: '10s', message: 'Slow down — ten votes in ten seconds' })],
    },
  },

  /** `{ ideas: { [id]: { aye, nay } }, mine: { [id]: aye } }` — every count the caller may read, and the caller's own votes. */
  async tally () {
    const me   = Number(($.auth?.user as { userId?: string } | undefined)?.userId)
    const rows = await ($.db as any).vote.findMany({ select: { idea: true, aye: true, memberId: true } }) as Array<{ idea: string, aye: boolean, memberId: number }>
    $.dispatch = false
    return {
      ideas: tallyOf(rows),
      mine:  Object.fromEntries(rows.filter(r => r.memberId === me).map(r => [r.idea, r.aye])),
    }
  },

  /** `{ idea, aye }` — `aye` true or false casts or changes the caller's vote, `null` withdraws it. Answers the caller's vote now. */
  async cast () {
    const me = Number(($.auth?.user as { userId?: string } | undefined)?.userId)
    if (!Number.isInteger(me)) throw new BadRequest('Walk in first: nobody is voting')
    const { idea, aye } = ($.data ?? {}) as { idea?: unknown, aye?: unknown }
    if (typeof idea !== 'string' || !hallIdeas().has(idea)) throw new BadRequest(`Nobody in the hall stands for ${String(idea)}`)
    if (aye !== true && aye !== false && aye !== null) throw new BadRequest('A vote is aye (true), nay (false) or withdrawn (null)')

    const db  = $.db as any
    const was = await db.vote.findFirst({ where: { idea, memberId: me }, select: { id: true } })
    if (aye === null) { if (was) await db.vote.delete({ where: { id: was.id } }) }
    else if (was) await db.vote.update({ where: { id: was.id }, data: { aye } })
    else await db.vote.create({ data: { idea, aye } })

    // The hall is told by name below; the answer is no Vote row for the bus to announce.
    $.dispatch = false
    const hall = await db.room.findFirst({ where: { slug: HALL }, select: { id: true } })
    if (hall) ($.app as HallApp).channel(roomChannelName(hall.id)).send('tallied', { idea })
    return { idea, aye }
  },
})
