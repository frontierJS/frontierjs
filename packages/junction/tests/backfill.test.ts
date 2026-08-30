// tests/backfill.test.ts
//
// The middle step of expand → backfill → contract.
//
// Against a REAL Litestone client, for the reason outbox.test.ts is: every
// claim here is about what is in the database after a chunk, and a stub agrees
// with whatever it was written to agree with. Two of these could not be made
// any other way — that the writes are SILENT, and that `asSystem()` still
// cannot get a value past a `@check`.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import {
  defineBackfill, runChunk, ensureRun, backfillStatus, nextDelayMs, chunkId,
  idInfoFor, assertField, decodeCursor, accessorFor, hasBackfillModel, isBackfillDefinition,
  backfillSchemaFragment,
} from '../src/core/backfill.ts'

// The SHIPPED fragment, not a copy: a model this file wrote and the one an app
// installs would be free to disagree.
const BACKFILL = await Bun.file(new URL('../db/backfill.lite', import.meta.url)).text()

const SCHEMA = `
database main { path "./app.db" }

model Order {
  id        Int       @id @default(autoincrement())
  reference String
  total     Int       @default(0)
  shippedAt DateTime?
  note      String?   @check("length(note) <= 8", "note is too long")
  @@db(main)
}

model Ticket {
  id    String  @id @default(uuid())
  label String?
  @@db(main)
}

${BACKFILL}
`

const mkDb = () => createClient({ databases: ':memory:', schema: SCHEMA }) as unknown as Promise<any>

/** Enough app for the engine: it reaches `app.db` and nothing else. */
const appFor = (db: unknown) => ({ db }) as never

const seedOrders = async (db: any, n: number) => {
  for (let i = 1; i <= n; i++)
    await db.asSystem().order.create({ data: { reference: `ORD-${String(i).padStart(3, '0')}` } })
}

// ─── the declaration ─────────────────────────────────────────────────────────

describe('defineBackfill', () => {
  test('carries the marker, and the defaults', () => {
    const d = defineBackfill({ name: 'ship', model: 'Order', field: 'shippedAt', fill: () => new Date() })
    expect(isBackfillDefinition(d)).toBe(true)
    expect(d.chunkSize).toBe(500)
    expect(d.duty).toBe(0.25)
    expect(d.where).toBe(null)
  })

  // The three the classifier reads. A backfill that does not say which column
  // it fills cannot be matched to the contract that needs it.
  for (const key of ['name', 'model', 'field'] as const) {
    test(`refuses a definition with no ${key}`, () => {
      const opts: any = { name: 'x', model: 'Order', field: 'shippedAt', fill: () => 1 }
      delete opts[key]
      expect(() => defineBackfill(opts)).toThrow(new RegExp(`'${key}' is required`))
    })
  }

  test('refuses a fill that is not a function', () => {
    expect(() => defineBackfill({ name: 'x', model: 'Order', field: 'shippedAt', fill: 3 as never }))
      .toThrow(/'fill' must be a function/)
  })

  test('refuses a duty outside (0, 1]', () => {
    for (const duty of [0, -1, 1.5, Number.NaN])
      expect(() => defineBackfill({ name: 'x', model: 'Order', field: 'shippedAt', fill: () => 1, duty }))
        .toThrow(/'duty' must be/)
    expect(defineBackfill({ name: 'x', model: 'Order', field: 'shippedAt', fill: () => 1, duty: 1 }).duty).toBe(1)
  })

  test('refuses a chunkSize that is not a positive integer', () => {
    for (const chunkSize of [0, -5, 2.5])
      expect(() => defineBackfill({ name: 'x', model: 'Order', field: 'shippedAt', fill: () => 1, chunkSize }))
        .toThrow(/'chunkSize' must be/)
  })

  test('isBackfillDefinition rejects a plain object with the right keys', () => {
    expect(isBackfillDefinition({ name: 'x', model: 'Order', field: 'y', fill: () => 1 })).toBe(false)
  })
})

// ─── the throttle ────────────────────────────────────────────────────────────

describe('nextDelayMs', () => {
  // A duty cycle: the gap is what makes the WORK a fraction of wall time.
  test('a quarter duty waits three times the chunk', () => {
    expect(nextDelayMs(200, 0.25)).toBe(600)
    expect(nextDelayMs(200, 0.5)).toBe(200)
  })

  test('full duty never waits', () => {
    expect(nextDelayMs(1234, 1)).toBe(0)
  })

  test('an instant chunk waits nothing rather than a negative', () => {
    expect(nextDelayMs(0, 0.25)).toBe(0)
  })
})

