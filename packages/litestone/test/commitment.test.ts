// `@@commitment` — a transition the system owes a row at a time (`FJS-D353`).
//
// Step 1 of IDEAS/ontology.md § 6: the declaration and the read, no clock.
// Nothing here makes a transition; `due()` answers *which rows owe one by T*,
// and the assertions that matter are the ones staged by MOVING THE CLOCK — the
// same row, unwritten, is not due and then is.
//
// The due time is computed twice — SQL for the filter, JavaScript for the value
// handed back — and § the two computations agree is what holds them together.
// SQLite's own `+1 months` overflows a month end where `addToDate` clamps, so a
// bare modifier would pass every test that avoids the 29th to the 31st.

import { describe, test, expect } from 'bun:test'
import { createTestEnv } from '../src/testing.js'
import { parse, generateJsonSchema } from '../src/index.js'
import { buildCommitmentMap, dueSql } from '../src/core/commitment.js'
import { dueAt }                     from '@frontierjs/toolbelt/datetime'
import { renderJsonSchemaSnapshot }  from '../src/tools/jsonschema-snapshot.js'
import { Database } from 'bun:sqlite'

const ORDERS = `
enum OrderStatus { pending paid cancelled }

model Order {
  id        Int         @id
  label     String
  status    OrderStatus @default(pending)
  createdAt DateTime    @default(now())
  @@transitions(status,
    pay:     pending -> paid,
    abandon: pending -> cancelled @system)
  @@commitment(abandon, on: createdAt + 14d)
}
`

const INVOICES = `
enum InvoiceStatus { issued settled lapsed }

model Invoice {
  id        Int           @id
  label     String
  status    InvoiceStatus @default(issued)
  dueOn     String        @date
  graceDays Int           @unit(d) @immutable
  held      Boolean       @default(false)
  @@transitions(status,
    settle: issued -> settled,
    lapse:  issued -> lapsed @system)
  @@commitment(lapse, on: dueOn + graceDays, while: held == false)
}
`

// FJS-D362's case: the invoice owns the deadline, the subscription owns the
// move. Two invoices under one subscription is the whole point — the oldest
// fires and the later one meets a move already made.
const DUNNING = `
enum SubStatus  { active pastDue cancelled }
enum BillStatus { issued paid }

model Subscription {
  id        Int       @id
  status    SubStatus @default(active)
  createdAt DateTime  @default(now())
  invoices  Invoice[]
  @@transitions(status,
    lapse:   active -> pastDue @system,
    recover: pastDue -> active @system,
    cancel:  [active, pastDue] -> cancelled @system)
}

model Invoice {
  id             Int           @id
  label          String
  status         BillStatus    @default(issued)
  subscription   Subscription? @relation(fields: [subscriptionId], references: [id])
  subscriptionId Int?
  dueOn          String        @date
  graceDays      Int           @unit(d) @immutable
  dunningDays    Int           @unit(d) @immutable
  @@transitions(status, settle: issued -> paid)
  @@commitment(subscription.lapse,  on: dueOn + graceDays,   while: status == 'issued')
  @@commitment(subscription.cancel, on: dueOn + dunningDays, while: status == 'issued')
}
`

const T0 = '2026-01-01T00:00:00.000Z'
const labels = async (db, model, ids) =>
  (await db[model].findMany({ where: { id: { in: ids } } })).map(r => r.label).sort()

// ─── the declaration ──────────────────────────────────────────────────────────

