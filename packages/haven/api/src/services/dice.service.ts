// The dice at the tavern's tables (`IDEAS/haven.md` 9.1): `roll` throws and
// says the throw in the room, as the dice (`dice.ts`), never as the caller.
// The caller must be standing in the room, as a bolt's shooter must.
import { createService, $, BadRequest } from '@frontierjs/junction'
import { rateLimitHook } from '@frontierjs/junction/hooks'

import type { HavenApp } from '../app.ts'
import { MAX_DICE, MAX_SIDES, parseRoll } from '#shared/dice.ts'
import { roomChannelName } from '../rooms.ts'

type Roster = { localPresence: (channel: string) => Array<{ userId: string | number }> }

type DiceApp = HavenApp & { channels: Roster }

export default createService({
  model:   'Message',
  methods: ['roll'],
  hooks: {
    before: {
      // The dice share one member's line rate (five in ten seconds), so one
      // roller is held below it and cannot use up the others' turns alone.
      roll: [rateLimitHook({ max: 3, window: '10s', message: 'Slow down — the dice need a moment' })],
    },
  },

  /** `{ roomId, dice }` -- `dice` as `2d6`. Answers `{ body, dice, total }`; the line itself reaches the room as a Message. */
  async roll () {
    const me = Number(($.user as { id?: string } | undefined)?.id)
    if (!Number.isInteger(me)) throw new BadRequest('Walk in first: nobody is rolling')
    const { roomId, dice: spec } = ($.data ?? {}) as { roomId?: unknown, dice?: unknown }
    const roll = parseRoll(typeof spec === 'string' ? spec : '')
    if (!roll) throw new BadRequest(`Roll like 2d6 -- up to ${MAX_DICE} dice of 2 to ${MAX_SIDES} faces`)
    const db  = $.db as any
    const row = await db.room.findFirst({ where: { id: roomId }, select: { id: true } })
    if (!row) throw new BadRequest('No such room')
    if (!($.app as DiceApp).channels.localPresence(roomChannelName(row.id)).some(m => Number(m.userId) === me)) throw new BadRequest('Stand in the room first')
    const nick = (await db.member.findFirst({ where: { id: me }, select: { nick: true } }))?.nick
    if (!nick) throw new BadRequest('Walk in first: nobody is rolling')
    // The answer is not a Message row for the bus to announce; the dice's line is.
    $.dispatch = false
    return await ($.app as DiceApp).dice.roll(row.id, nick, roll)
  },
})