// ─── the chunk id ────────────────────────────────────────────────────────────

describe('chunkId', () => {
  test('the cursor is part of it, so two positions are two chunks', () => {
    expect(chunkId('ship', 0, '10')).not.toBe(chunkId('ship', 0, '11'))
  })

  test('the same position is the same id, which is what makes a replay a no-op', () => {
    expect(chunkId('ship', 0, '10')).toBe(chunkId('ship', 0, '10'))
  })

  // Without this a restart is impossible rather than slow: `dispatch({ id })`
  // treats a taken primary key as work already queued for all time, so the
  // chunk that declined at a paused cursor holds that id forever.
  test('the generation is part of it, so a restart at one position is reachable', () => {
    expect(chunkId('ship', 1, '10')).not.toBe(chunkId('ship', 0, '10'))
  })

  // The `FJS-342` shape: a name and a cursor joined by hand collide.
  test('a name holding the separator cannot forge another backfill position', () => {
    expect(chunkId('ship:0:10', 0, null)).not.toBe(chunkId('ship', 0, '10'))
  })

  test('no cursor is its own position', () => {
    expect(chunkId('ship', 0, null)).not.toBe(chunkId('ship', 0, '0'))
  })
})

// ─── reading the schema ──────────────────────────────────────────────────────

describe('the target model', () => {
  test('finds an integer id and says it is numeric', async () => {
    expect(idInfoFor(await mkDb(), 'Order')).toEqual({ field: 'id', numeric: true })
  })

  test('a uuid id is not numeric — a cursor read back as a number would scan nothing', async () => {
    expect(idInfoFor(await mkDb(), 'Ticket')).toEqual({ field: 'id', numeric: false })
  })

  test('refuses a model the schema does not declare', async () => {
    const db = await mkDb()
    expect(() => idInfoFor(db, 'Nope')).toThrow(/declares no model 'Nope'/)
  })

  // Nothing below this would catch it: a `where` naming an unknown key warns to
  // stderr and matches NO ROWS, so a typo'd field would read the empty first
  // chunk as the end and mark the run done having filled nothing.
  test('refuses a field the model does not declare, and lists what it has', async () => {
    const db = await mkDb()
    expect(() => assertField(db, 'Order', 'shippdAt')).toThrow(/declares no field 'shippdAt'/)
    expect(() => assertField(db, 'Order', 'shippdAt')).toThrow(/It declares: .*shippedAt/)
    expect(() => assertField(db, 'Order', 'shippedAt')).not.toThrow()
  })

  test('a typo in a backfill is refused before it can report itself finished', async () => {
    const db = await mkDb()
    await seedOrders(db, 3)
    const typo = defineBackfill({ name: 't', model: 'Order', field: 'shippdAt', fill: () => 1 })
    await expect(runChunk(appFor(db), typo)).rejects.toThrow(/declares no field 'shippdAt'/)
    const [row] = await backfillStatus(appFor(db))
    expect(row.status).not.toBe('done')
  })

  test('decodeCursor round-trips by the id kind', () => {
    expect(decodeCursor('12', { field: 'id', numeric: true })).toBe(12)
    expect(decodeCursor('12', { field: 'id', numeric: false })).toBe('12')
    expect(decodeCursor(null, { field: 'id', numeric: true })).toBe(null)
  })

  test('accessorFor is the camelCase spelling', () => {
    expect(accessorFor('Order')).toBe('order')
    expect(accessorFor('BackfillRun')).toBe('backfillRun')
  })
})

// ─── running one ─────────────────────────────────────────────────────────────

