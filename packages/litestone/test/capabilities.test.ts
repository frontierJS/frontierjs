// The derived capability set — `FJS-D139`'s bet, executed.
//
// A capability is a REFERENCE to something the seed already declares, so the set
// is derived and there is no `enum Capability` to keep in step. What this suite
// holds is the three rulings that decide what is IN it: `FJS-D140` (writes and
// moves by default, read where the model says `all`), `FJS-D147` (the column
// tier is opt-in per column) and `FJS-506` (a move at gate 8 is one the engine
// makes, so it is nobody's grant).

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { deriveCapabilities, capabilityNames } from '../src/core/capabilities.js'

const derive = (src: string) => {
  const r = parse(src)
  if (!r.valid) throw new Error(r.errors.join('\n'))
  return deriveCapabilities(r.schema)
}
const names = (src: string) => derive(src).map(c => c.name)

const SHOP = `
enum InvoiceStatus { draft issued voided archived }
model Invoice {
  id     Int           @id @default(autoincrement())
  number String
  note   String        @capability
  status InvoiceStatus @default(draft)
  @@capabilities(all)
  @@transitions(status,
    issue: draft  -> issued,
    void:  issued -> voided @gate(5),
    seal:  voided -> archived @gate(8))
}
model Server {
  id       Int    @id @default(autoincrement())
  hostname String @capability
  @@capabilities
}
model Audit { id Int @id @default(autoincrement())  note String }
`

describe('the derived set', () => {
  it('is the model\'s own surface, and the switch is what opts it in', () => {
    const got = names(SHOP)
    // Audit declares no @@capabilities, so it contributes nothing at all.
    expect(got.filter(n => n.startsWith('Audit.'))).toEqual([])
    expect(got).toContain('Server.create')
    expect(got).toContain('Server.update')
    expect(got).toContain('Server.delete')
  })

  it('read is opt-in, because its refusal is the silent one', () => {
    const got = names(SHOP)
    expect(got).toContain('Invoice.read')      // @@capabilities(all)
    expect(got).not.toContain('Server.read')   // bare
  })

  it('a named move is a capability and carries its own gate', () => {
    const moves = derive(SHOP).filter(c => c.kind === 'move')
    expect(moves.map(m => m.name)).toEqual(['Invoice.issue', 'Invoice.void'])
    expect(moves.find(m => m.name === 'Invoice.void')!.gate).toBe(5)
    expect(moves.find(m => m.name === 'Invoice.issue')!.gate).toBeNull()
  })

  it('a move at gate 8 is the ENGINE\'s and is nobody\'s grant', () => {
    // getLevel is clamped to 7, so no caller passes and asSystem() bypasses —
    // offering `seal` in a role editor offers something no role can use.
    expect(names(SHOP)).not.toContain('Invoice.seal')
  })

  it('the column tier is opt-in per column, never every writable one', () => {
    const cols = derive(SHOP).filter(c => c.kind === 'column').map(c => c.name)
    expect(cols).toEqual(['Invoice.note', 'Server.hostname'])
    expect(names(SHOP)).not.toContain('Invoice.number')
  })

  it('answers the same set as names, for a grant column to validate against', () => {
    const r = parse(SHOP)
    const set = capabilityNames(r.schema)
    expect(set.has('Invoice.void')).toBe(true)
    expect(set.has('Sever.void')).toBe(false)   // a typo refers to nothing
    expect(set.size).toBe(names(SHOP).length)
  })

  it('is stable — sorted by model, then by name', () => {
    const got = names(SHOP)
    expect(got).toEqual([...got].sort((a, b) =>
      a.split('.')[0]!.localeCompare(b.split('.')[0]!) || a.localeCompare(b)))
  })
})

