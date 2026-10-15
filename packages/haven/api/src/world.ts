// api/src/world.ts
// A scene as the server knows it (`IDEAS/haven.md` 12.2): the cells that can be
// walked, the doors, what stands on the rest. The client draws the art and the
// server never mounts it, so `bun run frames` writes `web/src/scenes/<slug>.
// world.json` (`web/src/world.js`) and this reads it, as `hearing.ts` is read
// by both sides. A bolt is resolved here rather than on the caller's screen,
// so there is one answer for every screen.

import { readFileSync } from 'node:fs'

import type { Obstacle } from './bolt.ts'
import { pacerAt } from './pacer.ts'
import type { PacerSpec } from './pacer.ts'

export interface SceneWorld {
  slug: string, width: number, height: number
  spawn: { x: number, y: number }
  /** `.` walkable, `+` a door, `#` anything else. */
  rows: string[]
  doors: { x: number, y: number, to: string, hidden?: true, night?: true }[]
  pieces: { id: string, name: string, fragile?: true, cells: [number, number][] }[]
  /** Floor pieces that hand an item when stepped on (`inventory.ts`). */
  pickups: { id: string, item: string, n: number, cells: [number, number][] }[]
  pacers: (PacerSpec & { name: string })[]
}

const DIR = new URL('../../web/src/scenes/', import.meta.url)

/** Read once and kept: a scene's file changes only with a deploy. */
type Loaded = { world: SceneWorld, solid: Map<string, SceneWorld['pieces'][number]>, pickup: Map<string, SceneWorld['pickups'][number]> }
const worlds = new Map<string, Loaded | null>()

function load (slug: string): Loaded | null {
  if (worlds.has(slug)) return worlds.get(slug)!
  let found: Loaded | null = null
  // A slug is a Room row's, so it is one a member can cause by sitting at a
  // table (`booth-3-7`); only a name made of letters reaches the filesystem.
  if (/^[a-z]+$/.test(slug)) {
    try {
      const world = JSON.parse(readFileSync(new URL(`${slug}.world.json`, DIR), 'utf8')) as SceneWorld
      const solid = new Map<string, SceneWorld['pieces'][number]>()
      for (const p of world.pieces) for (const [x, y] of p.cells) solid.set(`${x},${y}`, p)
      const pickup = new Map<string, SceneWorld['pickups'][number]>()
      for (const p of world.pickups) for (const [x, y] of p.cells) pickup.set(`${x},${y}`, p)
      found = { world, solid, pickup }
    } catch { /* a room with no scene (a booth) has no world */ }
  }
  worlds.set(slug, found)
  return found
}

/** The scene a Room row's slug names, or null for a room with none. */
export const worldFor = (slug: string): SceneWorld | null => load(slug)?.world ?? null

/** Whether a figure may stand on a cell: floor, and on the stage. */
export function walkable (world: SceneWorld, x: number, y: number): boolean {
  return world.rows[y]?.[x] === '.'
}

/** The pickup lying on a cell, or null. */
export const pickupAt = (world: SceneWorld, x: number, y: number): SceneWorld['pickups'][number] | null =>
  load(world.slug)?.pickup.get(`${x},${y}`) ?? null

/**
 * Whether a figure may stand on a cell: floor, or the cell of a piece that is
 * shattered (`gone`, the ids of the pieces the room remembers broken), which
 * the client walks through until it grows back. A door is a wall to a move:
 * stepping onto one leaves the room instead.
 */
export function standable (world: SceneWorld, x: number, y: number, gone: ReadonlySet<string>): boolean {
  if (walkable(world, x, y)) return true
  const piece = load(world.slug)?.solid.get(`${x},${y}`)
  return !!piece && gone.has(piece.id)
}

/**
 * What stands on a cell `ms` into the clock, or null for open floor. Off the
 * stage and a door are walls; a pacer is where the shared clock puts it.
 */
export function obstacleAt (world: SceneWorld, x: number, y: number, ms: number): Obstacle | null {
  for (const p of world.pacers) {
    const at = pacerAt(p, ms)
    if (at.y === y && x >= at.x && x < at.x + at.text.length) return { kind: 'pacer', id: p.name }
  }
  const ch = world.rows[y]?.[x]
  if (ch === '.') return null
  const piece = load(world.slug)?.solid.get(`${x},${y}`)
  if (piece) return { kind: piece.fragile ? 'piece' : 'wall', id: piece.id }
  return { kind: 'wall' }
}
