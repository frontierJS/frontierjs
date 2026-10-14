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
//   say   `messages.create` — a Message row, broadcast to the room as
//         `messages created` and graded per recipient by the Message read policy.
//
// A room is entered at the upgrade: `/ws?room=<slug>`, and a door is a
// reconnect. A service call does not know which socket it arrived on, so a
// method cannot move its own connection between channels.

import type { App, Connection, channels } from '@frontierjs/junction'

import { bannedAtOf } from './principal.ts'

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
 * The only presence meta a room accepts. Anything else in the frame is dropped
 * rather than fanned out, so a client cannot hang a payload on its figure for
 * every other member to receive.
 */
export function position (meta: Record<string, unknown>): Position {
  const { x, y } = meta
  const cell = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CELL
  if (!cell(x) || !cell(y)) throw new Error(`A move is { x, y }, whole cells from 0 to ${MAX_CELL}`)
  return { x, y }
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
export function roomChannels (db: { asSystem: () => any }): { setup: (a: App) => void, options: ChannelsOptions } {
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
      presenceMeta:             position,
      // Arrow keys held down. Past it a move is dropped, and the next one lands.
      presenceUpdatesPerSecond: 10,
      presenceMetaBytes:        64,
      // The connection's principal was built at the upgrade, so a ban written
      // since would not reach it; every frame reads the column again.
      claims: async (_name, conn) => conn.user
        ? { bannedAt: await bannedAtOf(db, conn.user.userId) }
        : null,
    },
  }
}
