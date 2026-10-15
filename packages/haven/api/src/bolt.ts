// api/src/bolt.ts
// `d` deletes: a bolt (`IDEAS/haven.md` 9.5). The client draws it; the server
// says what it hit, so there is one answer for every screen. A member is
// knocked back and never removed — Haven has strangers on it, and a bolt that
// deletes a person is a griefing tool. `dd` is a volley, all four ways at once,
// on a longer cooldown. The cooldown is the server's: a client that fires
// faster is refused, not slowed.
//
// What stands on a cell is the caller's to say, through `at`. Members come
// from presence; the art is the scene's, which the client holds, so the server
// passes an `at` built from whatever it knows of the scene.

import { FACINGS, STEP, type Facing } from './facing.ts'
import type { Position } from './rooms.ts'

/** A bolt flies until it hits; every scene is walled, so this only bounds a world that is not. */
export const RANGE = 256

/** How far a struck member is pushed, the way the bolt flew. */
export const KNOCK = 2

/** How long a struck member flickers. */
export const STUN_MS = 1_000

/** The wait after a bolt, and after a volley. */
export const BOLT_MS = 3_000
export const VOLLEY_MS = 9_000

/** What stops a bolt that is not a member: `id` names the piece or pacer, for the screens that draw it. */
export type Obstacle = { kind: 'wall' | 'piece' | 'pacer', id?: string }

export type Figure = Position & { id: number }

export type Hit =
  | { kind: 'member', id: number, at: Position, to: Position }
  | (Obstacle & { at: Position })

/** One bolt's flight: the cells it crossed, in order, and what stopped it — null when it flew its range. */
export type Flight = { facing: Facing, path: Position[], hit: Hit | null }

export interface World {
  /** What stands on a cell — off the scene included, as a wall — or null for open floor. */
  at (x: number, y: number): Obstacle | null
  /** The figures in the room, the shooter's own among them. */
  members: Figure[]
}

const memberAt = (world: World, x: number, y: number, except: number) =>
  world.members.find(m => m.id !== except && m.x === x && m.y === y)

/**
 * Where a struck member ends up: up to KNOCK cells the way the bolt flew,
 * stopping before anything that would stop a walk — an obstacle or another
 * figure — so a knock-back never puts two figures on a cell or one in a wall.
 */
export function knockBack (world: World, struck: Figure, facing: Facing): Position {
  const { dx, dy } = STEP[facing]
  let to: Position = { x: struck.x, y: struck.y }
  for (let i = 1; i <= KNOCK; i++) {
    const x = struck.x + dx * i, y = struck.y + dy * i
    if (world.at(x, y) || memberAt(world, x, y, struck.id)) break
    to = { x, y }
  }
  return to
}

/** A bolt from `shooter` the way it faces. The first member or obstacle on its line stops it. */
export function fly (world: World, shooter: Figure, facing: Facing): Flight {
  const { dx, dy } = STEP[facing]
  const path: Position[] = []
  for (let i = 1; i <= RANGE; i++) {
    const x = shooter.x + dx * i, y = shooter.y + dy * i
    const struck = memberAt(world, x, y, shooter.id)
    if (struck) {
      path.push({ x, y })
      return { facing, path, hit: { kind: 'member', id: struck.id, at: { x, y }, to: knockBack(world, struck, facing) } }
    }
    const thing = world.at(x, y)
    if (thing) return { facing, path, hit: { ...thing, at: { x, y } } }
    path.push({ x, y })
  }
  return { facing, path, hit: null }
}

/** `dd`: a bolt each way. Each is resolved against the room as it stood before any of them landed. */
export const volley = (world: World, shooter: Figure): Flight[] => FACINGS.map(f => fly(world, shooter, f))

/** Whether a cell lies on any of the flights — a bolt wipes the chalk it crosses. */
export const crosses = (flights: Flight[], c: Position): boolean =>
  flights.some(f => f.path.some(p => p.x === c.x && p.y === c.y))

/**
 * The per-member cooldown. `fire` answers 0 and starts the wait when the
 * member may fire, else the ms still to wait and changes nothing.
 */
export function createCooldowns ({ now = Date.now }: { now?: () => number } = {}) {
  const ready = new Map<number, number>()
  return {
    fire (memberId: number, isVolley = false): number {
      const t = now()
      const wait = (ready.get(memberId) ?? 0) - t
      if (wait > 0) return wait
      ready.set(memberId, t + (isVolley ? VOLLEY_MS : BOLT_MS))
      return 0
    },
  }
}