describe('runChunk', () => {
  const ship = (over: Record<string, unknown> = {}) => defineBackfill({
    name: 'ship', model: 'Order', field: 'shippedAt', chunkSize: 5,
    fill: () => new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  } as never)

  test('fills a chunk, advances the cursor, and says it is not done', async () => {
    const db = await mkDb()
    await seedOrders(db, 12)

    const r = await runChunk(appFor(db), ship())
    expect(r.done).toBe(false)
    expect(r.scanned).toBe(5)
    expect(r.filled).toBe(5)
    expect(r.cursor).toBe('5')
    expect(await db.asSystem().order.count({ where: { shippedAt: { not: null } } })).toBe(5)
  })

  test('runs to the end and stops, and the short chunk is what says so', async () => {
    const db  = await mkDb()
    await seedOrders(db, 12)
    const def = ship()

    const chunks = []
    for (let i = 0; i < 10; i++) {
      const r = await runChunk(appFor(db), def)
      chunks.push(r)
      if (r.done) break
    }

    expect(chunks.map(c => c.filled)).toEqual([5, 5, 2])
    expect(chunks[2].done).toBe(true)
    expect(await db.asSystem().order.count({ where: { shippedAt: null } })).toBe(0)

    const [row] = await backfillStatus(appFor(db))
    expect(row.status).toBe('done')
    expect(row.scanned).toBe(12)
    expect(row.filled).toBe(12)
    expect(row.finishedAt).not.toBe(null)
  })

  // Idempotence is the PREDICATE, not the cursor. A chunk that half-committed
  // and ran again must skip what it already wrote whatever position was saved.
  test('re-running from a stale cursor fills nothing twice', async () => {
    const db  = await mkDb()
    await seedOrders(db, 6)
    const def = ship()

    await runChunk(appFor(db), def)
    // Wind the position back — the state an interrupted chunk leaves when it
    // wrote rows and died before recording where it got to.
    await db.asSystem().backfillRun.update({ where: { name: 'ship' }, data: { cursor: null, status: 'running' } })

    const again = await runChunk(appFor(db), def)
    expect(again.scanned).toBe(1)
    expect(again.filled).toBe(1)
    expect(await db.asSystem().order.count({ where: { shippedAt: null } })).toBe(0)
  })

  // A declined row is behind us. A cursor that only moved past WRITES would
  // re-read it on every chunk for the rest of the run and never finish.
  test('a fill that declines a row still moves the cursor past it', async () => {
    const db = await mkDb()
    await seedOrders(db, 4)

    const def = ship({ chunkSize: 2, fill: (r: any) => (r.reference.endsWith('1') ? undefined : new Date()) })
    const r   = await runChunk(appFor(db), def)

    expect(r.scanned).toBe(2)
    expect(r.filled).toBe(1)
    expect(r.cursor).toBe('2')

    expect((await runChunk(appFor(db), def)).scanned).toBe(2)
  })

  test('a run already done answers done without scanning', async () => {
    const db  = await mkDb()
    await seedOrders(db, 2)
    const def = ship()
    await runChunk(appFor(db), def)

    const again = await runChunk(appFor(db), def)
    expect(again.done).toBe(true)
    expect(again.scanned).toBe(0)
  })

  test('a paused run does nothing and keeps its place', async () => {
    const db  = await mkDb()
    await seedOrders(db, 8)
    const def = ship()
    await runChunk(appFor(db), def)
    await db.asSystem().backfillRun.update({ where: { name: 'ship' }, data: { status: 'paused' } })

    const r = await runChunk(appFor(db), def)
    expect(r.paused).toBe(true)
    expect(r.scanned).toBe(0)
    expect(r.cursor).toBe('5')
    expect(await db.asSystem().order.count({ where: { shippedAt: null } })).toBe(3)
  })

  test('a custom predicate replaces IS NULL', async () => {
    const db = await mkDb()
    await seedOrders(db, 4)

    // Not a null-fill: the rows already carry a value and the backfill corrects
    // it. The predicate has to exclude what it wrote or the run never ends,
    // which is what `total: 0` does here.
    const def = ship({ name: 'totals', field: 'total', where: { total: 0 }, fill: () => 99, chunkSize: 3 })
    const r   = await runChunk(appFor(db), def)
    expect(r.filled).toBe(3)
    expect(await db.asSystem().order.count({ where: { total: 0 } })).toBe(1)
  })

  test('a uuid-keyed model pages by its string id', async () => {
    const db = await mkDb()
    for (let i = 0; i < 5; i++) await db.asSystem().ticket.create({ data: {} })

    const def = defineBackfill({ name: 'labels', model: 'Ticket', field: 'label', chunkSize: 2, fill: () => 'x' })
    let seen  = 0
    for (let i = 0; i < 10; i++) {
      const r = await runChunk(appFor(db), def)
      seen += r.filled
      if (r.done) break
    }
    expect(seen).toBe(5)
    expect(await db.asSystem().ticket.count({ where: { label: null } })).toBe(0)
  })
})

// ─── the two claims a stub could not test ────────────────────────────────────