describe('@@commitment — parse', () => {
  const errorsOf = (src) => parse(src).errors.join('\n')

  test('the declaration parses into the transition, the anchor and the offset', () => {
    const r = parse(ORDERS)
    expect(r.valid).toBe(true)
    const c = r.schema.models[0].attributes.find(a => a.kind === 'commitment')
    expect(c).toEqual({ kind: 'commitment', name: 'abandon', via: null, transition: 'abandon',
      on: { field: 'createdAt', offset: { sign: 1, value: 14, unit: 'd' } }, while: null })
  })

  test('a minus, spaced or not, is a negative offset', () => {
    for (const on of ['createdAt - 2h', 'createdAt -2h']) {
      const r = parse(ORDERS.replace('createdAt + 14d', on))
      expect(r.valid).toBe(true)
      expect(r.schema.models[0].attributes.find(a => a.kind === 'commitment').on.offset)
        .toEqual({ sign: -1, value: 2, unit: 'h' })
    }
  })

  test('a transition @@transitions does not declare is refused, naming the ones it does', () => {
    expect(errorsOf(ORDERS.replace('@@commitment(abandon', '@@commitment(abandn')))
      .toContain("@@commitment(abandn, …) names no transition of this model — declared: pay, abandon")
  })

  test("a related model's transition parses through a to-one relation (FJS-D362)", () => {
    const r = parse(DUNNING)
    expect(r.errors).toEqual([])
    const c = r.schema.models.find(m => m.name === 'Invoice').attributes.filter(a => a.kind === 'commitment')
    expect(c.map(x => [x.name, x.via, x.transition]))
      .toEqual([['subscription.lapse', 'subscription', 'lapse'], ['subscription.cancel', 'subscription', 'cancel']])
  })

  test('the hop is refused where it cannot name one row', () => {
    expect(errorsOf(DUNNING.replace('@@commitment(subscription.lapse', '@@commitment(subscriptin.lapse')))
      .toContain("'subscriptin' names no relation of this model")
    expect(errorsOf(DUNNING.replace('@@commitment(subscription.lapse', '@@commitment(label.lapse')))
      .toContain("'label' names no relation of this model")
    expect(errorsOf(DUNNING.replace('@@commitment(subscription.lapse', '@@commitment(subscription.lapsed')))
      .toContain('names no transition of Subscription — declared: lapse, recover, cancel')
    expect(errorsOf(DUNNING.replace('  @@transitions(status,\n    lapse:',
      '  @@commitment(invoices.settle, on: createdAt)\n  @@transitions(status,\n    lapse:')))
      .toContain("'invoices' is a to-many relation, and a commitment moves ONE row")
  })

  test('the anchor must be a time', () => {
    expect(errorsOf(ORDERS.replace('on: createdAt + 14d', 'on: label + 14d')))
      .toContain("on: 'label' must be a DateTime or a String @date")
  })

  test('a month on an instant is refused — it needs a zone the expression does not have', () => {
    expect(errorsOf(ORDERS.replace('+ 14d', '+ 1mo'))).toContain("is in 'mo', and 'createdAt' is an instant")
  })

  test('an hour on a day is refused', () => {
    expect(errorsOf(INVOICES.replace('graceDays Int           @unit(d)', 'graceDays Int @unit(h)')))
      .toContain("is in 'h', and 'dueOn' is a day")
  })

  test('a unit that is not a duration is refused at the token', () => {
    expect(errorsOf(ORDERS.replace('+ 14d', '+ 14kg'))).toContain("'14kg' is not a duration")
  })

  test('an offset column must be a frozen, required duration', () => {
    expect(errorsOf(INVOICES.replace('@unit(d) @immutable', '@unit(d)'))).toContain('must be @immutable')
    expect(errorsOf(INVOICES.replace('@unit(d) @immutable', '@immutable'))).toContain('must declare a duration @unit')
    expect(errorsOf(INVOICES.replace('@unit(d) @immutable', '@unit(kg) @immutable'))).toContain('must declare a duration @unit')
    expect(errorsOf(INVOICES.replace('graceDays Int ', 'graceDays Int?'))).toContain('must be a required Int')
  })

  test('while: reads this row and nothing else', () => {
    expect(errorsOf(INVOICES.replace('held == false', 'auth().id == 1'))).toContain('has no caller')
    expect(errorsOf(INVOICES.replace('held == false', "dueOn < now()"))).toContain("When it is owed is on:'s to say")
    expect(errorsOf(INVOICES.replace('held == false', 'status == settled')))
      .toContain("'settled' names no field of this model — an enum member is written quoted: 'settled'")
  })

  test('one deadline per transition', () => {
    expect(errorsOf(ORDERS.replace('@@commitment(abandon, on: createdAt + 14d)',
      '@@commitment(abandon, on: createdAt + 14d)\n  @@commitment(abandon, on: createdAt + 20d)')))
      .toContain('is declared twice')
  })

  test('the DDL is byte-identical with the attribute and without it', async () => {
    const { generateDDL } = await import('../src/core/ddl.js')
    const bare = ORDERS.replace(/\n  @@commitment\([^)]*\)/, '')
    expect(bare).not.toContain('@@commitment')
    expect(generateDDL(parse(ORDERS).schema)).toBe(generateDDL(parse(bare).schema))
  })
})

