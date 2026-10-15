// api/src/rooms.ts
// A room is a Junction channel bound to one Room row, and the frames a figure
// sends in it. The client (`web/`) imports these shapes, so the server
// and the client version together in this package (`IDEAS/haven.md`).
//
// Two frames, and neither is new to Junction:
//
//   move  a presence update — `{ type: 'subscribe', channel, meta: { x, y } }`.
//         Presence is the owner of who stands in a room, and a joiner's
//         `presence:sync` then carries every figure where it stands. Never a row.
//         `typing: true` rides the same frame while a member's line has words.
//   say   `messages.create` — a Message row, broadcast to the room as
//         `messages created` and graded per recipient by the Message read policy.
//
// A room is entered at the upgrade: `/ws?room=<slug>`, and a door is a
// reconnect. A service call does not know which socket it arrived on, so a
// method cannot move its own connection between channels.

import type { App, Connection, channels } from '@frontierjs/junction'

import { stepped } from './memory.ts'
import type { RoomMemory } from './memory.ts'
import { isFacing } from './facing.ts'
import type { Facing } from './facing.ts'
import { standingOf } from './principal.ts'
import { glyphOf, inkOf } from './shape.ts'
import { standable, worldFor } from './world.ts'

type ChannelsOptions = NonNullable<Parameters<typeof channels>[1]>

/** The one spelling of a room's channel. `channels({ rooms })` binds it to the row. */
export const roomChannelName = (roomId: number | string): string => `room:${roomId}`

/** Where a figure walks in without naming a room. */
export const FIRST_ROOM = 'square'

/** A row for each scene the client draws. Without one a fresh database walks
 *  every visitor in to "This server has no square". */
export const ROOMS = [
  { slug: 'square', name: 'The square' },
  { slug: 'tavern', name: 'The tavern' },
  { slug: 'road',   name: 'The road' },
  { slug: 'woods',  name: 'The woods' },
  { slug: 'docks',  name: 'The docks' },
  { slug: 'workshop', name: 'The workshop' },
  { slug: 'cellar', name: 'The cellar' },
  { slug: 'glade',  name: 'The glade' },
  { slug: 'lane',   name: 'The lane' },
  { slug: 'jordan', name: "Jordan's home" },
  { slug: 'vlad',   name: "Vlad's home" },
  { slug: 'colin',  name: "Colin's home" },
] as const

/** Creates whichever of ROOMS the database lacks. Run by the entry point and not
 *  by `buildHavenApp`, because a test makes its own rooms. */
export async function ensureRooms (db: { asSystem: () => any }): Promise<void> {
  const sys = db.asSystem()
  for (const room of ROOMS) {
    const found = await sys.room.findFirst({ where: { slug: room.slug }, select: { id: true } })
    if (!found) await sys.room.create({ data: { ...room } })
  }
}

/** A cell on a scene. The art is the client's, so the server bounds the
 *  coordinates and nothing finer. */
export type Position = { x: number, y: number }

const MAX_CELL = 255

/**
 * A figure as the room sees it: where it stands, `typing` while its line has
 * words in it — the booth's flame leans toward it — the way it `facing` (9.4),
 * the `shape` it is drawn as while it is shapeshifted (9.7), and the `ink` a
 * flower dyed it.
 */
export type RoomMeta = Position & { typing?: true, facing?: Facing, shape?: string, ink?: string }

/**
 * The only presence meta a room accepts. Anything else in the frame is dropped
 * rather than fanned out, so a client cannot hang a payload on its figure for
 * every other member to receive; `typing` is carried only as `true`.
 */
export function roomMeta (meta: Record<string, unknown>): RoomMeta {
  const { x, y } = meta
  const cell = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CELL
  if (!cell(x) || !cell(y)) throw new Error(`A move is { x, y }, whole cells from 0 to ${MAX_CELL}`)
  // A key that is not well formed is dropped and the move still lands: a
  // client that fumbles its facing should not stop walking.
  const facing = isFacing(meta.facing) ? meta.facing : null
  const shape  = glyphOf(meta.shape)
  const ink    = inkOf(meta.ink)
  return { x, y, ...(meta.typing === true && { typing: true as const }), ...(facing && { facing }), ...(shape && { shape }), ...(ink && { ink }) }
}

type RoomApp = App & {
  channel: (name: string) => { join: (conn: Connection) => unknown }
}

/** The room a connection asked for at the upgrade, or the square. */
function slugOf (conn: Connection): string {
  const asked = (conn.data.query as Record<string, unknown> | undefined)?.room
  return typeof asked === 'string' && asked ? asked.toLowerCase() : FIRST_ROOM
}

/**
 * The `channels()` options for Haven. The join is graded by Room's read
 * policy and asked again after every committed write, which is what takes a
 * banned member out of the room they are standing in.
 */
export function roomChannels (db: { asSystem: () => any }, memory: RoomMemory): { setup: (a: App) => void, options: ChannelsOptions } {
  const sys = () => db.asSystem()
  return {
    setup: (a) => {
      const ra = a as RoomApp & { channels: { on: (ev: 'connection', fn: (s: unknown, c: Connection) => unknown) => void } }
      ra.channels.on('connection', async (_session, conn) => {
        if (!conn.user) return
        const room = await sys().room.findFirst({ where: { slug: slugOf(conn) }, select: { id: true } })
        if (room) await ra.channel(roomChannelName(room.id)).join(conn)
      })
    },
    options: {
      rooms:                    { 'room:{id}': 'Room' },
      presence:                 ['room:*'],
      // A step is laid on the cell stepped onto, in the room's memory, keyed
      // by the channel's name; `rooms.traces` reads it back for a joiner.
      presenceMeta: (raw, { channel, conn, was }) => {
        const meta = roomMeta(raw)
        // The scene is the server's too (12.2): a figure is on floor or on a
        // piece the room remembers broken. A room with no scene, a booth, has
        // no walls to keep. How far a move may jump is left to the rate, since
        // a door's arrival and a bolt's knock-back are both jumps.
        const world = worldFor(slugOf(conn))
        if (world && !standable(world, meta.x, meta.y, new Set(memory.live(channel, 'struck').map(t => t.id)))) {
          throw new Error(`Cell ${meta.x},${meta.y} of ${world.slug} is not floor`)
        }
        if (stepped(was, meta)) memory.add(channel, { kind: 'step', x: meta.x, y: meta.y, by: Number(conn.user?.userId) || undefined })
        return meta
      },
      // Arrow keys held down. Past it a move is dropped, and the next one lands.
      presenceUpdatesPerSecond: 10,
      presenceMetaBytes:        80,
      // The connection's principal was built at the upgrade, so a ban written
      // since would not reach it; every frame reads the column again.
      claims: async (_name, conn) => conn.user ? await standingOf(db, conn.user.userId) : null,
    },
  }
}
