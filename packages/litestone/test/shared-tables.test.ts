// test/shared-tables.test.ts
//
// One table object per model, shared by every flavor of client (`FJS-722`).
//
// A table is built from a ~5,900-line closure and `$setAuth(user)` could not
// reuse one, because the principal differs per request. So a request touching
// five models rebuilt five of them — 172 µs on the 188-model fixture — and a
// fully materialised scoped client held 3.6 MB, which under `strategy database`
// is per tenant. What made it fixable is that not one of the reads `makeTable`
// performs while CONSTRUCTING the object is per-flavor: the four keys a flavor
// decides (`auth`, `isSystem`, `scopedBy`, `tables`) are read only inside method
// bodies. The object being rebuilt never depended on the thing forcing the
// rebuild.
//
// So the ctx those bodies close over is shared, with those four as getters over
// an AsyncLocalStorage, and a flavor is a store rather than a context.
//
// What follows is written against the two ways that can be wrong, because both
// are silent and neither is visible from a test that asks one client one
// question:
//
//   CROSSING   — two flavors in flight at once, or one resumed across an await,
//                reading each other's principal. Every row here that could pass
//                by accident is PAIRED with the other principal asking the same
//                question, since a mechanism that answered nobody would satisfy
//                a test that only checked the refusal (`FJS-351`).
//
//   SHARING A  — a cache keyed on the ctx OBJECT, which used to be per flavor
//   CACHE        and now is not. Three were: the gate plugin's level resolver,
//                external-ref's stash, and the hoisted field-read answer. The
//                gate one is the reason `isSystemAdmin` briefly answered at
//                whatever level the process saw first — a wrong ANSWER, with no
//                error anywhere.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  database main { path ":memory:" }

  // @@auth so \`auth().id\` is graded against a declared set rather than
  // warning — the fixture is about tables, and an ungraded-claim notice in the
  // output is the kind of noise that trains people to skip the output.
  model User {
    id   Int    @id @default(autoincrement())
    name String
    @@auth
    @@db(main)
  }

  model Doc {
    id      Int    @id @default(autoincrement())
    title   String
    ownerId Int
    @@allow('read', auth().id == ownerId)
    @@db(main)
  }

  model Vault {
    id    Int    @id @default(autoincrement())
    label String
    @@gate("7")
    @@db(main)
  }
