/**
 * test/resource-move.test.js
 *
 * `resource.move()` — a drag, as one patch (`FJS-D366`). The key is minted on
 * the device from the rows this resource holds, so a move made offline is one
 * queued write, and litestone takes it as written.
 *
 * The fake is the NETWORK and nothing else. The schema goes through
 * `generateSchemas()`, the build's own step, so `x-rank` is what litestone
 * emits. A patch is applied to the held rows and the lane read back in
 * `(rank, id)` order by a plain `<`, which litestone's `test/rank.test.ts`
 * proves is the order SQLite answers. The seeded keys are written by hand.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const _patches = []
let _rows = []

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      tether: { get: () => _rows, subscribe: (fn) => { fn(_rows); return () => {} }, set: () => {} },
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: () => Promise.resolve(_rows),
    }),
  }),
}))

const _proxy = {
  find:   () => Promise.resolve({ data: _rows, total: _rows.length }),
  get:    () => Promise.resolve({}),
  create: (d) => Promise.resolve(d),
  patch:  (id, d) => { _patches.push([id, d]); return Promise.resolve(d) },
  remove: () => Promise.resolve({}),
  invoke: () => Promise.resolve({}),
  on: () => {}, call: () => Promise.resolve(),
}

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { createResource } = await import('../src/resource/resource.js')

const SOURCE = `
model Card {
  id      Int    @id
  title   String
  laneId  Int
  rank    String @rank(scope: laneId)
}

model Page {
  id       Int    @id
  parentId Int?
  rank     String @rank(scope: parentId)
}

model Plain {
  id   Int    @id
  name String
}
`

const dir = mkdtempSync(join(tmpdir(), 'sierra-move-'))
writeFileSync(join(dir, 'schema.lite'), SOURCE)
const generated = await generateSchemas(join(dir, 'schema.lite'), () => {}, SIERRA_ROOT)
registerSchemas(generated.defs, generated.models, generated.updatePatch, generated.readPatch)

beforeEach(() => {
  _patches.length = 0
  _rows = [
    { id: 1, title: 'c1', laneId: 1, rank: 'V' },
    { id: 2, title: 'c2', laneId: 1, rank: 'W' },
    { id: 3, title: 'c3', laneId: 1, rank: 'X' },
    { id: 4, title: 'c4', laneId: 2, rank: 'V' },
  ]
})

/** Apply the last patch to the held rows, and answer the lane in (rank, id) order. */
async function landed(laneId) {
  const [id, data] = _patches.at(-1)
  _rows = _rows.map(r => r.id === id ? { ...r, ...data } : r)
  return _rows
    .filter(r => r.laneId === laneId)
    .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id - b.id)
    .map(r => r.id)
}

describe('move() mints a key between its neighbors and patches one row', () => {
  test('the schema says which column orders the model', () => {
    expect(generated.defs.Card.properties.rank['x-rank']).toEqual({ scope: ['laneId'] })
  })

  test('between two named rows', async () => {
    const cards = createResource('cards')
    await cards.move(3, { after: 1, before: 2 })
    expect(_patches).toHaveLength(1)
    expect(Object.keys(_patches[0][1]).sort()).toEqual(['id', 'rank'])
    expect(await landed(1)).toEqual([1, 3, 2])
  })

  test('one neighbor named, the other read off the rows held', async () => {
    const cards = createResource('cards')
    await cards.move(3, { after: 1 })
    expect(await landed(1)).toEqual([1, 3, 2])
    await cards.move(1, { before: 2 })
    expect(await landed(1)).toEqual([3, 1, 2])
  })

  test('null is the start or the end of the scope', async () => {
    const cards = createResource('cards')
    await cards.move(3, { after: null })
    expect(await landed(1)).toEqual([3, 1, 2])
    await cards.move(3, { before: null })
    expect(await landed(1)).toEqual([1, 2, 3])
  })

  test('before: null alone is the end, past the last key held', async () => {
    // High keys, so a key minted anywhere in the whole range rather than after
    // the last row lands at the end by chance about once in a hundred runs.
    _rows = _rows.map(r => ({ ...r, rank: { 1: 'x', 2: 'y', 3: 'z1', 4: 'V' }[r.id] }))
    await createResource('cards').move(1, { before: null })
    expect(await landed(1)).toEqual([2, 3, 1])
  })

  test('into another scope, between two of its rows', async () => {
    const cards = createResource('cards')
    await cards.move(1, { into: { laneId: 2 }, before: 4 })
    expect(_patches[0][1].laneId).toBe(2)
    expect(await landed(2)).toEqual([1, 4])
  })

  test('into another scope with no neighbor sends no key, and the server puts it at the end', async () => {
    const cards = createResource('cards')
    await cards.move(1, { into: { laneId: 2 } })
    expect(_patches[0][1]).toEqual({ id: 1, laneId: 2 })
  })

  test('two devices splitting one gap mint different keys', async () => {
    const cards = createResource('cards')
    await cards.move(3, { after: 1, before: 2 })
    await cards.move(3, { after: 1, before: 2 })
    expect(_patches[0][1].rank).not.toBe(_patches[1][1].rank)
  })
})

describe('move() refuses by name', () => {
  test('a neighbor in another scope', async () => {
    await expect(createResource('cards').move(3, { after: 4 })).rejects.toThrow(/in another laneId/)
  })

  test('a row it does not hold', async () => {
    await expect(createResource('cards').move(99, { after: 1 })).rejects.toThrow(/holds no such row/)
  })

  test('two neighbors with no room between them', async () => {
    _rows = _rows.map(r => r.id === 2 ? { ...r, rank: 'V' } : r)
    await expect(createResource('cards').move(3, { after: 1, before: 2 })).rejects.toThrow(/no room/)
  })

  test('a model with no @rank', async () => {
    await expect(createResource('plains').move(1, {})).rejects.toThrow(/declares none/)
  })
})
