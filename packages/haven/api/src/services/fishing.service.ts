// Fishing off the pier (`IDEAS/haven.md` § the fishing pier, `fishing.ts`):
// `cast` rolls what bites against the server's almanac and puts it in the
// caster's pack. The caster must stand in the room's presence at the water's
// edge -- presence is where they are, so the call names no cell -- and the
// answer is theirs alone: nothing is said in the room.
import { createService, rateLimitHook, $, BadRequest, TooManyRequests } from '@frontierjs/junction'

import type { HavenApp } from '../app.ts'
import { biteMs, castInto, castLine, landedLine, WATER } from '../fishing.ts'
import { isItem } from '../inventory.ts'
import { roomChannelName } from '../rooms.ts'
import { pieceAt, worldFor } from '../world.ts'
import { almanacAt } from '../../../web/src/sky.js'

type Roster = { localPresence: (channel: string) => Array<{ userId: string | number, meta: Record<string, unknown> }> }

export function createFishingService (app: HavenApp) {
  const a = app as HavenApp & { channels: Roster }
  return createService({
    model:   'Member',
    methods: ['cast'],
    hooks: {
      before: {
        // The cast's wait is the real bound (`CAST_MS`); this keeps a loop of refused calls cheap.
        cast: [rateLimitHook({ max: 10, window: '10s', message: 'Slow down' })],
      },
    },

    /** `{ roomId }` -- answers `{ caught, line, at, biteMs, held? }`: what came up, the caster's line, the water cell the float sits on and for how long. */
    async cast () {
      const me = Number(($.auth?.user as { userId?: string } | undefined)?.userId)
      if (!Number.isInteger(me)) throw new BadRequest('Walk in first: nobody is fishing')
      const { roomId } = ($.data ?? {}) as { roomId?: unknown }
      const row = await ($.db as any).room.findFirst({ where: { id: roomId }, select: { id: true, slug: true } })
      if (!row) throw new BadRequest('No such room')
      const mine = a.channels.localPresence(roomChannelName(row.id)).find(m => Number(m.userId) === me)
      if (!mine) throw new BadRequest('Stand in the room first')
      const world = worldFor(row.slug)
      const { x, y, facing } = mine.meta as { x?: number, y?: number, facing?: unknown }
      const at = world && x !== undefined && y !== undefined
        ? castInto((cx, cy) => WATER.has(pieceAt(world, cx, cy) ?? ''), x, y, facing)
        : null
      if (!at) throw new BadRequest('Stand at the water\'s edge to fish -- the pier at the docks')

      const wait = a.casts.cast(me)
      if (wait > 0) throw new TooManyRequests(`Your line is still out for ${Math.ceil(wait / 100) / 10}s`)

      const caught = castLine(almanacAt(Date.now()))
      const held   = isItem(caught) ? a.inventory.give(me, caught) : undefined
      // The answer is not a Member row for the bus to announce.
      $.dispatch = false
      return { caught, line: landedLine(caught, held), at, biteMs: biteMs(), ...(held !== undefined && { held }) }
    },
  })
}