// ─── the client's copy ────────────────────────────────────────────────────────

describe('@@commitment — x-commitments', () => {
  test('the declaration reaches the client keyed by transition, and the due time does not', () => {
    const js  = generateJsonSchema(parse(INVOICES).schema)
    const def = js.$defs?.Invoice ?? js.definitions?.Invoice
    expect(def['x-commitments']).toEqual({
      lapse: {
        via: null, transition: 'lapse',
        target: 'Invoice', field: 'status', from: ['issued'],
        on: 'dueOn', kind: 'day',
        offset: { sign: 1, field: 'graceDays', unit: 'd' },
        while: { type: 'compare', op: '==', left: { type: 'field', name: 'held' }, right: { type: 'literal', value: false } },
      },
    })
    const o = generateJsonSchema(parse(ORDERS).schema)
    expect((o.$defs?.Order ?? o.definitions?.Order)['x-commitments'])
      .toEqual({ abandon: { via: null, transition: 'abandon', target: 'Order', field: 'status', from: ['pending'], on: 'createdAt', kind: 'instant', offset: { sign: 1, value: 14, unit: 'd' }, while: null } })
    const d = generateJsonSchema(parse(DUNNING).schema)
    const x = (d.$defs?.Invoice ?? d.definitions?.Invoice)['x-commitments']
    expect(Object.keys(x)).toEqual(['subscription.lapse', 'subscription.cancel'])
    // The TARGET's move, so a screen holding the subscription can ask whether
    // it is still owed without reading Subscription's own document.
    expect(x['subscription.lapse']).toMatchObject({
      via: 'subscription', transition: 'lapse', target: 'Subscription', field: 'status', from: ['active'], on: 'dueOn' })
    expect(x['subscription.cancel'].from).toEqual(['active', 'pastDue'])
  })

  // A screen derives its date from these, so one that stops being emitted is a
  // date that stops showing with nothing failing — the snapshot is the diff.
  test('the JSON Schema snapshot carries one line per commitment', () => {
    const md = renderJsonSchemaSnapshot(parse(DUNNING).schema)
    expect(md).toContain("- commitment `subscription.lapse` — on `dueOn` + `graceDays` d (day) · moves `Subscription.status` from active · while `status == 'issued'`")
    expect(renderJsonSchemaSnapshot(parse(ORDERS).schema))
      .toContain('- commitment `abandon` — on `createdAt` + 14d (instant) · moves `Order.status` from pending')
  })
})

// ─── the read ─────────────────────────────────────────────────────────────────

describe('@@commitment — due() across a to-one relation (FJS-D362)', () => {
  async function dunning() {
    const env = await createTestEnv({ schema: DUNNING, now: T0 })
    const db  = env.db.asSystem()
    const sub   = await db.subscription.create({ data: {} })
    const terms = { graceDays: 3, dunningDays: 21 }
    const older = await db.invoice.create({ data: { label: 'older', subscriptionId: sub.id, dueOn: '2025-12-20', ...terms } })
    const newer = await db.invoice.create({ data: { label: 'newer', subscriptionId: sub.id, dueOn: '2025-12-31', ...terms } })
    const loose = await db.invoice.create({ data: { label: 'loose', subscriptionId: null,   dueOn: '2025-11-01', ...terms } })
    return { env, db, sub, older, newer, loose }
  }

  test('each row names the TARGET it moves — the subscription, not the invoice', async () => {
    const { env, db, sub, older } = await dunning()
    expect(await db.invoice.due({ transition: 'subscription.lapse' })).toEqual([
      { transition: 'subscription.lapse', id: older.id, dueAt: '2025-12-23',
        target: { model: 'Subscription', accessor: 'subscription', transition: 'lapse', id: sub.id } },
    ])
    env.close?.()
  })

  test('the oldest invoice fires the move and the later one then owes nothing', async () => {
    const { env, db, sub, older, newer } = await dunning()
    env.clock.advance('10d')
    expect((await db.invoice.due({ transition: 'subscription.lapse' })).map(d => d.id)).toEqual([older.id, newer.id])
    await db.subscription.transition(sub.id, 'lapse', { system: true })
    expect(await db.invoice.due({ transition: 'subscription.lapse' })).toEqual([])
    env.close?.()
  })

  test('a null relation is a quiet skip, however overdue', async () => {
    const { env, db, loose } = await dunning()
    env.clock.advance('365d')
    expect((await db.invoice.due()).map(d => d.id)).not.toContain(loose.id)
    env.close?.()
  })

  test("while: still reads the DECLARING row — a paid invoice owes nothing", async () => {
    const { env, db, older } = await dunning()
    await db.invoice.transition(older.id, 'settle')
    expect(await db.invoice.due({ transition: 'subscription.lapse' })).toEqual([])
    env.close?.()
  })

  test('a cancelled subscription leaves every unpaid invoice owing nothing', async () => {
    const { env, db, sub } = await dunning()
    env.clock.advance('60d')
    expect((await db.invoice.due()).length).toBe(4)
    await db.subscription.transition(sub.id, 'cancel', { system: true })
    expect(await db.invoice.due()).toEqual([])
    env.close?.()
  })
})

