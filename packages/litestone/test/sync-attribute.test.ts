// sync-attribute.test.ts — `@@sync`, the declaration that a row may be written
// with no server reachable (`FJS-D298`, `IDEAS/homestead.md` phase 1).
//
// Two things are under test and the second is the one worth having.
//
// **The absence is the refusal.** There is no default: a model that says
// nothing emits no `x-sync`, and a client with no answer refuses to queue a
// write against it. So the test that matters is not that `@@sync(server)`
// parses — it is that a model WITHOUT it produces nothing, because a default
// that crept in here would make every model in every app silently syncable and
// the loss would be a row, reported by nobody.
//
// **The closed set is closed by NAME.** One policy exists today and the others
// are real candidates with real designs behind them. A policy that parses and
// resolves nothing reads exactly like one that works, so the refusal lists what
// exists rather than saying the word is wrong — the rule an unknown `mesa:*`
// name already follows.

import { describe, it, test, expect } from 'bun:test'
import { parse }                from '../src/core/parser.js'
import { generateJsonSchema }   from '../src/jsonschema.js'

const model = (attrs: string) => `model M {\n  id Int @id\n  name String\n  @@gate("2")\n${attrs}\n}`

const syncOf = (src: string) =>
  (parse(src).schema.models[0].attributes as any[]).find(a => a.kind === 'sync')?.policy ?? null

// `parse` reports errors as STRINGS — reading `.message` yields undefined and
// every assertion below would compare against ''.
const refusal = (src: string) => {
  const r = parse(src)
  return r.valid ? null : String(r.errors[0] ?? '')
}

const crossing = (src: string) => {
  const r = parse(src)
  return (generateJsonSchema(r.schema) as any).$defs.M['x-sync'] ?? null
}

describe('@@sync', () => {
  it('reads its policy', () => {
    expect(syncOf(model('  @@sync(server)'))).toBe('server')
  })

  it('a model that declares nothing carries no sync attribute', () => {
    expect(syncOf(model(''))).toBe(null)
  })

  it('refuses an unknown policy by name, and says which exist', () => {
    const err = refusal(model('  @@sync(lww)'))
    expect(err).toContain('lww')
    expect(err).toContain('server')
  })

  it('append parses', () => {
    expect(syncOf(model('  @@sync(append)'))).toBe('append')
  })

  // The remaining candidates each need a second writer or a mechanism that does
  // not exist. Pinned so that adding one to the set is a deliberate act with a
  // test to update, rather than a word that slipped in.
  it('the policies with designs behind them are not in the set yet', () => {
    for (const policy of ['lww', 'manual', 'field', 'crdt'])
      expect(refusal(model(`  @@sync(${policy})`))).toContain(policy)
  })

  // ── refuse names a revision, so it needs the column that holds one ──
  //
  // Without `@version` there is nothing for a held write to carry and nothing
  // for the boundary to compare, so the policy would behave exactly as `server`
  // while claiming the opposite — a word that resolves nothing, which is the
  // failure the closed set exists to prevent (`FJS-D298`). Refused at parse
  // rather than advised, on `@@softDelete`'s precedent: the attribute names a
  // column, and a model without it has already lost.
  it('refuse is accepted on a model that declares @version', () => {
    const src = 'model M {\n  id Int @id\n  name String\n  v Int @version\n  @@gate("2")\n  @@sync(refuse)\n}'
    expect(syncOf(src)).toBe('refuse')
  })

  it('refuse without @version is refused, and the message says what to do', () => {
    const err = refusal(model('  @@sync(refuse)'))
    expect(err).toContain('@@sync(refuse) needs an @version field')
    expect(err).toContain('@@sync(server)')
  })

  // The control. `append` is the one of the three that legitimately has no
  // revision — rows are only ever added — so a precondition that fired on every
  // policy would be a rule about nothing.
  it('append needs no @version', () => {
    expect(refusal(model('  @@sync(append)'))).toBe(null)
  })

  it('server needs no @version either', () => {
    expect(refusal(model('  @@sync(server)'))).toBe(null)
  })

  it('needs an argument', () => {
    expect(refusal(model('  @@sync()'))).not.toBe(null)
  })
})

