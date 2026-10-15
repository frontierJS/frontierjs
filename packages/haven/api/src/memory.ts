// api/src/memory.ts
// The room's memory (`FJS-D993`): what happened in a room lately, kept by the
// API in memory per room and sent on join, never a row. A restart loses it,
// which scenery can afford. Footprints (`IDEAS/haven.md` 7.4), a piece a bolt
// shattered and the scorch it left (9.5), a pickup lifted (9.9), and chalk (9.8) are all one thing
// here — a trace on a cell that lasts a while — so there is one store and one
// rule for how long each kind lasts and how many of it a room or a member holds.
//
// A trace's `at` and `until` are the server's clock. A client fades it by its
// own clock against them, so two screens a few hundred ms apart fade it a few
// hundred ms apart, which nobody can see.

import type { Position } from './rooms.ts'

/** How long each kind lasts, how many a room keeps, and how many one member may hold. */
export const TRACES = {
  step:   { ms: 1 * 60_000,  room: 500 },
  struck: { ms: 5 * 60_000,  room: 50 },
  scorch: { ms: 2 * 60_000,  room: 100 },
  spooked: { ms: 5 * 60_000, room: 20 },
  taken:  { ms: 2 * 60_000,  room: 50 },
  chalk:  { ms: 10 * 60_000, room: 400, each: 20 },
} as const satisfies Record<string, { ms: number, room: number, each?: number }>

export type TraceKind = keyof typeof TRACES

/** A trace as it is laid: where, what, and who laid it — `by` is a Member id; `id` names the piece a `struck` or `taken` one took, or the pacer a `spooked` one scared, which runs `dir` away from the bolt. */
export type Laid = Position & { kind: TraceKind, by?: number, ch?: string, id?: string, dir?: 1 | -1 }

export type Trace = Laid & { at: number, until: number }

/**
 * Whether going from `was` to `now` lays a step: one cell over, up or down. A
 * join, a door's arrival and a booth's stand are not, so they leave no
 * footprint (`IDEAS/haven.md` 7.4). The server lays by it and a client asks it
 * of the moves presence shows, so the two agree on which cells were walked.
 */
export function stepped (was: Partial<Position> | undefined, now: Position): boolean {
  if (!Number.isInteger(was?.x) || !Number.isInteger(was?.y)) return false
  return Math.abs(now.x - was!.x!) + Math.abs(now.y - was!.y!) === 1
}

/** How much of a trace is left at `now`: 1 as it is laid, 0 once it is gone. */
export function fadeOf (t: Pick<Trace, 'at' | 'until'>, now: number): number {
  if (now >= t.until) return 0
  if (now <= t.at) return 1
  return (t.until - now) / (t.until - t.at)
}

export interface RoomMemory {
  /** Lay a trace, dropping the oldest of its kind past the room's cap, or past the member's. */
  add (room: string | number, laid: Laid): Trace
  /** Every trace still lasting in a room, oldest first — what a joiner is sent. */
  live (room: string | number, kind?: TraceKind): Trace[]
  /** Take out the traces `pred` names in one room; returns what it took. */
  wipe (room: string | number, pred: (t: Trace) => boolean): Trace[]
  /** Take out what one member laid, in every room — what a ban does to their chalk. */
  forget (by: number, kinds?: TraceKind[]): number
}

export function createRoomMemory ({ now = Date.now }: { now?: () => number } = {}): RoomMemory {
  const rooms = new Map<string, Trace[]>()

  const lasting = (room: string | number): Trace[] => {
    const key = String(room)
    const t = now()
    const kept = (rooms.get(key) ?? []).filter(x => x.until > t)
    rooms.set(key, kept)
    return kept
  }

  const dropOldest = (list: Trace[], pred: (t: Trace) => boolean, cap: number) => {
    let over = list.filter(pred).length - cap
    for (let i = 0; over > 0 && i < list.length;) {
      if (pred(list[i])) { list.splice(i, 1); over-- } else i++
    }
  }

  return {
    add (room, laid) {
      const rule: { ms: number, room: number, each?: number } = TRACES[laid.kind]
      if (!rule) throw new Error(`No trace is a ${laid.kind}; the kinds are ${Object.keys(TRACES).join(', ')}`)
      const list = lasting(room)
      const at = now()
      const trace: Trace = { ...laid, at, until: at + rule.ms }
      list.push(trace)
      dropOldest(list, x => x.kind === laid.kind, rule.room)
      if (rule.each != null && laid.by != null) dropOldest(list, x => x.kind === laid.kind && x.by === laid.by, rule.each)
      return trace
    },

    live (room, kind) {
      const list = lasting(room)
      return kind ? list.filter(t => t.kind === kind) : [...list]
    },

    wipe (room, pred) {
      const list = lasting(room)
      const taken = list.filter(pred)
      rooms.set(String(room), list.filter(t => !taken.includes(t)))
      return taken
    },

    forget (by, kinds) {
      let n = 0
      for (const [key, list] of rooms) {
        const kept = list.filter(t => !(t.by === by && (!kinds || kinds.includes(t.kind))))
        n += list.length - kept.length
        rooms.set(key, kept)
      }
      return n
    },
  }
}