describe('@@commitment — due()', () => {
  async function orders() {
    const env = await createTestEnv({ schema: ORDERS, now: T0 })
    const sys = env.db.asSystem()
    const old  = await sys.order.create({ data: { label: 'old',  createdAt: '2025-12-01T00:00:00.000Z' } })
    const edge = await sys.order.create({ data: { label: 'edge', createdAt: '2025-12-18T00:00:00.000Z' } })
    const newb = await sys.order.create({ data: { label: 'new',  createdAt: '2025-12-30T00:00:00.000Z' } })
    const paid = await sys.order.transition((await sys.order.create({ data: { label: 'paid', createdAt: '2025-11-01T00:00:00.000Z' } })).id, 'pay')
    return { env, db: sys, old, edge, newb, paid }
  }

  test('a row is due once its anchor plus the offset has passed, and not before', async () => {
    const { env, db, old, edge } = await orders()
    const due = await db.order.due()
    const target = (id) => ({ model: 'Order', accessor: 'order', transition: 'abandon', id })
    expect(due).toEqual([
      { transition: 'abandon', id: old.id,  dueAt: '2025-12-15T00:00:00.000Z', target: target(old.id) },
      { transition: 'abandon', id: edge.id, dueAt: '2026-01-01T00:00:00.000Z', target: target(edge.id) },
    ])
    env.close?.()
  })

  test('THE CLOCK MOVES IT — nothing written, and the new order falls due', async () => {
    const { env, db, newb } = await orders()
    expect((await db.order.due()).map(d => d.id)).not.toContain(newb.id)
    env.clock.advance('13d')
    expect((await db.order.due()).map(d => d.id)).toContain(newb.id)
    env.close?.()
  })

  test('the from-state is the guard: a paid order owes nothing however old', async () => {
    const { env, db, paid } = await orders()
    expect((await db.order.due()).map(d => d.id)).not.toContain(paid.id)
    env.close?.()
  })

  test('`by` asks ahead without moving the clock — the sweep’s lookahead', async () => {
    const { env, db, newb } = await orders()
    const ahead = await db.order.due({ by: '2026-01-13T00:00:00.000Z' })
    expect(ahead.find(d => d.id === newb.id)?.dueAt).toBe('2026-01-13T00:00:00.000Z')
    expect(await db.order.due({ by: new Date('2025-12-14T23:59:59.999Z') })).toEqual([])
    env.close?.()
  })

  test('`where` narrows to one row, which is how a fire asks again', async () => {
    const { env, db, old, edge } = await orders()
    expect(await db.order.due({ where: { id: old.id } })).toHaveLength(1)
    await db.order.transition(old.id, 'abandon', { system: true })
    expect(await db.order.due({ where: { id: old.id } })).toEqual([])
    expect((await db.order.due()).map(d => d.id)).toEqual([edge.id])
    env.close?.()
  })

  test('a model with no @@commitment refuses by name', async () => {
    const env = await createTestEnv({ schema: `model Tag {\n  id Int @id\n  name String\n}`, now: T0 })
    await expect(env.db.tag.due()).rejects.toThrow(/@@commitment/)
    env.close?.()
  })

  test('an unknown transition and an unreadable `by` are refused', async () => {
    const { env, db } = await orders()
    await expect(db.order.due({ transition: 'pay' })).rejects.toThrow(/declared: abandon/)
    await expect(db.order.due({ by: 'soon' })).rejects.toThrow(/by must be an instant/)
    env.close?.()
  })

  test('an offset column and while: — a day kind, read in a zone', async () => {
    const env = await createTestEnv({ schema: INVOICES, now: '2026-03-10T23:30:00.000Z' })
    const db  = env.db.asSystem()
    const a = await db.invoice.create({ data: { label: 'a',    dueOn: '2026-03-01', graceDays: 3  } })
    const b = await db.invoice.create({ data: { label: 'b',    dueOn: '2026-03-01', graceDays: 10 } })
    const c = await db.invoice.create({ data: { label: 'c',    dueOn: '2026-03-01', graceDays: 12 } })
    const h = await db.invoice.create({ data: { label: 'held', dueOn: '2026-02-01', graceDays: 3, held: true } })

    // 23:30 UTC on the 10th is the 10th in UTC and already the 11th in
    // Auckland, which is the day `b` falls due.
    expect(await labels(db, 'invoice', (await db.invoice.due()).map(d => d.id))).toEqual(['a'])
    const nz = await db.invoice.due({ timeZone: 'Pacific/Auckland' })
    expect(await labels(db, 'invoice', nz.map(d => d.id))).toEqual(['a', 'b'])
    expect((await db.invoice.due({ by: '2026-03-12T12:00:00.000Z' })).map(d => d.dueAt).sort())
      .toEqual(['2026-03-04', '2026-03-11'])
    // Held: owed by the date, excused by `while:`.
    expect((await db.invoice.due({ by: '2027-01-01T00:00:00.000Z' })).map(d => d.id).sort())
      .toEqual([a.id, b.id, c.id].sort())
    expect(h.held).toBe(true)
    env.close?.()
  })

  test('the caller’s own read path applies — a gate refuses due() as it refuses findMany', async () => {
    const env = await createTestEnv({ schema: ORDERS.replace('model Order {', 'model Order {\n  @@gate("5.5.5.5")'), now: T0 })
    await env.db.asSystem().order.create({ data: { label: 'x', createdAt: '2025-01-01T00:00:00.000Z' } })
    expect(await env.db.asSystem().order.due()).toHaveLength(1)
    await expect(env.db.order.due()).rejects.toThrow()
    env.close?.()
  })
})