describe('a declaration that would mean nothing is refused', () => {
  it('@capability without the model\'s own switch', () => {
    const r = parse('model Server { id Int @id  hostname String @capability }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/does not declare @@capabilities/)
  })

  it('@@capabilities takes only (all)', () => {
    const r = parse('model S { id Int @id  @@capabilities(read) }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/only accepts \(all\)/)
  })

  it('@capability takes no arguments — it is not a level', () => {
    const r = parse('model S { id Int @id  n String @capability(5)  @@capabilities }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/takes no arguments/)
  })
})

// ─── enforcement ──────────────────────────────────────────────────────────────
//
// Step 3. The set is what a capability IS; this is what holding one buys and what
// lacking one costs. Three tiers and they are graded in three different places —
// the model's ops ride the plugin seam the gate rides, a move is graded where the
// transition's own @gate is (the only place that knows which move a payload turned
// out to be), and a column is graded against the payload beside @system.
//
// Everything here runs against a real client. A capability that refuses in a unit
// test over a map and does not refuse through the read path a caller actually uses
// is the failure this file exists to prevent — which is why every read METHOD is
// asked separately rather than `findMany` standing for all of them.

import { createClient } from '../src/index.js'

const GRID = `
enum State { draft issued paid }
model Invoice {
  id     Int    @id @default(autoincrement())
  ref    String
  memo   String? @capability
  state  State  @default(draft)
  @@capabilities
  @@transitions(state, issue: draft -> issued, pay: issued -> paid)
}
model Server {
  id     Int    @id @default(autoincrement())
  region String
  @@capabilities(all)
}
model Plain {
  id   Int    @id @default(autoincrement())
  note String
}
`

const client = async (src = GRID) => createClient({ schema: src, db: ':memory:' })
const denied = async (fn: () => unknown, capability: string) => {
  try { await fn() } catch (e: any) {
    expect(e.name).toBe('AccessDeniedError')
    expect(e.capability).toBe(capability)
    return e
  }
  throw new Error(`expected a refusal naming "${capability}" and the call succeeded`)
}

describe('the model tier', () => {
  it('refuses a write the caller holds no grant for, and permits the one they do', async () => {
    const db = await client()
    const holder = db.$setAuth({ id: 1, capabilities: ['Invoice.create'] })

    expect((await holder.invoice.create({ data: { ref: 'A' } })).ref).toBe('A')
    await denied(() => holder.invoice.update({ where: { ref: 'A' }, data: { ref: 'B' } }), 'Invoice.update')
    await denied(() => holder.invoice.deleteMany({ where: { ref: 'A' } }),                 'Invoice.delete')
    await db.$close()
  })

  it('fails closed for a caller with no principal at all', async () => {
    const db = await client()
    // Not a bypass: `FJS-D149` makes a capability per tenant, so no claim is an
    // empty set. An anonymous caller holding everything is the shape this rules out.
    await denied(() => db.invoice.create({ data: { ref: 'A' } }), 'Invoice.create')
    await db.$close()
  })

  it('leaves a model that declares no grid completely alone', async () => {
    const db = await client()
    expect((await db.plain.create({ data: { note: 'n' } })).note).toBe('n')
    expect(await db.plain.findMany({})).toHaveLength(1)
    await db.$close()
  })

  it('is dropped by asSystem(), because a capability is permission and not scope', async () => {
    const db = await client()
    expect((await db.asSystem().invoice.create({ data: { ref: 'A' } })).ref).toBe('A')
    expect(await db.asSystem().server.findMany({})).toEqual([])
    await db.$close()
  })
})

describe('read is opt-in', () => {
  it('says nothing about a read on a model that wrote a bare @@capabilities', async () => {
    const db = await client()
    await db.asSystem().invoice.create({ data: { ref: 'A' } })
    // `FJS-D140`: a missing write capability announces itself, a missing read one
    // is a blank screen, so the silent half is the half you opt into.
    expect(await db.$setAuth({ id: 1, capabilities: [] }).invoice.findMany({})).toHaveLength(1)
    await db.$close()
  })

  it('refuses a read on a model that wrote (all)', async () => {
    const db = await client()
    await db.asSystem().server.create({ data: { region: 'eu' } })
    const bare = db.$setAuth({ id: 1, capabilities: [] })
    await denied(() => bare.server.findMany({}), 'Server.read')
    expect(await db.$setAuth({ id: 1, capabilities: ['Server.read'] }).server.findMany({})).toHaveLength(1)
    await db.$close()
  })

  it('refuses on EVERY read method, not just findMany', async () => {
    // The hazard this package documents about the gate, asked of the grid before
    // it can happen: aggregate, groupBy and search each build their own SELECT,
    // and three of them once skipped the gate entirely. Riding the plugin seam is
    // what makes this list free — a read path that grades the gate grades this.
    const db = await client()
    await db.asSystem().server.create({ data: { region: 'eu' } })
    const bare = db.$setAuth({ id: 1, capabilities: [] })

    const reads: [string, () => unknown][] = [
      ['findMany',   () => bare.server.findMany({})],
      ['findFirst',  () => bare.server.findFirst({})],
      ['findUnique', () => bare.server.findUnique({ where: { id: 1 } })],
      ['count',      () => bare.server.count()],
      ['exists',     () => bare.server.exists({})],
      ['aggregate',  () => bare.server.aggregate({ _count: true })],
      ['groupBy',    () => bare.server.groupBy({ by: ['region'], _count: true })],
      ['findManyAndCount', () => bare.server.findManyAndCount({})],
    ]
    for (const [label, run] of reads) {
      try { await run(); throw new Error(`${label} answered without the capability`) }
      catch (e: any) { expect(`${label}: ${e.capability}`).toBe(`${label}: Server.read`) }
    }
    await db.$close()
  })
})

describe('a move', () => {
  const mk = async (db: any) => (await db.asSystem().invoice.create({ data: { ref: 'X' } })).id

  it('is graded under its own name, on top of update', async () => {
    const db = await client()
    const id = await mk(db)
    const canUpdate = db.$setAuth({ id: 1, capabilities: ['Invoice.update'] })
    await denied(() => canUpdate.invoice.transition(id, 'issue'), 'Invoice.issue')

    const canIssue = db.$setAuth({ id: 1, capabilities: ['Invoice.update', 'Invoice.issue'] })
    expect((await canIssue.invoice.transition(id, 'issue')).state).toBe('issued')
    await db.$close()
  })

  it('is graded the same whichever way it is spelled', async () => {
    // transition(id, 'issue') and update({ data: { state: 'issued' } }) are one
    // move. Litestone enforces both, so a capability that only reached the named
    // call would be a rule with a documented way around it.
    const db = await client()
    const id = await mk(db)
    const canUpdate = db.$setAuth({ id: 1, capabilities: ['Invoice.update'] })
    await denied(() => canUpdate.invoice.update({ where: { id }, data: { state: 'issued' } }), 'Invoice.issue')
    await db.$close()
  })

  it('says nothing about an update that moves nothing', async () => {
    const db = await client()
    const id = await mk(db)
    const canUpdate = db.$setAuth({ id: 1, capabilities: ['Invoice.update'] })
    expect((await canUpdate.invoice.update({ where: { id }, data: { ref: 'Y' } })).ref).toBe('Y')
    await db.$close()
  })

  it('does not exist for a move at gate 8, so nothing asks for one', async () => {
    // `FJS-506`: a move the ENGINE makes is nobody's grant — getLevel is clamped
    // to 7 and asSystem() skips the check, so offering it in a role editor offers
    // nothing. It is out of the derived set, and therefore out of enforcement too.
    const db = await createClient({ db: ':memory:', schema: `
      enum S { a b }
      model Doc {
        id Int @id @default(autoincrement())
        s  S   @default(a)
        @@capabilities
        @@transitions(s, seal: a -> b @gate(8))
      }` })
    const id = (await db.asSystem().doc.create({ data: {} })).id
    // The gate still refuses it — that is @gate(8) doing its own job, and the
    // refusal is the gate's shape (a level) rather than a capability's.
    try {
      await db.$setAuth({ id: 1, capabilities: ['Doc.update'] }).doc.transition(id, 'seal')
      throw new Error('gate 8 admitted a non-system caller')
    } catch (e: any) { expect(e.capability).toBeUndefined() }
    await db.$close()
  })

  it('a @system move is nobody\'s grant either, and is the spelling an app reaches for', async () => {
    // Same exclusion as @gate(8), said the other way. `@system` is the marking
    // `FJS-506` asks for and the one basecamp already uses: it refuses the move
    // unless the call opts in, which IS *the application makes this*. Reading
    // only the gate gave `Server` eight move capabilities where three are human.
    const src = `
      enum S { a b c }
      model Doc {
        id Int @id @default(autoincrement())
        s  S   @default(a)
        @@capabilities
        @@transitions(s, ask: a -> b, settle: b -> c @system)
      }`
    const derived = new Set(names(src))
    expect(derived.has('Doc.ask')).toBe(true)
    expect(derived.has('Doc.settle')).toBe(false)

    // And out of the derived set is out of enforcement: a caller holding every
    // NAMEABLE capability still cannot make the move, because @system is what
    // refuses it and a capability was never what admitted it.
    const db = await createClient({ db: ':memory:', schema: src })
    const id = (await db.asSystem().doc.create({ data: {} })).id
    const holder = db.$setAuth({ id: 1, capabilities: [...derived] })
    await holder.doc.transition(id, 'ask')
    try {
      await holder.doc.transition(id, 'settle')
      throw new Error('@system admitted a caller that did not opt in')
    } catch (e: any) { expect(e.capability).toBeUndefined() }
    // The application's own move still goes through.
    await db.asSystem().doc.transition(id, 'settle', { system: true })
    await db.$close()
  })

  it('a @system move at a gate is still excluded — the gate grades who may ask, not who makes it', async () => {
    // `reportRunning: … @system @gate(5)` is basecamp's shape: the app makes the
    // move, and a caller it makes it FOR must hold level 5. Two statements, and
    // only the first decides whether anybody could hold a grant for it.
    expect(names(`
      enum S { a b }
      model Doc {
        id Int @id @default(autoincrement())
        s  S   @default(a)
        @@capabilities
        @@transitions(s, report: a -> b @system @gate(5))
      }`)).not.toContain('Doc.report')
  })
})

describe('a finer grant REPLACES the coarse one, it does not add to it', () => {
  // The defect this pins is the one that makes both fine tiers decoration. The
  // complaint the grid exists to answer is that *set a variable* arrives
  // bundled with *edit everything else about the environment* — so if writing a
  // `@capability` column ALSO demanded `Model.update`, the grant could only ever
  // be handed to somebody who already held the one it was meant to withhold.
  // Same for a move: `Server.reboot` alone has to be able to reboot, or the move
  // tier is a second name for `update`. Both shipped the wrong way round and
  // were found adopting this in basecamp.
  const SRC = `
    enum S { a b c }
    model Doc {
      id   Int    @id @default(autoincrement())
      name String @default("n")
      vars String @default("[]") @capability
      s    S      @default(a)
      @@capabilities
      @@transitions(s, ask: a -> b, settle: b -> c @system)
    }`
  const open = async () => createClient({ db: ':memory:', schema: SRC })
  const as = (db: any, ...caps: string[]) => db.$setAuth({ id: 1, capabilities: caps })

  it('a column grant alone writes that column', async () => {
    const db: any = await open()
    const { id } = await db.asSystem().doc.create({ data: {} })
    const row = await as(db, 'Doc.vars').doc.update({ where: { id }, data: { vars: '[1]' } })
    expect(row.vars).toBe('[1]')
    await db.$close()
  })

  it('…and `update` alone does NOT — which is the half that already worked', async () => {
    const db: any = await open()
    const { id } = await db.asSystem().doc.create({ data: {} })
    await expect(as(db, 'Doc.update').doc.update({ where: { id }, data: { vars: '[2]' } }))
      .rejects.toThrow(/Doc\.vars/)
    await db.$close()
  })

  it('a payload naming BOTH kinds needs both grants', async () => {
    // The column grant covers its own key and says nothing about the rest, so
    // the rest is exactly what `Model.update` is for.
    const db: any = await open()
    const { id } = await db.asSystem().doc.create({ data: {} })
    await expect(as(db, 'Doc.vars').doc.update({ where: { id }, data: { vars: '[3]', name: 'z' } }))
      .rejects.toThrow(/Doc\.update/)
    const row = await as(db, 'Doc.vars', 'Doc.update')
      .doc.update({ where: { id }, data: { vars: '[3]', name: 'z' } })
    expect(row.name).toBe('z')
    await db.$close()
  })

  it('a move grant alone makes the move, under EITHER spelling', async () => {
    // `transition(id, 'ask')` and `update({ data: { s: 'b' } })` are the same
    // move and litestone enforces both, so they must be graded the same way.
    for (const spell of ['transition', 'update'] as const) {
      const db: any = await open()
      const { id } = await db.asSystem().doc.create({ data: {} })
      const caller = as(db, 'Doc.ask')
      const row = spell === 'transition'
        ? await caller.doc.transition(id, 'ask')
        : await caller.doc.update({ where: { id }, data: { s: 'b' } })
      expect(row.s).toBe('b')
      await db.$close()
    }
  })

  it('a bare update with no keys at all is still an ordinary update', async () => {
    // Nothing finer covers it, so nothing finer can stand in for the grant.
    const db: any = await open()
    const { id } = await db.asSystem().doc.create({ data: {} })
    await expect(as(db, 'Doc.vars', 'Doc.ask').doc.update({ where: { id }, data: {} }))
      .rejects.toThrow(/Doc\.update/)
    await db.$close()
  })

  it('a @system move is refused AS @system, not as a missing grant', async () => {
    // The wrong refusal points at a grant that would not have helped: a caller
    // reading *you lack Doc.update* goes looking for somebody to give it to
    // them, and no set of grants makes this move reachable by hand.
    const db: any = await open()
    const { id } = await db.asSystem().doc.create({ data: {} })
    await as(db, 'Doc.ask').doc.transition(id, 'ask')
    const holder = as(db, 'Doc.ask', 'Doc.update', 'Doc.create', 'Doc.delete', 'Doc.vars')
    await expect(holder.doc.transition(id, 'settle')).rejects.toThrow(/is @system/)
    await db.$close()
  })

  it('on CREATE both apply — the row existing is not what a column grant withholds', async () => {
    const db: any = await open()
    await expect(as(db, 'Doc.create').doc.create({ data: { vars: '[1]' } }))
      .rejects.toThrow(/Doc\.vars/)
    // Not naming the column is an ordinary create.
    expect((await as(db, 'Doc.create').doc.create({ data: { name: 'z' } })).name).toBe('z')
    await db.$close()
  })
})

describe('the column tier', () => {
  it('grades a named column separately from the row', async () => {
    const db = await client()
    const row = await db.asSystem().invoice.create({ data: { ref: 'A' } })
    const canUpdate = db.$setAuth({ id: 1, capabilities: ['Invoice.update'] })

    expect((await canUpdate.invoice.update({ where: { id: row.id }, data: { ref: 'B' } })).ref).toBe('B')
    await denied(() => canUpdate.invoice.update({ where: { id: row.id }, data: { memo: 'm' } }), 'Invoice.memo')

    const canMemo = db.$setAuth({ id: 1, capabilities: ['Invoice.update', 'Invoice.memo'] })
    expect((await canMemo.invoice.update({ where: { id: row.id }, data: { memo: 'm' } })).memo).toBe('m')
    await db.$close()
  })

  it('says nothing about a create that does not name the column', async () => {
    const db = await client()
    const canCreate = db.$setAuth({ id: 1, capabilities: ['Invoice.create'] })
    expect((await canCreate.invoice.create({ data: { ref: 'A' } })).memo).toBeNull()
    await denied(() => canCreate.invoice.create({ data: { ref: 'B', memo: 'm' } }), 'Invoice.memo')
    await db.$close()
  })
})

describe('the grid and the ladder are ANDed', () => {
  it('needs both, and the gate is the floor', async () => {
    // `FJS-D146`. OR would make the gate a bypass — a grant would turn an
    // anonymous caller into an authorised one — so a model that opts into the
    // grid keeps its ladder underneath.
    const db = await createClient({ db: ':memory:', schema: `
      model Ledger {
        id   Int    @id @default(autoincrement())
        note String
        @@gate("4")
        @@capabilities
      }` })

    // Holds the capability, graded below the gate: the gate refuses.
    const lowly = db.$setAuth({ id: 1, capabilities: ['Ledger.create'] })
    try {
      await lowly.ledger.create({ data: { note: 'n' } })
      throw new Error('the gate did not apply to a model that declares a grid')
    } catch (e: any) { expect(e.name).toBe('AccessDeniedError'); expect(e.capability).toBeUndefined() }

    // Passes the gate, holds nothing: the capability refuses.
    const gated = db.$setAuth({ id: 1, isAdmin: true, verifiedAt: new Date().toISOString(), capabilities: [] })
    await denied(() => gated.ledger.create({ data: { note: 'n' } }), 'Ledger.create')
    await db.$close()
  })
})

describe('a principal carrying the wrong shape', () => {
  it('throws by name rather than reading as no grants at all', async () => {
    // An empty set and a malformed one look identical from the refusal, and only
    // one of them is somebody's afternoon. The resolver that built the principal
    // is what is wrong, so the message names it.
    const db = await client()
    const bad = db.$setAuth({ id: 1, capabilities: 'Invoice.create,Invoice.update' } as any)
    await expect(bad.invoice.create({ data: { ref: 'A' } }))
      .rejects.toThrow(/must be an array or a Set — got string/)
    await db.$close()
  })
})

describe('a @capability that contradicts its neighbour is refused at parse', () => {
  const bad = (src: string) => {
    const r = parse(src)
    expect(r.valid).toBe(false)
    return r.errors.join('\n')
  }

  it('refuses an auth stamp, which would make the model uncreatable', () =>
    expect(bad(`model S { id Int @id  who String? @capability @default(auth().id)  @@capabilities }`))
      .toMatch(/uncreatable/))

  it('refuses a column nobody writes', () =>
    expect(bad(`model S { id Int @id  n Int @computed @capability  @@capabilities }`))
      .toMatch(/not a column anyone writes/))

  it('refuses a column locked shut in both directions', () =>
    expect(bad(`model S { id Int @id  k String? @guarded @capability  @@capabilities }`))
      .toMatch(/Only one of them can be true/))

  it('refuses a relation, and points at the foreign key', () =>
    expect(bad(`
      model Owner { id Int @id  ss S[] }
      model S { id Int @id  ownerId Int  owner Owner @relation(fields: [ownerId], references: [id]) @capability  @@capabilities }`))
      .toMatch(/a relation is not stored/))
})

// ─── the grant column ─────────────────────────────────────────────────────────
//
// Step 4. Enforcement asks *does this caller hold X*; this is where an X comes
// from. `Capability` is synthesised from the schema's own surface (`FJS-D147`),
// which is the whole implementation: an enum ARRAY is already a JSON column,
// already validated member by member at the write, already in `$defs` with its
// values and already on `db.$enums` — so the typo refusal, the storage and the
// picker come from machinery that was already tested.

const GRANTS = `
model Invoice { id Int @id @default(autoincrement())  ref String  @@capabilities }
model Payroll { id Int @id @default(autoincrement())  amt Int     @@capabilities }
model Role {
  id           Int          @id @default(autoincrement())
  name         String
  capabilities Capability[]
  @@capabilities
}
`

describe('Capability is synthesised from the schema', () => {
  it('is the derived set, and reaches $enums so a picker has a list to render', async () => {
    const db = await createClient({ schema: GRANTS, db: ':memory:' })
    expect(db.$enums.Capability).toEqual([
      'Invoice.create', 'Invoice.delete', 'Invoice.update',
      'Payroll.create', 'Payroll.delete', 'Payroll.update',
      'Role.create', 'Role.delete', 'Role.update',
    ])
    await db.$close()
  })

  it('refuses a value naming nothing, which is the whole of FJS-D139', async () => {
    const db = await createClient({ schema: GRANTS, db: ':memory:' })
    await expect(db.asSystem().role.create({ data: { name: 'r', capabilities: ['Invoice.crate'] } }))
      .rejects.toThrow(/invalid Capability value "Invoice.crate"/)
    await db.$close()
  })

  it('cannot be declared by hand, because two answers to one name is the bug it removes', () => {
    const r = parse(`enum Capability { a b }\nmodel S { id Int @id  n String  @@capabilities }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/synthesised by litestone/)
  })

  it('refuses a grant column when nothing declares the grid, rather than shipping a column nobody can write', () => {
    const r = parse(`model Role { id Int @id  caps Capability[] }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/no model declares @@capabilities/)
  })

  it('suggests rather than listing once the set outgrows a readable message', async () => {
    // 153 on a real application. A refusal has to say what would have been legal,
    // and past a certain size the full list stops being that.
    const many = Array.from({ length: 6 }, (_, i) =>
      `model M${i} { id Int @id @default(autoincrement())  n String  @@capabilities }`).join('\n')
    const db = await createClient({ db: ':memory:', schema:
      `${many}\nmodel Role { id Int @id @default(autoincrement())  caps Capability[] }` })
    expect(db.$enums.Capability.length).toBe(18)
    await expect(db.asSystem().role.create({ data: { caps: ['M3.crate'] } }))
      .rejects.toThrow(/did you mean "M3.create"\?.*db\.\$enums\.Capability is the list/)
    await db.$close()
  })
})

describe('you may only grant what you hold', () => {
  const held = ['Role.create', 'Invoice.create', 'Invoice.update']
  const env  = async () => {
    const db = await createClient({ schema: GRANTS, db: ':memory:' })
    return { db, as: (caps: string[]) => db.$setAuth({ id: 1, capabilities: caps }) }
  }

  it('permits a subset and the whole of the caller\'s own set', async () => {
    const { db, as } = await env()
    expect((await as(held).role.create({ data: { name: 'a', capabilities: ['Invoice.create'] } })).capabilities)
      .toEqual(['Invoice.create'])
    expect((await as(held).role.create({ data: { name: 'b', capabilities: held } })).capabilities).toEqual(held)
    await db.$close()
  })

  it('refuses a capability the caller does not hold', async () => {
    const { db, as } = await env()
    await expect(as(held).role.create({ data: { name: 'c', capabilities: ['Payroll.create'] } }))
      .rejects.toThrow(/cannot grant "Payroll.create"/)
    await db.$close()
  })

  it('sees the SIDEWAYS move, which is what a ladder cannot', async () => {
    // `FJS-529`: this repo's own guard compares role LEVELS, so a developer (2)
    // may hand out billing (1) — two sets neither of which contains the other.
    // A subset rule refuses it; an ordinal one is blind to it by construction.
    const { db, as } = await env()
    await expect(as(held).role.create({ data: { name: 'd', capabilities: ['Invoice.create', 'Payroll.update'] } }))
      .rejects.toThrow(/cannot grant "Payroll.update"/)
    await db.$close()
  })

  it('makes seeding roles asSystem()\'s job, because a caller can only pass on their own', async () => {
    const { db, as } = await env()
    // Holds exactly enough to CREATE a role and nothing to put in one. The two
    // are separate questions and this is the shape that separates them: the
    // create passes, the grant does not.
    await expect(as(['Role.create']).role.create({ data: { name: 'e', capabilities: ['Invoice.create'] } }))
      .rejects.toThrow(/cannot grant "Invoice\.create".*holds 1 of them/)
    expect((await db.asSystem().role.create({ data: { name: 'root', capabilities: ['Payroll.create'] } })).capabilities)
      .toEqual(['Payroll.create'])
    await db.$close()
  })
})

describe('a capability literal inside a predicate', () => {
  // The read tier has no attribute of its own — a column read must STRIP rather
  // than refuse — so it is spelled as the predicate FJS-D129 already compiles.
  // That literal refers to nothing the parser resolves, which is the one door
  // *a typo cannot exist* does not cover on its own.
  const p = (src: string) => parse(src)

  it('resolves when it names a real capability', () =>
    expect(p(`model S { id Int @id  h String? @allow('read', 'S.update' in auth().capabilities)  @@capabilities }`).valid)
      .toBe(true))

  it('is refused when it names nothing, with the suggestion', () => {
    const r = p(`model S { id Int @id  n String  @@capabilities  @@allow('update', 'S.updte' in auth().capabilities) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/can never be true.*Did you mean 'S\.update'\?/s)
  })

  it('is caught on a field @allow too, which is where the read tier lives', () => {
    const r = p(`model S { id Int @id  h String? @allow('read', 'S.hostname' in auth().capabilities)  @@capabilities }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/names no capability/)
  })

  it('says nothing when no model declares the grid', () =>
    // Below that, auth().capabilities is the app's own bag; `FJS-D151` only
    // claims the name for a schema that opted in.
    expect(p(`model S { id Int @id  h String? @allow('read', 'anything.at.all' in auth().capabilities) }`).valid)
      .toBe(true))

  it('strips the column for everybody when it is wrong — the failure being closed', async () => {
    // The reason this is an error rather than a warning, executed: with the typo
    // in place the predicate is permanently false, so the holder loses the column
    // too, and nothing anywhere says why.
    const db = await createClient({ db: ':memory:', schema: `
      model S {
        id Int @id @default(autoincrement())
        n  String
        h  String? @allow('read', 'S.update' in auth().capabilities)
      }` })
    await db.asSystem().s.create({ data: { n: 'a', h: 'secret' } })
    const holder = db.$setAuth({ id: 1, capabilities: ['S.update'] })
    const other  = db.$setAuth({ id: 2, capabilities: [] })
    expect((await holder.s.findFirst({}))!.h).toBe('secret')
    expect((await other.s.findFirst({}))!.h).toBeUndefined()
    await db.$close()
  })
})

// ─── the affordance ───────────────────────────────────────────────────────────
//
// Step 5. Enforcement is the boundary; this is everything that has to KNOW about
// the boundary without being it — a screen deciding which buttons to draw, a
// reviewer reading a diff, an operator asking what somebody can do.
//
// All of it is permissive-when-unknown by construction (Invariant 6): `x-gate`'s
// contract, unchanged. What a browser believes changes nothing about what the
// Data boundary does.

import { generateJsonSchema } from '../src/jsonschema.js'
import { renderJsonSchemaSnapshot } from '../src/tools/jsonschema-snapshot.js'
import { deriveAccess, renderAccessSnapshot } from '../src/access.js'
import { deriveReleaseSurface, classifyAccess } from '../src/release.js'

const AFFORD = `
enum St { a b c }
model Invoice {
  id   Int     @id @default(autoincrement())
  memo String? @capability
  st   St      @default(a)
  @@gate("2")
  @@capabilities(all)
  @@transitions(st, issue: a -> b, seal: b -> c @gate(8))
}
model Payroll { id Int @id @default(autoincrement())  amt Int  @@capabilities }
model Plain   { id Int @id @default(autoincrement())  n String }
`
const parsed = (src: string) => {
  const r = parse(src)
  if (!r.valid) throw new Error(r.errors.join('\n'))
  return r.schema
}

describe('x-capabilities', () => {
  const defs = () => generateJsonSchema(parsed(AFFORD)).$defs as any

  it('says which capability each action requires, so a client never builds the name itself', () => {
    // The one spelling that must not be guessed: a client concatenating
    // `Model.action` is an affordance that silently never matches on the day
    // either half is spelled differently.
    expect(defs().Invoice['x-capabilities']).toEqual({
      operations: {
        read:   'Invoice.read',
        create: 'Invoice.create',
        update: 'Invoice.update',
        delete: 'Invoice.delete',
      },
      moves:   { issue: 'Invoice.issue' },
      columns: { memo:  'Invoice.memo' },
    })
  })

  it('omits read where the model wrote a bare @@capabilities', () =>
    expect(defs().Payroll['x-capabilities'].operations.read).toBeUndefined())

  it('omits a move no caller can make', () =>
    // `seal` is @gate(8) — the engine's. An affordance for a grant nobody can
    // hold is a button that can only disappoint.
    expect(defs().Invoice['x-capabilities'].moves.seal).toBeUndefined())

  it('is absent on a model that declares no grid', () =>
    expect(defs().Plain['x-capabilities']).toBeUndefined())

  it('is the ENFORCED set — a @system move is not offered to a browser', () => {
    // The third place this list had an author of its own, and the one whose
    // reader is furthest from the boundary: an affordance offering a grant the
    // Data boundary never consults is a button that is never right to show and
    // never fails loudly (Invariant 4).
    const src = `
      enum S { a b c }
      model Doc {
        id Int @id @default(autoincrement())
        s  S   @default(a)
        @@capabilities
        @@transitions(s, ask: a -> b, settle: b -> c @system)
      }`
    const schema = parsed(src)
    const caps   = (generateJsonSchema(schema).$defs as any).Doc['x-capabilities']
    const offered = new Set([caps.operations, caps.moves, caps.columns]
      .flatMap((g: Record<string, string>) => Object.values(g ?? {})))
    expect(offered).toEqual(capabilityNames(schema))
    expect(offered.has('Doc.settle')).toBe(false)
  })

  it('and the committed snapshot carries it — the diff that would show it going away', () => {
    const md = renderJsonSchemaSnapshot(parsed(AFFORD), { command: 'litestone jsonschema' })
    expect(md).toContain('`Invoice.issue`')
    expect(md).toContain('`Invoice.memo`')
    expect(md).not.toContain('`Invoice.seal`')
  })
})

describe('$capabilitiesFor', () => {
  const ada = { id: 1, capabilities: ['Invoice.create', 'Invoice.issue', 'Invoice.memo', 'Payroll.update'] }

  it('answers what is held, grouped the way a person reads it', async () => {
    const db = await createClient({ schema: AFFORD, db: ':memory:' })
    const { held, byModel } = db.$capabilitiesFor(ada)
    expect(held).toEqual(['Invoice.create', 'Invoice.issue', 'Invoice.memo', 'Payroll.update'])
    expect(byModel).toEqual({ Invoice: ['create', 'issue', 'memo'], Payroll: ['update'] })
    await db.$close()
  })

  it('separates a name this schema no longer declares — the migration that did not run', async () => {
    // A capability is a reference, so renaming the referent renames it and the
    // OLD string is left in every Role row in every tenant (`FJS-D148` rules a
    // rename emits a data migration). This is the only thing that can see it:
    // a stale grant grants nothing and looks exactly like a grant.
    const db = await createClient({ schema: AFFORD, db: ':memory:' })
    const r = db.$capabilitiesFor({ capabilities: ['Invoice.create', 'Invoice.aprove'] })
    expect(r.held).toEqual(['Invoice.create'])
    expect(r.unknown).toEqual(['Invoice.aprove'])
    await db.$close()
  })

  it('takes the bare list too, because the union of roles exists before a principal does', async () => {
    const db = await createClient({ schema: AFFORD, db: ':memory:' })
    expect(db.$capabilitiesFor(['Payroll.delete']).held).toEqual(['Payroll.delete'])
    expect(db.$capabilitiesFor(new Set(['Payroll.delete'])).held).toEqual(['Payroll.delete'])
    expect(db.$capabilitiesFor(null)).toEqual({ held: [], unknown: [], byModel: {} })
    await db.$close()
  })

  it('answers identically on every flavour of client', async () => {
    // The contract $checkWhere and $protectedFields already have. What a name
    // GRANTS is a fact about the schema, so who is asking cannot change it —
    // which is also why it takes its subject as an argument rather than
    // defaulting to the client's own principal.
    const db = await createClient({ schema: AFFORD, db: ':memory:' })
    const answers = [db, db.asSystem(), db.$setAuth({ id: 9, capabilities: [] })]
      .map(c => JSON.stringify(c.$capabilitiesFor(ada)))
    expect(new Set(answers).size).toBe(1)
    await db.$close()
  })
})

describe('the access snapshot', () => {
  it('carries a section, derived rather than authored', () => {
    const md = renderAccessSnapshot(deriveAccess(parsed(AFFORD)), { command: 'litestone access' })
    const section = md.slice(md.indexOf('## Capabilities'), md.indexOf('## Levels'))
    expect(section).toContain('`Invoice.read`')
    expect(section).toContain('`Invoice.create`')
    expect(section).toContain('`Invoice.issue`')
    expect(section).toContain('`Invoice.memo`')
    expect(section).not.toContain('Invoice.seal')   // @gate(8) — nobody's grant
    expect(section).not.toContain('`Plain`')
    expect(section).toContain('`Payroll.create`')
  })

  it('renders the ENFORCED set rather than rebuilding it — one owner', () => {
    // This section used to re-expand the names itself: create/update/delete,
    // then every move below gate 8, then the opted-in columns. That is the same
    // rule written twice, and the two disagreed the first time the derivation
    // learned something — a `@system` move left the enforced set and stayed in
    // this table, offering a grant the boundary would never consult
    // (Invariant 4, found adopting this in basecamp).
    const src = `
      enum St { a b }
      model Doc {
        id Int @id @default(autoincrement())
        st St  @default(a)
        @@capabilities
        @@transitions(st, ask: a -> b, settle: a -> b @system)
      }`
    const schema  = parsed(src)
    const md      = renderAccessSnapshot(deriveAccess(schema), { command: 'litestone access' })
    const section = md.slice(md.indexOf('## Capabilities'), md.indexOf('## Levels'))

    // Every name the boundary enforces, and no name it does not.
    for (const n of capabilityNames(schema)) expect(section).toContain(`\`${n}\``)
    expect(section).not.toContain('Doc.settle')
  })
})

describe('a grid change is graded on the access axis', () => {
  // Without this the comparison is silent about it: a model gaining a grid
  // starts refusing writes N-1 has been making all along, with no column, no
  // type and no constraint moving. Nothing else in the surface can see it.
  const surface = (caps: string, col = false) => deriveReleaseSurface(parsed(
    `model Invoice { id Int @id  ref String  memo String?${col ? ' @capability' : ''}  ${caps} }`))
  const grade = (before: string, after: string, col?: [boolean, boolean]) =>
    classifyAccess(surface(before, col?.[0]), surface(after, col?.[1]))

  it('narrows when a model opts in', () => {
    const r = grade('', '@@capabilities')
    expect(r.verdict).toBe('narrows')
    // One sentence serves both axes here — the deploy and the reviewer are told
    // the same thing — so it rides `detail` and `accessDetail` stays absent.
    expect(r.findings[0].accessDetail ?? r.findings[0].detail).toMatch(/no N-1 caller holds/)
  })

  it('widens when a model opts out', () =>
    expect(grade('@@capabilities', '').verdict).toBe('widens'))

  it('narrows when read becomes graded, and widens when it stops', () => {
    expect(grade('@@capabilities', '@@capabilities(all)').verdict).toBe('narrows')
    expect(grade('@@capabilities(all)', '@@capabilities').verdict).toBe('widens')
  })

  it('sees a column opting in and out', () => {
    expect(grade('@@capabilities', '@@capabilities', [false, true]).verdict).toBe('narrows')
    expect(grade('@@capabilities', '@@capabilities', [true, false]).verdict).toBe('widens')
  })

  it('says nothing when nothing moved', () =>
    expect(grade('@@capabilities', '@@capabilities').verdict).toBe('unchanged'))
})

// ─── the rename, and where it is computable ───────────────────────────────────
//
// Step 6. `FJS-D148` rules that a rename emits a data migration and expects it to
// fall out of `diffSchemas`/`autoMigrate`. For a renamed COLUMN it does. For a
// renamed MOVE it cannot, and the first test here is why: the capability set
// changes and the DDL is byte-identical, so the migration engine — which diffs a
// replayed shadow database against a pristine one — reports *no migration needed*
// while every grant row holding the old name goes quiet.
//
// So the blast radius is computed from two SCHEMAS, which is what `--from <ref>`
// already reads, and never from two databases.

import { generateDDL } from '../src/core/ddl.js'
import { capabilityDrift } from '../src/release.js'
import { capabilityNames } from '../src/core/capabilities.js'

const withMoves = (moves: string, model = 'Invoice') => `
enum St { a b c }
model Role { id Int @id @default(autoincrement())  caps Capability[] }
model ${model} {
  id Int @id @default(autoincrement())
  st St @default(a)
  @@capabilities
  @@transitions(st, ${moves})
}`

describe('a renamed move is invisible to the migration engine', () => {
  it('changes the capability set and emits identical DDL', () => {
    // The measurement the design records. Not a defect in the diff — a move name
    // is not a database object, so there is nothing there for it to compare.
    const before = parsed(withMoves('aprove: a -> b'))
    const after  = parsed(withMoves('approve: a -> b'))

    expect(capabilityNames(before).has('Invoice.aprove')).toBe(true)
    expect(capabilityNames(after).has('Invoice.approve')).toBe(true)
    expect(JSON.stringify(generateDDL(before))).toBe(JSON.stringify(generateDDL(after)))
  })
})

describe('capabilityDrift', () => {
  const surf  = (src: string) => deriveReleaseSurface(parsed(src))
  const drift = (a: string, b: string) => capabilityDrift(surf(a), surf(b))

  it('pairs a single rename on one model, and writes the rewrite', () => {
    const d = drift(withMoves('aprove: a -> b'), withMoves('approve: a -> b'))
    expect(d.lost).toEqual(['Invoice.aprove'])
    expect(d.renames).toEqual([{ from: 'Invoice.aprove', to: 'Invoice.approve', why: 'aprove → approve on Invoice' }])
    expect(d.sql).toEqual([
      `UPDATE "role" SET "caps" = replace("caps", '"Invoice.aprove"', '"Invoice.approve"') ` +
      `WHERE "caps" LIKE '%"Invoice.aprove"%';`,
    ])
  })

  it('pairs a whole model whose prefix moved with its targets intact', () => {
    const d = drift(withMoves('issue: a -> b'), withMoves('issue: a -> b', 'Bill'))
    expect(d.renames.map(r => `${r.from}→${r.to}`).sort()).toEqual([
      'Invoice.create→Bill.create', 'Invoice.delete→Bill.delete',
      'Invoice.issue→Bill.issue', 'Invoice.update→Bill.update',
    ])
    expect(d.sql).toHaveLength(4)
  })

  it('refuses to guess when two names move at once', () => {
    // A lost name and a gained name are a rename in the author's head and a
    // coincidence in the data. A wrong rewrite hands one role another's
    // authority and looks exactly like it worked.
    const d = drift(withMoves('aprove: a -> b, cancl: b -> c'), withMoves('approve: a -> b, cancel: b -> c'))
    expect(d.renames).toEqual([])
    expect(d.ambiguous).toEqual(['Invoice.aprove', 'Invoice.cancl'])
    expect(d.sql).toEqual([])
  })

  it('reports a genuine removal as unpaired rather than inventing a rename', () => {
    const d = drift(withMoves('issue: a -> b, cancel: b -> c'), withMoves('issue: a -> b'))
    expect(d.lost).toEqual(['Invoice.cancel'])
    expect(d.ambiguous).toEqual(['Invoice.cancel'])
    expect(d.sql).toEqual([])
  })

  it('finds every column that holds grants, since the rewrite runs in all of them', () => {
    const d = drift(withMoves('aprove: a -> b'), `
      ${withMoves('approve: a -> b')}
      model Team { id Int @id @default(autoincrement())  granted Capability[] }`)
    expect(d.columns.map(c => `${c.table}.${c.column}`).sort()).toEqual(['role.caps', 'team.granted'])
    expect(d.sql).toHaveLength(2)
  })

  it('says nothing when nothing moved', () => {
    const d = drift(withMoves('issue: a -> b'), withMoves('issue: a -> b'))
    expect(d.lost).toEqual([])
    expect(d.sql).toEqual([])
  })
})
