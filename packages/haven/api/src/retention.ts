// api/src/retention.ts
// Message retention: a room keeps its newest KEEP lines and the sweep removes
// the rest. A COUNT per room rather than a window of days (`FJS-D748`): the
// tavern's chatter rolls over however busy the night was, and a quiet room —
// the notice board 7.5 means to be one — keeps what was pinned for as long as
// nothing newer pushes it off. Litestone's own `retention` is a database-wide
// window by `createdAt` and would sweep members and rooms with the lines, so
// `main` declares none and this is the sweep the schema's "removed only by
// retention" names.
//
// `asSystem()` for the reason `$retain()` gives: `Message.delete` is `8`, and
// a sweep reads no row policy, so the bypass is said at the call site. It runs
// through the client and not raw SQL, so every removed line reaches the trail.
//
// The edge is the KEEP-th newest line, ordered by `createdAt` then `id`, and
// what is removed is everything older than it in that same order — so ties on
// one millisecond, which a burst of lines makes, leave exactly KEEP behind.
// Served by `@@index([roomId, createdAt])`.

export const KEEP = 500

export interface Swept { roomId: number, removed: number }

export async function sweepRooms (db: { asSystem: () => any }, { keep = KEEP } = {}): Promise<Swept[]> {
  const sys = db.asSystem()
  const out: Swept[] = []
  for (const room of await sys.room.findMany({ select: { id: true } })) {
    const [edge] = await sys.message.findMany({
      where:   { roomId: room.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      offset:  keep - 1,
      limit:   1,
    })
    if (!edge) continue
    const { count } = await sys.message.deleteMany({
      where: {
        roomId: room.id,
        OR: [
          { createdAt: { lt: edge.createdAt } },
          { createdAt: edge.createdAt, id: { lt: edge.id } },
        ],
      },
    })
    if (count) out.push({ roomId: room.id, removed: count })
  }
  return out
}
