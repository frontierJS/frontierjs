// api/src/play.ts
// The one function that turns "this member fired" into an answer every screen
// draws (`IDEAS/haven.md` 9.5). The room's memory and the bolt cooldowns it
// reads are the app's (`app.memory`, `app.cooldowns` — `app.ts`), claimed there
// so two apps in one process, a test's, never share a cooldown.

import { crosses, fly, volley } from './bolt.ts'
import type { Figure, Flight, Hit, World } from './bolt.ts'
import type { Facing } from './facing.ts'
import type { RoomMemory, Trace } from './memory.ts'
import { obstacleAt } from './world.ts'
import type { SceneWorld } from './world.ts'

/** What every screen is told: the flights to animate, who is knocked where, and what the room now remembers. */
export interface Blast {
  by: number
  from: { x: number, y: number }
  flights: Flight[]
  /** Members hit, once each, and where each lands. */
  struck: { id: number, to: { x: number, y: number } }[]
  /** Traces this bolt laid: a piece shattered, a wall scorched. */
  laid: Trace[]
  /** Chalk the bolt crossed and wiped. */
  wiped: Trace[]
  /** The cat, or whatever paces, was hit. */
  yowl: boolean
}

/**
 * Resolve one bolt, or a volley, from `shooter` in a room. A piece already
 * shattered is gone and no longer stops anything; the rest of the room is the
 * world as it stands at `ms`.
 */
export function shoot (
  { memory, room, world, ms, members, shooter, facing, all }:
  { memory: RoomMemory, room: string | number, world: SceneWorld, ms: number, members: Figure[], shooter: Figure, facing: Facing, all: boolean },
): Blast {
  const gone = new Set(memory.live(room, 'struck').map(t => t.id))
  const where: World = {
    members,
    at (x, y) {
      const o = obstacleAt(world, x, y, ms)
      return o && o.id && gone.has(o.id) ? null : o
    },
  }
  const flights = all ? volley(where, shooter) : [fly(where, shooter, facing)]

  const struck = new Map<number, { x: number, y: number }>()
  const laid: Trace[] = []
  let yowl = false
  const stop = (h: Hit) => {
    if (h.kind === 'member') { if (!struck.has(h.id)) struck.set(h.id, h.to) }
    else if (h.kind === 'pacer') yowl = true
    else if (h.kind === 'piece') {
      if (h.id && !gone.has(h.id)) { gone.add(h.id); laid.push(memory.add(room, { kind: 'struck', x: h.at.x, y: h.at.y, id: h.id, by: shooter.id })) }
    } else laid.push(memory.add(room, { kind: 'scorch', x: h.at.x, y: h.at.y, by: shooter.id }))
  }
  for (const f of flights) if (f.hit) stop(f.hit)

  const wiped = memory.wipe(room, t => t.kind === 'chalk' && crosses(flights, t))
  return {
    by: shooter.id, from: { x: shooter.x, y: shooter.y }, flights,
    struck: [...struck].map(([id, to]) => ({ id, to })), laid, wiped, yowl,
  }
}
