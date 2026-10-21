// The scenes — square, tavern — laid out by the system, the booths two members
// make by sitting across a table (`api/src/booth.ts`), and the bolt a member
// fires (`api/src/bolt.ts`). A member reads the rooms and asks for a booth; the
// Room read policy decides which they see.
// `traces` is the room's memory (`IDEAS/haven.md` 7.4, 9.5): footprints, the
// pieces a bolt broke and the walls it scorched, which a joiner reads once and
// then lays the rest of from the moves presence shows it and the `bolt` events.
import { createService, $, BadRequest, NotFound, TooManyRequests } from '@frontierjs/junction'
import { rateLimitHook } from '@frontierjs/junction/hooks'
import type { Channel } from '@frontierjs/junction'

import type { HavenApp } from '../app.ts'
import { boothFor } from '../booth.ts'
import { FIRST_FACING, isFacing } from '../facing.ts'
import { ARROWS } from '../inventory.ts'
import { shoot } from '../play.ts'
import { roomChannelName } from '../rooms.ts'
import { spanOf } from '../shape.ts'
import { worldFor } from '../world.ts'

type Roster = { localPresence: (channel: string) => Array<{ userId: string | number, meta: Record<string, unknown> }> }
type PlayApp = HavenApp & { channel: (name: string) => Channel, channels: Roster }

const haven = () => $.app as PlayApp

export default createService({
  model:   'Room',
  // `booth` makes a row, which no member may (`Room` is `@@gate(3.8)`):
  // the method does it as the system, once it has checked who is asking.
  methods: ['find', 'get', 'booth', 'traces', 'bolt'],
  hooks: {
    before: {
      booth: [rateLimitHook({ max: 5, window: '10s', message: 'Slow down — five booths in ten seconds' })],
      // The cooldown is the real bound (`bolt.ts`); this keeps a loop of refused calls cheap.
      bolt:  [rateLimitHook({ max: 10, window: '10s', message: 'Slow down' })],
    },
  },

  /** `{ withId }` — the member across the table. Answers the booth's Room row. */
  async booth () {
    const me = Number(($.user as { id?: string } | undefined)?.id)
    if (!Number.isInteger(me)) throw new BadRequest('Sit down first: nobody walked in')
    return boothFor($.db as any, me, ($.data as { withId?: unknown } | undefined)?.withId)
  },

  /**
   * Every trace still lasting in room `id` -- footprints, a piece a bolt
   * broke, a scorch, a target scored -- `{ kind, x, y, at, until }` on the
   * server's clock, oldest first, with `id` on a broken piece and a target,
   * and `ch` on chalk. Who laid it only for a score, which is the
   * scoreboard's row. Read through the caller's client, so a booth's are its pair's alone.
   */
  async traces () {
    const room = await ($.db as any).room.findFirst({ where: { id: Number($.id) }, select: { id: true } })
    if (!room) throw new NotFound('No such room')
    return haven().memory.live(roomChannelName(room.id))
      .map(({ kind, x, y, id, ch, by, points, at, until }) => ({ kind, x, y, ...(id && { id }), ...(ch && { ch }), ...(kind === 'scored' && { by, points }), at, until }))
  },

  /**
   * `{ roomId, facing?, volley? }` — `d`, `d` and a way, or `dd`. The caller
   * must be standing in the room (presence is where they are, so a call
   * names no cell), and a banned member reads no room row. What the bolt hit
   * is the server's world, not the caller's: the answer is sent to the whole
   * room as a `bolt` event and returned to the caller.
   */
  async bolt () {
    const me = Number(($.user as { id?: string } | undefined)?.id)
    if (!Number.isInteger(me)) throw new BadRequest('Stand in a room first: nobody walked in')
    const { roomId, facing: asked, volley } = ($.data ?? {}) as { roomId?: unknown, facing?: unknown, volley?: unknown }
    const row = await ($.db as any).room.findFirst({ where: { id: roomId }, select: { id: true, slug: true } })
    if (!row) throw new BadRequest('No such room')
    const name   = roomChannelName(row.id)
    const roster = haven().channels.localPresence(name).map(m => ({ id: Number(m.userId), meta: m.meta as { x?: number, y?: number, facing?: unknown, shape?: string } }))
    const mine   = roster.find(m => m.id === me)
    if (!mine) throw new BadRequest('Stand in the room first')
    const world = worldFor(row.slug)
    if (!world) throw new BadRequest('There is nothing to shoot at here')

    // An empty quiver is refused before the cooldown starts, so it costs no wait.
    const cost = volley === true ? ARROWS.volley : ARROWS.bolt
    if (haven().inventory.count(me, 'arrow') < cost) throw new BadRequest(`You need ${cost} arrow${cost > 1 ? 's' : ''}: you have ${haven().inventory.count(me, 'arrow')}`)
    const wait = haven().cooldowns.fire(me, volley === true)
    if (wait > 0) throw new TooManyRequests(`The bolt is not ready for ${Math.ceil(wait / 100) / 10}s`)
    haven().inventory.take(me, 'arrow', cost)

    const figures = roster.filter(m => m.meta.x !== undefined && m.meta.y !== undefined).map(m => ({ id: m.id, x: m.meta.x!, y: m.meta.y!, span: spanOf(m.meta.shape) }))
    const shooter = figures.find(f => f.id === me)!
    const facing  = isFacing(asked) ? asked : isFacing(mine.meta.facing) ? mine.meta.facing : FIRST_FACING
    const blast   = shoot({ memory: haven().memory, room: name, world, ms: Date.now(), members: figures, shooter, facing, all: volley === true })
    // The room is told below, by name; the answer is not a Room row for the bus to announce.
    $.dispatch = false
    haven().channel(name).send('bolt', blast)
    return { ...blast, arrows: haven().inventory.count(me, 'arrow') }
  },
})