// ─── the two computations agree ───────────────────────────────────────────────

describe('@@commitment — SQL and JavaScript agree', () => {
  function schemaFor(kind, on, unit) {
    return `
enum S { open done }
model Row {
  id     Int    @id
  status S      @default(open)
  at     ${kind === 'day' ? 'String @date' : 'DateTime'}
  n      Int    @unit(${unit}) @immutable
  @@transitions(status, close: open -> done)
  @@commitment(close, on: ${on})
}`
  }

  const DAYS    = ['2024-01-31', '2024-02-29', '2025-02-28', '2026-03-31', '2026-05-31', '2026-12-31', '2026-01-15']
  const INSTANT = ['2024-02-29T23:59:59.999Z', '2026-01-31T12:00:00.000Z', '2026-12-31T23:00:00.500Z']

  const cases = [
    ...['d', 'wk', 'mo', 'yr'].flatMap(unit => [
      { kind: 'day', unit, on: 'at + n', ns: [0, 1, 2, 11, 13, 48] },
      { kind: 'day', unit, on: 'at - n', ns: [1, 3, 12] },
    ]),
    ...['ms', 's', 'min', 'h', 'd', 'wk'].flatMap(unit => [
      { kind: 'instant', unit, on: 'at + n', ns: [0, 1, 36, 1000] },
      { kind: 'instant', unit, on: 'at - n', ns: [1, 90] },
    ]),
  ]

  for (const cs of cases) {
    test(`${cs.kind} ${cs.on} (${cs.unit})`, () => {
      const r = parse(schemaFor(cs.kind, cs.on, cs.unit))
      expect(r.errors).toEqual([])
      const [c] = buildCommitmentMap(r.schema).Row
      const { sql, params } = dueSql(c)
      const db = new Database(':memory:')
      db.run('CREATE TABLE "row" ("at" TEXT, "n" INTEGER)')
      const anchors = cs.kind === 'day' ? DAYS : INSTANT
      for (const at of anchors) for (const n of cs.ns) {
        const got = db.query(`SELECT ${sql.replaceAll('"at"', '?').replaceAll('"n"', '?')} AS d`)
        // Bind by position: every `"at"`/`"n"` became a `?`, so interleave in
        // the order they appear.
        const order = [...sql.matchAll(/"at"|"n"|\?/g)].map(m => m[0])
        let p = 0
        const binds = order.map(t => t === '"at"' ? at : t === '"n"' ? n : params[p++])
        const sqlAnswer = got.get(...binds).d
        expect({ at, n, v: sqlAnswer }).toEqual({ at, n, v: dueAt(c, { at, n }) })
      }
      db.close()
    })
  }

  test('a literal offset agrees too', () => {
    const r = parse(schemaFor('day', 'at + 1mo', 'd'))
    const [c] = buildCommitmentMap(r.schema).Row
    const { sql, params } = dueSql(c)
    const db = new Database(':memory:')
    for (const at of DAYS) {
      const order = [...sql.matchAll(/"at"|\?/g)].map(m => m[0])
      let p = 0
      const binds = order.map(t => t === '"at"' ? at : params[p++])
      const v = db.query(`SELECT ${sql.replaceAll('"at"', '?')} AS d`).get(...binds).d
      expect(v).toBe(dueAt(c, { at }))
    }
    expect(dueAt(c, { at: '2026-01-31' })).toBe('2026-02-28')
    db.close()
  })
})

