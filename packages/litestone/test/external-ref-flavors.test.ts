// test/external-ref-flavors.test.ts
//
// ExternalRefPlugin's update stash is keyed on the FLAVOR, not the ctx (`FJS-722`,
// `FJS-1872`). Since the table is shared, the ctx a plugin hook sees is one
// object for every principal, and a stash keyed on it is one Map for every
// principal: two updates in flight at once would write the same `Model.field`
// slot, and the first caller's after-write would clean up the SECOND caller's
// old file while the second cleaned nothing. Nothing reports it — the row is
// updated either way and the wrong blob is deleted from a store nobody reads
// back in a test.
//
// So two principals are held INSIDE serialize() until both have stashed, and
// each cleanup is asserted to name the principal whose row it came from.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { ExternalRefPlugin } from '../src/plugins/external-ref.js'

const SCHEMA = `
  database main { path ":memory:" }
  model User {
    id   Int    @id @default(autoincrement())
    name String
    @@auth
    @@db(main)
  }
  model Doc {
    id      Int       @id @default(autoincrement())
    ownerId Int
    resume  File?
    photos  File[]
    @@db(main)
  }
`

/** Stands in for FileStorage; `cleaned` is the only thing a store observes. */
class RecordingStore extends ExternalRefPlugin {
  fieldType = 'File'
  cleaned: Array<{ by: number | null, key: string }> = []
  // Set during the interleaved update: every serialize() waits here until the
  // expected number of callers has arrived, so both stashes are written before
  // either write runs. Null outside that window so seeding is not held.
  barrier: (() => Promise<void>) | null = null

  async serialize(value: any) {
    if (this.barrier) await this.barrier()
    return { key: value }
  }
  async cleanup(ref: any, { ctx }: any) {
    // `ctx.auth` reads the call in progress, so this is the principal whose
    // after-write is running — the one the stash was supposed to belong to.
    this.cleaned.push({ by: ctx.auth?.id ?? null, key: ref.key })
  }
}

const barrierOf = (n: number) => {
  let arrived = 0
  let release!: () => void
  const open = new Promise<void>(r => { release = r })
  return () => { if (++arrived >= n) release(); return open }
}

describe('two principals updating at once keep their own stash', () => {
  test('a scalar ref: each principal cleans up its OWN old ref', async () => {
    const store = new RecordingStore()
    const db: any = await createClient({ schema: SCHEMA, db: ':memory:', plugins: [store] } as any)
    const sys = db.asSystem()
    await sys.doc.create({ data: { ownerId: 1, resume: 'alice-old' } })
    await sys.doc.create({ data: { ownerId: 2, resume: 'bob-old' } })

    const alice = db.$setAuth({ id: 1 })
    const bob   = db.$setAuth({ id: 2 })

    store.barrier = barrierOf(2)
    await Promise.all([
      alice.doc.update({ where: { id: 1 }, data: { resume: 'alice-new' } }),
      bob.doc.update({ where: { id: 2 }, data: { resume: 'bob-new' } }),
    ])
    store.barrier = null

    // Both old refs cleaned, each by the principal whose row held it. A stash
    // shared across principals has alice cleaning `bob-old` and nobody cleaning
    // `alice-old`, with both rows correctly updated.
    const sorted = [...store.cleaned].sort((x, y) => x.by! - y.by!)
    expect(sorted).toEqual([
      { by: 1, key: 'alice-old' },
      { by: 2, key: 'bob-old' },
    ])

    const rows = await sys.doc.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => JSON.parse(r.resume).key)).toEqual(['alice-new', 'bob-new'])
    db.$close()
  })

  test('an array ref: each principal cleans up its OWN old refs', async () => {
    const store = new RecordingStore()
    const db: any = await createClient({ schema: SCHEMA, db: ':memory:', plugins: [store] } as any)
    const sys = db.asSystem()
    await sys.doc.create({ data: { ownerId: 1, photos: ['a1', 'a2'] } })
    await sys.doc.create({ data: { ownerId: 2, photos: ['b1'] } })

    const alice = db.$setAuth({ id: 1 })
    const bob   = db.$setAuth({ id: 2 })

    store.barrier = barrierOf(2)
    await Promise.all([
      alice.doc.update({ where: { id: 1 }, data: { photos: ['a3'] } }),
      bob.doc.update({ where: { id: 2 }, data: { photos: ['b2'] } }),
    ])
    store.barrier = null

    const byPrincipal = (id: number) => store.cleaned.filter(c => c.by === id).map(c => c.key).sort()
    expect(byPrincipal(1)).toEqual(['a1', 'a2'])
    expect(byPrincipal(2)).toEqual(['b1'])
    expect(store.cleaned).toHaveLength(3)
    db.$close()
  })
})
