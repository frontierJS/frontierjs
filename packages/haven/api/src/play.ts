// api/src/play.ts
// The one function that turns "this member fired" into an answer every screen
// draws (`IDEAS/haven.md` 9.5). The room's memory and the bolt cooldowns it
// reads are the app's (`app.memory`, `app.cooldowns` — `app.ts`), claimed there
// so two apps in one process, a test's, never share a cooldown.

import { FLY_MS, crosses, fly, volley } from './bolt.ts'
import type { Figure, Flight, Hit, World } from './bolt.ts'
import type { Facing } from './facing.ts'
import type { RoomMemory, Trace } from './memory.ts'
import type { Position } from './rooms.ts'
import { obstacleAt, riderOf } from './world.ts'
import type { SceneWorld } from './world.ts'

/** What every screen is told: the flights to animate, who is knocked where, and what the room now remembers. */
export interface Blast {
  by: number
  from: { x: number, y: number }
  flights: Flight[]
  /** Members hit, once each, and where each lands. */
  struck: { id: number, to: { x: number, y: number } }[]
  /** Traces this bolt laid: a piece shattered, a wall scorched, a target scored. */
  laid: Trace[]
  /** Chalk the bolt crossed and wiped. */
  wiped: Trace[]
  /** The name of the pacer hit, the cat or whatever else paces, or null. */
  yowl: string | null
}

/** A target's rings, the bull first. */
export const RINGS = [10, 5, 1] as const

/**
 * What a bolt that struck a target at `at` scores: how far from the target's
 * middle it struck, across the way it flew. Flying east or west it meets the
 * target's edge whatever row it is on, so the row is what is scored; flying
 * north or south, the column. `cells` are the target's where the bolt met it (`riderOf`).
 */
export function pointsFor (cells: [number, number][], at: Position, facing: Facing): number {
  const across = facing === 'e' || facing === 'w' ? cells.map(c => c[1]) : cells.map(c => c[0])
  const lo = Math.min(...across), hi = Math.max(...across)
  const off = Math.abs((facing === 'e' || facing === 'w' ? at.y : at.x) - (lo + hi) / 2)
  const ring = Math.floor(off * RINGS.length / ((hi - lo) / 2 + 1))
  return RINGS[Math.min(RINGS.length - 1, ring)]
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
  const scared = new Map(memory.live(room, 'spooked').flatMap(t => t.id ? [[t.id, { at: t.at, dir: t.dir }] as const] : []))
  const where: World = {
    members,
    at (x, y, i = 0) {
      const o = obstacleAt(world, x, y, ms + i * FLY_MS, scared)
      return o && o.id && gone.has(o.id) ? null : o
    },
  }
  const flights = all ? volley(where, shooter) : [fly(where, shooter, facing)]

  const struck = new Map<number, { x: number, y: number }>()
  const laid: Trace[] = []
  let yowl: string | null = null
  const stop = (h: Hit, { facing, path }: Flight) => {
    if (h.kind === 'member') { if (!struck.has(h.id)) struck.set(h.id, h.to) }
    else if (h.kind === 'pacer') {
      yowl = h.id ?? null
      if (h.id && !scared.has(h.id) && world.pacers.some(p => p.name === h.id && p.flee)) {
        // Away from the shooter along the pacer's row; shot from straight above or below, it keeps its way.
        const dir = h.at.x === shooter.x ? undefined : h.at.x > shooter.x ? 1 : -1
        const t = memory.add(room, { kind: 'spooked', x: h.at.x, y: h.at.y, id: h.id, by: shooter.id, ...(dir && { dir }) })
        scared.set(h.id, { at: t.at, dir })
        laid.push(t)
      }
    }
    else if (h.kind === 'target') {
      // Met the cell after the last it crossed, which is when `at` was asked.
      const target = h.id ? riderOf(world, h.id, ms + (path.length + 1) * FLY_MS) : null
      if (target) laid.push(memory.add(room, { kind: 'scored', x: h.at.x, y: h.at.y, id: target.id, by: shooter.id, points: pointsFor(target.cells, h.at, facing) }))
    }
    else if (h.kind === 'piece') {
      if (h.id && !gone.has(h.id)) { gone.add(h.id); laid.push(memory.add(room, { kind: 'struck', x: h.at.x, y: h.at.y, id: h.id, by: shooter.id })) }
    } else laid.push(memory.add(room, { kind: 'scorch', x: h.at.x, y: h.at.y, by: shooter.id }))
  }
  for (const f of flights) if (f.hit) stop(f.hit, f)

  const wiped = memory.wipe(room, t => t.kind === 'chalk' && crosses(flights, t))
  return {
    by: shooter.id, from: { x: shooter.x, y: shooter.y }, flights,
    struck: [...struck].map(([id, to]) => ({ id, to })), laid, wiped, yowl,
  }
}
