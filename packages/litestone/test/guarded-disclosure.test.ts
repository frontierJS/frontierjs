// guarded-disclosure.test.ts — a refusal may not hand over a @guarded name.
//
// `FJS-D205` keeps @guarded/@secret out of the client's JSON Schema, so the
// static bundle never carries the name. The validation refusals did: measured as
// `Sortable: createdAt, email, id, notes, ssn` answered to `$setAuth(null)` on a
// model whose gate refused that same caller a legitimate read one line later
// (`FJS-914`). Two owners, opposite answers.
//
// What is asserted here is DISCLOSURE and never legality. Whether a key is valid
// is a question about the schema — `$checkWhere` says so in as many words, and
// every flavor of client must answer it identically or one caller's standing
// decides another's 400. Naming a guarded column exactly is still refused by the
// guarded protection, in its own sentence, and that is not this file's business.
//
// Every row is a PAIR. A build that named no column at all would satisfy any
// test that only asked about the refusal, so each hidden name is asserted beside
// the same call as `asSystem()`, which must still see it. And both MESSAGE
// BRANCHES are covered: a key with no near match prints the list, a key one
// character away prints a suggestion instead — `sn` suggested `ssn` before this,
// and the suggestion is the branch a real typo actually takes.

import { test, expect, describe } from 'bun:test'
import { createClient } from '../src/core/client.js'

const SCHEMA = `
database main { path ":memory:" }

model Customer {
  id     String  @id @default(cuid())
  email  String  @unique
  notes  String?
  ssn    String? @guarded

  @@gate("1.1.5.9")
}
`

// No @guarded anywhere — the control for the whole file. A model that hides
// nothing must answer every caller identically, or the filter is firing on
// something other than @guarded.
const OPEN_SCHEMA = `
database main { path ":memory:" }

model Widget {
  id    String  @id @default(cuid())
  email String  @unique
  notes String?
}
`

const client = () => createClient({ schema: SCHEMA, resolveFrom: import.meta.dir })

/** The message a call refuses with, or '' when it does not refuse. */
async function refusal(c: any, args: unknown, method = 'findMany'): Promise<string> {
  try { await c.customer[method](args); return '' }
  catch (e) { return String((e as Error).message) }
}

describe('a refusal does not name a @guarded column (FJS-914)', () => {

  test('orderBy, no near match — the list branch', async () => {
    const db = await client()
    const seen   = await refusal(db.$setAuth(null),        { orderBy: { zqxwvu: 'asc' } })
    const system = await refusal(db.asSystem(),            { orderBy: { zqxwvu: 'asc' } })

    expect(seen).toContain('Sortable: ')
    expect(seen).not.toContain('ssn')
    // The pair: the same call as the system context still names it, so the
    // filter is narrowing an audience rather than emptying the list.
    expect(system).toContain('ssn')
    // And what a client MAY sort by is still offered, or the fix is a mute.
    expect(seen).toContain('email')
    expect(seen).toContain('notes')
  })

  test('orderBy, one character away — the suggestion branch', async () => {
    const db = await client()
    const guarded   = await refusal(db.$setAuth(null), { orderBy: { ssm:    'asc' } })
    const ordinary  = await refusal(db.$setAuth(null), { orderBy: { notess: 'asc' } })

    // The branch a real typo takes. Filtering the list and not this one closes
    // the door nobody uses.
    expect(guarded).not.toContain('ssn')
    // The pair: a typo on a column the caller MAY sort by is still helped.
    expect(ordinary).toContain('Did you mean: notes?')
  })

  test('where, both branches', async () => {
    const db = await client()
    const list       = await refusal(db.$setAuth(null), { where: { zqxwvu: 'x' } })
    const suggestion = await refusal(db.$setAuth(null), { where: { ssm:    'x' } })
    const system     = await refusal(db.asSystem(),     { where: { zqxwvu: 'x' } })
    const ordinary   = await refusal(db.$setAuth(null), { where: { notess: 'x' } })

    expect(list).toContain('Valid fields: ')
    expect(list).not.toContain('ssn')
    expect(suggestion).not.toContain('ssn')
    expect(system).toContain('ssn')
    expect(ordinary).toContain('Did you mean: notes?')
  })

  test('the bridges junction answers a 400 from hide it from EVERY caller', async () => {
    // These two are called synchronously, outside any call in progress, so
    // `ctx.isSystem` has nothing to answer with — the same rule that makes
    // `checkGuarded` a deferred `() =>` rather than a value. So the bridges
    // cannot tell the flavors apart and narrow for all of them, which is the
    // safe direction and the right one: the bridge exists to answer *what may
    // a boundary tell a caller*, and a boundary's caller is never the system
    // context. An app describing its own schema as system reads the schema.
    const db     = await client()
    const anon   = db.$setAuth(null)
    const system = db.asSystem()

    for (const [label, c] of [['anon', anon], ['system', system]] as const) {
      const where = c.$checkWhere('customer', { zqxwvu: 'x' })
      const order = c.$checkOrderBy('customer', { zqxwvu: 'asc' })
      expect(where[0]!.allowed,  label).not.toContain('ssn')
      expect(order[0]!.sortable, label).not.toContain('ssn')
      // Paired, or a bridge answering nothing would pass both lines above.
      expect(where[0]!.allowed,  label).toContain('email')
      expect(order[0]!.sortable, label).toContain('email')
    }
  })

  test('a model that guards nothing answers every caller the same', async () => {
    // The control for the file. If this diverges the filter is keying on
    // something other than @guarded, and every assertion above means less.
    const db = await createClient({ schema: OPEN_SCHEMA, resolveFrom: import.meta.dir })
    const anon   = db.$setAuth(null).$checkOrderBy('widget', { zqxwvu: 'asc' })
    const system = db.asSystem().$checkOrderBy('widget',     { zqxwvu: 'asc' })
    expect(anon[0]!.sortable).toEqual(system[0]!.sortable)
    expect(anon[0]!.sortable).toContain('notes')
    expect(anon[0]!.sortable).toContain('email')
  })
})