describe('@@sync crosses to the browser', () => {
  it('a declared policy is emitted as x-sync', () => {
    expect(crossing(model('  @@sync(server)'))).toBe('server')
  })

  // The half a default would break. `x-sync` absent is what the client reads as
  // *this model is not syncable*, so an emitter that filled in a value would
  // turn a refusal into a silent acceptance everywhere at once.
  it('an undeclared model emits nothing at all', () => {
    expect(crossing(model(''))).toBe(null)
  })
})

// ─── x-mint ───────────────────────────────────────────────────────────────────
//
// The offline half of `@@sync`: a row written with no server reachable is named
// by its children before any INSERT has happened, so the caller has to be able
// to state the key. Two things have to agree — the create schema must OFFER the
// column, and `x-mint` must say how to fill it — and they are one predicate in
// jsonschema.js precisely because two would drift.

describe('x-mint', () => {
  const defs = (src: string) => generateJsonSchema(parse(src).schema).$defs

  test('a syncable model with a generated id names its generator', () => {
    const d = defs('model S { id String @id @default(uuid())  n String  @@sync(server) }')
    expect(d.S['x-mint']).toEqual({ field: 'id', kind: 'uuid' })
  })

  test('every generator the table has crosses under its own name', () => {
    for (const kind of ['uuid', 'ulid', 'cuid', 'nanoid']) {
      const d = defs(`model S { id String @id @default(${kind}())  n String  @@sync(server) }`)
      expect(d.S['x-mint']).toEqual({ field: 'id', kind })
    }
  })

  test('the same model without @@sync says nothing', () => {
    // The declaration is what makes a client-stated key necessary. Emitting it
    // for every uuid-keyed model would widen the create surface of every app
    // that has one, for a capability none of them asked for.
    const d = defs('model S { id String @id @default(uuid())  n String }')
    expect(d.S['x-mint']).toBeUndefined()
  })

  test('a server-keyed id says nothing even under @@sync', () => {
    const d = defs('model S { id Int @id  n String  @@sync(server) }')
    expect(d.S['x-mint']).toBeUndefined()
  })

  test('a composite key says nothing — minting one member is not minting the key', () => {
    const d = defs('model S { a String @id @default(uuid())  b String @id  n String  @@sync(server) }')
    expect(d.S['x-mint']).toBeUndefined()
  })

  test('the id is offered in create mode, and stays optional', () => {
    // Optional is the whole of it: a create made on the network omits the key
    // and the server assigns it exactly as before (`FJS-608`'s rule, widened by
    // one declaration rather than reversed).
    const d = defs('model S { id String @id @default(uuid())  n String  @@sync(server) }')
    expect(Object.keys(d.S.properties)).toContain('id')
    expect(d.S.required).toEqual(['n'])
  })

  test('without @@sync the id is still subtracted from create mode', () => {
    const d = defs('model S { id String @id @default(uuid())  n String }')
    expect(Object.keys(d.S.properties)).not.toContain('id')
  })
})

// ─── @@sync(read) ─────────────────────────────────────────────────────────────
//
// A model HELD on a device and never written there (`FJS-D488`, `FJS-1280`): a
// roster, a reference table, a published schedule. The word is the same one, so
// a device schema keeps the table; the argument says no write is held, so none
// of the write half's machinery applies — no @version, no client-minted key.

describe('@@sync(read)', () => {
  const defs = (src: string) => generateJsonSchema(parse(src).schema).$defs

  it('parses, and needs no @version', () => {
    expect(refusal(model('  @@sync(read)'))).toBe(null)
    expect(syncOf(model('  @@sync(read)'))).toBe('read')
  })

  it('crosses to the browser as x-sync: read', () => {
    expect(crossing(model('  @@sync(read)'))).toBe('read')
  })

  // The Id box on an employee's form: a client-mintable key on a syncable model
  // becomes a column the client may write, and a held, never-written model has
  // no offline create to name its children.
  it('mints no key, so a create form offers no Id', () => {
    const src = (attr: string) => `model S { id String @id @default(uuid())  n String  @@gate("2")  ${attr} }`
    expect(defs(src('@@sync(server)')).S['x-mint']).toEqual({ field: 'id', kind: 'uuid' })
    expect(defs(src('@@sync(read)')).S['x-mint']).toBeUndefined()
  })

  it('the refusal for an unknown policy lists read', () => {
    expect(refusal(model('  @@sync(lww)'))).toContain('read')
  })
})
