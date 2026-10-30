// api/test/world.test.ts
// The scene the server reads (`web/src/components/scenes/<slug>.world.json`): what can be
// walked, what a bolt hits. The files are pinned against the stages by
// `web/test/scenes.test.js`; this is the reader.

import { test, expect } from 'bun:test'

import { pacerAt } from '#shared/pacer.ts'
import { obstacleAt, pickupAt, standable, walkable, worldFor } from '../src/world.ts'

test('a scene is read by its slug, and a room with no scene has none', () => {
  expect(worldFor('tavern')?.slug).toBe('tavern')
  expect(worldFor('booth-3-7')).toBeNull()
})

test('a slug that is a path reads no file', () => {
  expect(worldFor('../../../package')).toBeNull()
  expect(worldFor('Tavern')).toBeNull()
})

test('walkable is floor on the stage, and a door, a wall and off the stage are not', () => {
  const w = worldFor('tavern')!
  expect(walkable(w, w.spawn.x, w.spawn.y)).toBe(true)
  expect(walkable(w, -1, 0)).toBe(false)
  expect(walkable(w, w.width, 0)).toBe(false)
  expect(walkable(w, 1, 0)).toBe(false)
  const door = worldFor('square')!.doors[0]
  expect(walkable(worldFor('square')!, door.x, door.y)).toBe(false)
})

test('what stands on a cell: open floor nothing, a wall and the edge a wall, a fragile piece a piece', () => {
  const w = worldFor('woods')!
  expect(obstacleAt(w, w.spawn.x, w.spawn.y, 0)).toBeNull()
  expect(obstacleAt(w, -1, 0, 0)).toEqual({ kind: 'wall' })
  const fragile = w.pieces.find(p => p.fragile)!
  const [x, y] = fragile.cells[0]
  expect(obstacleAt(w, x, y, 0)).toEqual({ kind: 'piece', id: fragile.id })
  const solid = w.pieces.find(p => !p.fragile)!
  const [sx, sy] = solid.cells[0]
  expect(obstacleAt(w, sx, sy, 0)).toEqual({ kind: 'wall', id: solid.id })
})

test('the cat is where the shared clock puts it, and the same cell on every ask', () => {
  const w = worldFor('tavern')!
  const cat = w.pacers[0]
  for (const ms of [0, 12_345, 99_999]) {
    const at = pacerAt(cat, ms)
    expect(obstacleAt(w, at.x, at.y, ms)).toEqual({ kind: 'pacer', id: cat.name })
  }
})

test('a figure stands on floor, and on a piece only once it is broken; a wall and a door never', () => {
  const w = worldFor('woods')!
  const none = new Set<string>()
  expect(standable(w, w.spawn.x, w.spawn.y, none)).toBe(true)
  expect(standable(w, -1, 0, none)).toBe(false)
  const fragile = w.pieces.find(p => p.fragile)!
  const [x, y] = fragile.cells[0]
  expect(standable(w, x, y, none)).toBe(false)
  expect(standable(w, x, y, new Set([fragile.id]))).toBe(true)
  const solid = w.pieces.find(p => !p.fragile)!
  const [sx, sy] = solid.cells[0]
  expect(standable(w, sx, sy, new Set([fragile.id]))).toBe(false)
  const door = w.doors[0]
  expect(standable(w, door.x, door.y, new Set(w.pieces.map(p => p.id)))).toBe(false)
})

test('a pickup lies on floor: each of its cells names it, a cell beside does not, and a scene with none answers null', () => {
  const w = worldFor('woods')!
  expect(w.pickups.length).toBeGreaterThan(0)
  const quiver = w.pickups[0]
  for (const [x, y] of quiver.cells) {
    expect(walkable(w, x, y)).toBe(true)
    expect(pickupAt(w, x, y)).toEqual(quiver)
  }
  expect(pickupAt(w, w.spawn.x, w.spawn.y)).toBeNull()
  expect(worldFor('tavern')!.pickups).toEqual([])
})