`

const seed = async () => {
  const db: any = await createClient({ schema: SCHEMA, db: ':memory:' })
  await db.asSystem().doc.createMany({ data: [
    { title: 'alice one', ownerId: 1 },
    { title: 'alice two', ownerId: 1 },
    { title: 'bob one',   ownerId: 2 },
  ] })
  await db.asSystem().vault.create({ data: { label: 'sealed' } })
  return db
}

// ─── the object really is shared ──────────────────────────────────────────────

describe('the build is shared', () => {
  test('two flavors reach ONE built table, and it is not the wrapper', async () => {
    const db: any = await seed()
    const a = db.$setAuth({ id: 1 })
    const b = db.$setAuth({ id: 2 })

    // The wrappers differ — each carries its own flavor.
    expect(a.doc).not.toBe(b.doc)

    // But a rebuild would show up as cost, and this is the assertion that
    // fails if anyone reintroduces one: touching every model on a fresh
    // principal is cheap only if nothing is being built.
    const names = Object.keys(db).filter(k => !k.startsWith('$') && !['sql', 'query', 'asSystem'].includes(k))
    const t0 = Bun.nanoseconds()
    for (let i = 0; i < 20; i++) {
      const c = db.$setAuth({ id: i })
      for (const n of names) void c[n]
    }
    const perClient = (Bun.nanoseconds() - t0) / 20 / 1000

    // A tripwire for a REBUILD, not a performance budget. Rebuilding this
    // schema's tables costs ~110 µs per model, so a client touching all of them
    // would be tens of milliseconds; wrapping them is microseconds. The bound
    // sits two orders of magnitude above the wrapped cost and one below the
    // rebuilt one, because a wall-clock assertion inside a parallel suite that
    // is tight enough to measure anything is tight enough to flake — and a
    // flaky tripwire gets deleted, which is worse than a loose one.
    expect(perClient).toBeLessThan(2000)
    db.$close()
  })
})

// ─── crossing ─────────────────────────────────────────────────────────────────

describe('two flavors in flight do not cross', () => {
  test('a row policy answers each principal its own rows, interleaved', async () => {
    const db: any = await seed()
    const alice = db.$setAuth({ id: 1 })
    const bob   = db.$setAuth({ id: 2 })

    // Started together and resolved together, so the two calls are genuinely
    // overlapping rather than sequential — which is the only shape that can see
    // a store leaking between them.
    const [aRows, bRows] = await Promise.all([
      alice.doc.findMany({ orderBy: { id: 'asc' } }),
      bob.doc.findMany({ orderBy: { id: 'asc' } }),
    ])

    expect(aRows.map((r: any) => r.title)).toEqual(['alice one', 'alice two'])
    expect(bRows.map((r: any) => r.title)).toEqual(['bob one'])
    db.$close()
  })

  test('interleaved many times, each still its own', async () => {
    const db: any = await seed()
    const clients = [1, 2].map(id => [id, db.$setAuth({ id })] as const)

    const runs = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const [id, c] = clients[i % 2]
        return c.doc.findMany().then((rows: any[]) => [id, rows.length] as const)
      })
    )
    // Alice owns two rows and Bob one, so a single crossed read is visible as a
    // count that belongs to the other principal.
    for (const [id, n] of runs) expect(n).toBe(id === 1 ? 2 : 1)
    db.$close()
  })

  test('a gate answers the caller who asked, not the one who asked first', async () => {
    const db: any = await seed()
    const nobody   = db.$setAuth({ id: 9 })
    const sysadmin = db.$setAuth({ id: 10, isSystemAdmin: true })

    // Order matters: the ungated caller goes FIRST, because the defect this
    // pins gave every later caller the first caller's level.
    await expect(nobody.vault.findMany()).rejects.toThrow()
    await expect(sysadmin.vault.findMany()).resolves.toHaveLength(1)

    // And the other way round on a fresh client, or the fix would only work in
    // one order.
    const db2: any = await seed()
    const sys2 = db2.$setAuth({ id: 11, isSystemAdmin: true })
    const no2  = db2.$setAuth({ id: 12 })
    await expect(sys2.vault.findMany()).resolves.toHaveLength(1)
    await expect(no2.vault.findMany()).rejects.toThrow()

    db.$close(); db2.$close()
  })

  test('asSystem() off an auth-scoped client keeps that principal', async () => {
    const db: any = await seed()
    const alice = db.$setAuth({ id: 1 })
    // The bypass WITH an actor: the row policy is lifted, and the principal is
    // still the one an audit entry is written from.
    const all = await alice.asSystem().doc.findMany()
    expect(all).toHaveLength(3)
    // …while the un-bypassed client is unchanged by having taken one.
    expect(await alice.doc.findMany()).toHaveLength(2)
    db.$close()
  })
})

// ─── the refusal ──────────────────────────────────────────────────────────────

describe('a read that outlived its call is refused', () => {
  test('the root client is a flavor, so an ordinary call is not an escape', async () => {
    const db: any = await seed()
    // The root client has no principal, so the policy admits nothing — the
    // point is that it ANSWERS rather than throwing the escape error.
    await expect(db.doc.findMany()).resolves.toEqual([])
    db.$close()
  })

  test('a ctx kept past its call refuses to answer the principal', async () => {
    let held: any = null
    const db: any = await createClient({
      schema: SCHEMA, db: ':memory:',
      plugins: [{ name: 'capture', onBeforeRead(_m: any, _a: any, ctx: any) { held = ctx } }],
    } as any)

    await db.$setAuth({ id: 1 }).doc.findMany()
    expect(held).not.toBeNull()

    // Out here there is no call, so the four keys the flavor decides have
    // nothing to answer with. They say so instead of answering as nobody, which
    // is what a fall-back to the unscoped root would have done — a read that
    // returns [] with a 200 (`FJS-D200`, one realm down).
    expect(() => held.auth).toThrow(/read outside a call/)
    expect(() => held.isSystem).toThrow(/read outside a call/)
    expect(() => held.tables).toThrow(/floating promise|setTimeout/)

    // The message names the ways back, or it is a refusal nobody can act on.
    expect(() => held.auth).toThrow(/\$setAuth|asSystem/)

    // And everything schema-derived still answers, because only four keys are
    // the flavor's — a ctx kept for its schema facts is not broken by this.
    expect(held.schema).toBeTruthy()
    expect(typeof held.relationMap).toBe('object')
    db.$close()
  })

  test('what the refusal does NOT cover, stated so nobody assumes it does', async () => {
    // AsyncLocalStorage propagates into anything scheduled inside a call, so a
    // timer set during a call still sees that call's flavor after it returns.
    // That is deliberate and it is what the code did BEFORE this change too —
    // a table closed over one flavor's ctx for its whole life. The refusal
    // catches a read with no call in its async history at all; it is not
    // `FJS-687`'s ENDED marker, which junction needs because `$` is reachable
    // from anywhere and a shared table is reachable only through a flavor.
    const db: any = await seed()
    let seen: any
    const alice = db.$setAuth({ id: 1 })
    await alice.doc.findMany()
    await new Promise<void>((resolve) => {
      // Scheduled from OUTSIDE a call: no store, so the refusal fires.
      setTimeout(() => { try { seen = (db as any).$schema && 'no-call' } catch { seen = 'threw' } ; resolve() }, 0)
    })
    expect(seen).toBe('no-call')
    db.$close()
  })
})