describe('what the writes do and do not do', () => {
  // A tap fires on `setImmediate`, so a read in the same tick sees nothing at
  // all — including from the control, which is how this assertion passes
  // against a backfill that announces every row.
  const tick = () => new Promise(r => setImmediate(r))

  test('a chunk announces NOTHING — a per-row update would broadcast every row', async () => {
    const db = await mkDb()
    await seedOrders(db, 6)

    const events: string[] = []
    db.$tapEvents((e: { event: string; scope?: string }) => { events.push(`${e.event}:${e.scope ?? '-'}`) })

    // Two controls, because *silent* has to be told apart from *not listening*,
    // and from *bulk is silent anyway*. `asSystem()` does not suppress a tap:
    // one ordinary update announces one row, which over ten million rows is the
    // flood this design exists to avoid.
    await db.asSystem().order.update({ where: { id: 1 }, data: { reference: 'CTRL' } })
    await tick()
    expect(events).toEqual(['update:row'])

    await db.asSystem().order.updateMany({ where: { id: 2 }, data: { reference: 'CTRL2' } })
    await tick()
    expect(events).toEqual(['update:row', 'update:collection'])

    // And the backfill's own writes, through the same client, add nothing.
    await runChunk(appFor(db), defineBackfill({
      name: 'ship', model: 'Order', field: 'shippedAt', chunkSize: 6, fill: () => new Date(),
    }))
    await tick()
    expect(events).toEqual(['update:row', 'update:collection'])
  })

  // `asSystem()` drops the gate, the row policies and the field guards. It does
  // not drop a CHECK, because that is in the table (`FJS-519`) — which is the
  // whole reason a backfill is allowed to use it.
  test('asSystem() still cannot get a value past a @check', async () => {
    const db = await mkDb()
    await seedOrders(db, 2)

    const bad = defineBackfill({
      name: 'notes', model: 'Order', field: 'note', chunkSize: 2,
      fill: () => 'far too long for this column',
    })
    await expect(runChunk(appFor(db), bad)).rejects.toThrow(/note is too long/)

    // And the identical write UNDER the limit is accepted, so the refusal is
    // shown to come from the rule it names rather than from the path (`FJS-351`).
    const good = defineBackfill({
      name: 'notes-ok', model: 'Order', field: 'note', chunkSize: 2, fill: () => 'short',
    })
    expect((await runChunk(appFor(db), good)).filled).toBe(2)
  })
})

// ─── refusals ────────────────────────────────────────────────────────────────

describe('refusals', () => {
  test('a schema with no BackfillRun is refused by name, and says how to fix it', async () => {
    const db = await createClient({
      databases: ':memory:',
      schema: 'database main { path "./a.db" }\nmodel Order { id Int @id @default(autoincrement())\n shippedAt DateTime?\n @@db(main) }',
    }) as any
    expect(hasBackfillModel(db)).toBe(false)
    await expect(ensureRun(appFor(db), defineBackfill({ name: 'x', model: 'Order', field: 'shippedAt', fill: () => 1 })))
      .rejects.toThrow(/declares no BackfillRun/)
  })

  // Per-tenant backfills are not built. Refused by name rather than run against
  // the app-level database, which is nobody's — that would report a completed
  // backfill having touched no tenant's rows.
  test('a tenanted app is refused rather than half-filled', async () => {
    const db  = await mkDb()
    const app = { db, tenants: { list: () => [] } } as never
    await expect(backfillStatus(app)).rejects.toThrow(/not built yet/)
  })
})

// ─── the shipped fragment ────────────────────────────────────────────────────

describe('backfillSchemaFragment', () => {
  test('is the file, byte for byte', () => {
    expect(backfillSchemaFragment()).toBe(BACKFILL)
  })

  test('retargets @@db(main) and leaves the prose that discusses it alone', () => {
    const moved = backfillSchemaFragment('ops')
    expect(moved).toContain('@@db(ops)')
    expect(moved).not.toMatch(/^\s*@@db\(main\)/m)
    // The header names the attribute in prose; a bare substring replace would
    // rewrite that too and the file would stop explaining itself.
    expect(moved).toContain('Keep @@db(main) spelled exactly')
  })
})

// ─── the row, under a race ───────────────────────────────────────────────────

describe('ensureRun', () => {
  // Two replicas booting together both find no row and both create it. The name
  // is the primary key, so one gets a conflict — and the row the other wrote is
  // the row this one wanted.
  test('concurrent first sightings settle on one row rather than one refusal', async () => {
    const db  = await mkDb()
    const def = defineBackfill({ name: 'ship', model: 'Order', field: 'shippedAt', fill: () => 1 })

    const rows = await Promise.all([1, 2, 3, 4].map(() => ensureRun(appFor(db), def)))
    for (const r of rows) expect(r.name).toBe('ship')
    expect(await db.asSystem().backfillRun.count({})).toBe(1)
  })
})