// ─── a second machine on one row ─────────────────────────────────────────────
//
// Step 7's shape: a reminder changes no state the invoice passes through, so it
// is a Boolean machine beside `status`, and its commitment reads the OTHER
// machine in `while:`. The runtime always keyed moves by field; the parser's
// single-valued check refused the second declaration until this was written.

const REMINDED = `
enum InvoiceStatus { issued settled }

model Invoice {
  id       Int           @id
  status   InvoiceStatus @default(issued)
  dueOn    String        @date
  reminded Boolean       @default(false) @system
  @@transitions(status, settle: issued -> settled)
  @@transitions(reminded, remind: false -> true @system)
  @@commitment(remind, on: dueOn - 3d, while: status == 'issued')
}
`

describe('@@commitment — a Boolean machine beside the status one', () => {
  test('both machines parse, and x-transitions carries each under its field', () => {
    const { schema, valid, errors } = parse(REMINDED)
    expect(errors).toEqual([])
    expect(valid).toBe(true)
    const js  = generateJsonSchema(schema) as Record<string, any>
    const doc = js.$defs?.Invoice ?? js.definitions?.Invoice
    expect(Object.keys(doc['x-transitions'])).toEqual(['status', 'reminded'])
    expect(doc['x-commitments'].remind).toMatchObject({ field: 'reminded', from: [false] })
  })

  test('due three days before, not once settled, and never twice', async () => {
    const env = await createTestEnv({ schema: REMINDED, now: T0 })
    const db  = env.db.asSystem()
    const [soon, later, paid] = await Promise.all(['2026-01-03', '2026-01-20', '2026-01-02'].map(dueOn =>
      db.invoice.create({ data: { dueOn } })))
    await env.db.invoice.transition(paid.id, 'settle', { system: true })

    expect((await db.invoice.due({ timeZone: 'UTC' })).map(d => d.id)).toEqual([soon.id])

    const moved = await env.db.invoice.transition(soon.id, 'remind', { system: true })
    expect(moved).toMatchObject({ reminded: true, status: 'issued' })
    expect(await db.invoice.due({ timeZone: 'UTC' })).toEqual([])
    await expect(env.db.invoice.transition(soon.id, 'remind', { system: true })).rejects.toThrow()

    // The status machine still moves a row whose reminder machine did.
    expect((await env.db.invoice.transition(soon.id, 'settle', { system: true })).status).toBe('settled')
    expect(later.reminded).toBe(false)
    env.close?.()
  })

  test('one move name on two machines is refused, since transition() makes the first', () => {
    const { valid, errors } = parse(REMINDED.replace('remind: false -> true', 'settle: false -> true')
                                             .replace('@@commitment(remind,', '@@commitment(settle,'))
    expect(valid).toBe(false)
    expect(errors.join('\n')).toContain("the move 'settle' is declared on @@transitions(status) and @@transitions(reminded)")
  })
})
