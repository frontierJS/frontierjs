// A `@values` binding, enforced at the Data boundary (`FJS-D120`, `FJS-412`).
//
// The three claims worth testing are not "does it refuse":
//
//   1. The set is resolved through the CALLER'S OWN accessor, so a caller may
//      only pick what they can see and `open` needs no permission concept of
//      its own. A check written against asSystem() would offer every row to
//      everybody and let any caller grow a shared list — and would pass every
//      test that only ever uses one principal.
//   2. `suggested` issues no query at all. Enforcing nothing has to COST
//      nothing, or nobody uses the strength that keeps the list travelling.
//   3. Every write path that carries a payload runs it. Six do; a seventh
//      added later would be silent, so the grid below is read off the client's
//      own source rather than hand-listed.

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '../src/index.js'

const SRC = readFileSync(fileURLToPath(new URL('../src/core/client.js', import.meta.url)), 'utf8')

const SCHEMA = `
model Tag {
  id    Int    @id
  label String @unique
  @@label(label)
}
model Team {
  id   Int    @id
  name String @unique
  gone DateTime?
  @@label(name)
  @@scope(active, gone == null)
}
valueset TaskTag  { source Tag   value label }
valueset Assignee { source Team  value name  scope active }
valueset LiveTag  { source Tag   value label  where "label <> 'retired'" }
model Task {
  id    Int     @id
  title String
  tag   String? @values(TaskTag)
  grow  String? @values(TaskTag, open)
  free  String? @values(TaskTag, suggested)
  who   String? @values(Assignee)
  live  String? @values(LiveTag)
  tags  String[] @values(TaskTag)
}`

async function seeded() {
  const db = await createClient({ schema: SCHEMA, db: ':memory:' })
  await db.tag.createMany({ data: [{ label: 'bug' }, { label: 'chore' }, { label: 'retired' }] })
  await db.team.createMany({ data: [{ name: 'Ada' }, { name: 'Grace', gone: '2020-01-01T00:00:00.000Z' }] })
  return db
}

const err = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null } catch (e: any) { return e }
}

describe('the three strengths', () => {
  it('required refuses a value the set does not hold, naming both', async () => {
    const db = await seeded()
    const e  = await err(() => db.task.create({ data: { title: 'a', tag: 'nope' }, select: false }))
    expect(e.errors).toEqual([{ path: ['tag'], message: 'nope is not in TaskTag' }])
    // The same shape every other rule throws, so it renders in <Form> beside
    // the control rather than as a bare 500.
    expect(e.constructor.name).toBe('ValidationError')
  })

  it('required accepts one it does hold', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', tag: 'bug' }, select: false })
    expect(await db.task.count({ where: { tag: 'bug' } })).toBe(1)
  })

  it('open accepts an unknown value AND joins it to the set', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', grow: 'urgent' }, select: false })
    expect(await db.tag.count({ where: { label: 'urgent' } })).toBe(1)
  })

  it('open creates the row once, not once per write', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', grow: 'urgent' }, select: false })
    await db.task.create({ data: { title: 'b', grow: 'urgent' }, select: false })
    expect(await db.tag.count({ where: { label: 'urgent' } })).toBe(1)
  })

  it('suggested accepts anything and grows nothing', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', free: 'whatever' }, select: false })
    expect(await db.tag.count({ where: { label: 'whatever' } })).toBe(0)
  })

  it('suggested runs NO query — it still passes when the source is unreadable', async () => {
    // The load-bearing half of "enforcing nothing costs nothing". A check that
    // queried and then ignored the answer would pass every other test here.
    const db = await createClient({
      schema: `
        model Tag { id Int @id  label String @unique  @@label(label)  @@gate("8") }
        valueset TaskTag { source Tag value label }
        model Task { id Int @id  title String  free String? @values(TaskTag, suggested) }`,
      db: ':memory:',
    })
    await db.task.create({ data: { title: 'a', free: 'anything' }, select: false })
    expect(await db.task.count({})).toBe(1)
  })
})

describe('what counts as a value', () => {
  it('null clears and is not checked — presence is what `?` says', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', tag: null }, select: false })
    expect(await db.task.count({})).toBe(1)
  })

  it('an absent key is not checked', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a' }, select: false })
    expect(await db.task.count({})).toBe(1)
  })

  it('an array field is checked element by element', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', tags: ['bug', 'chore'] }, select: false })
    const e = await err(() => db.task.create({ data: { title: 'b', tags: ['bug', 'nope'] }, select: false }))
    expect(e.errors[0].message).toBe('nope is not in TaskTag')
  })

  it('every offending field is reported, not the first', async () => {
    const db = await seeded()
    const e  = await err(() => db.task.create({ data: { title: 'a', tag: 'x', who: 'y' }, select: false }))
    expect(e.errors.map((r: any) => r.path[0])).toEqual(['tag', 'who'])
  })
})

describe('the set is a scoped list, not a table', () => {
  it('a @@scope on the source narrows it', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', who: 'Ada' }, select: false })
    const e = await err(() => db.task.create({ data: { title: 'b', who: 'Grace' }, select: false }))
    // Grace is a real row and is out of scope, which from the caller's side is
    // the same fact: she is not in the set.
    expect(e.errors[0].message).toBe('Grace is not in Assignee')
  })

  it('a declared `where` narrows it too', async () => {
    const db = await seeded()
    await db.task.create({ data: { title: 'a', live: 'bug' }, select: false })
    const e = await err(() => db.task.create({ data: { title: 'b', live: 'retired' }, select: false }))
    expect(e.errors[0].message).toBe('retired is not in LiveTag')
  })
})

describe('the set is resolved through the CALLER’S accessor', () => {
  const OWNED = `
    model Tag {
      id      Int    @id
      label   String @unique
      ownerId Int
      @@label(label)
      @@allow('read',   ownerId == auth().id)
      @@allow('create', auth().id == 1)
    }
    valueset TaskTag { source Tag value label }
    model Task {
      id    Int @id
      title String
      tag   String? @values(TaskTag)
      grow  String? @values(TaskTag, open)
    }`

  const owned = async () => {
    const db = await createClient({ schema: OWNED, db: ':memory:' })
    await db.asSystem().tag.createMany({ data: [{ label: 'mine', ownerId: 1 }, { label: 'theirs', ownerId: 2 }] })
    return db
  }

  it('a caller may only pick what their own read policy shows them', async () => {
    const db  = await owned()
    const one = db.$setAuth({ id: 1 })

    await one.task.create({ data: { title: 'a', tag: 'mine' }, select: false })
    const e = await err(() => one.task.create({ data: { title: 'b', tag: 'theirs' }, select: false }))
    expect(e.errors[0].message).toBe('theirs is not in TaskTag')
  })

  it('and the other caller sees the mirror of that', async () => {
    // Both directions, because a check that returned nothing for everybody
    // would pass the test above.
    const db  = await owned()
    const two = db.$setAuth({ id: 2 })

    await two.task.create({ data: { title: 'a', tag: 'theirs' }, select: false })
    expect((await err(() => two.task.create({ data: { title: 'b', tag: 'mine' }, select: false }))).errors[0].message)
      .toBe('mine is not in TaskTag')
  })

  it('asSystem sees the whole table', async () => {
    const db = await owned()
    await db.asSystem().task.create({ data: { title: 'a', tag: 'theirs' }, select: false })
    expect(await db.asSystem().task.count({})).toBe(1)
  })

  it('who may GROW an open set is the source model’s own create policy', async () => {
    // The whole of the permission story: no new concept, no hook tier.
    const db = await owned()
    const e  = await err(() => db.$setAuth({ id: 2 }).task.create({ data: { title: 'a', grow: 'new' }, select: false }))

    expect(e.constructor.name).toBe('ValueSetExtendError')
    expect(e.cause.constructor.name).toBe('AccessDeniedError')
    expect(await db.asSystem().tag.count({ where: { label: 'new' } })).toBe(0)
  })

  it('a failure to grow says what it was doing — the row was never asked for', async () => {
    // A bare `ownerId is required` off a Task write names a column on a model
    // the caller never mentioned, and reads as a bug in the app.
    const db = await owned()
    const e  = await err(() => db.$setAuth({ id: 1 }).task.create({ data: { title: 'a', grow: 'new' }, select: false }))

    expect(e.message).toContain('Could not add "new" to TaskTag')
    expect(e.message).toContain('creating a Tag for it failed')
    expect(e.data).toEqual({ set: 'TaskTag', model: 'Tag', field: 'grow', value: 'new' })
  })
})

describe('every write path that carries a payload runs the check', () => {
  // Read off the client's own source rather than hand-listed: a seventh write
  // path added later would otherwise be silent, which is the failure mode the
  // check itself exists to prevent one layer down.
  // A method carries a payload when it destructures one: `data`, or an alias
  // like `create: createData`. Erring toward MORE methods being caught is the
  // safe direction — a false positive is a grid entry someone has to write, a
  // false negative is a write path nothing checks.
  const declared = [...SRC.matchAll(/^ {4}async (\w+)\(\{([\s\S]*?)\} = \{\}\)/gm)]
    .filter(m => /\b\w*[Dd]ata\b/.test(m[2]))
    .map(m => m[1])

  const grid: Record<string, (db: any) => Promise<unknown>> = {
    create:     db => db.task.create({ data: { title: 'a', tag: 'nope' }, select: false }),
    createMany: db => db.task.createMany({ data: [{ title: 'a', tag: 'bug' }, { title: 'b', tag: 'nope' }] }),
    update:     db => db.task.update({ where: { id: 1 }, data: { tag: 'nope' }, select: false }),
    updateMany: db => db.task.updateMany({ where: {}, data: { tag: 'nope' } }),
    upsert:     db => db.task.upsert({ where: { id: 9 }, create: { id: 9, title: 'a', tag: 'nope' }, update: { title: 'b' } }),
    upsertMany: db => db.task.upsertMany({ data: [{ id: 9, title: 'a', tag: 'nope' }], conflictTarget: ['id'] }),
  }

  it('the grid covers every one the client declares', () => {
    expect(declared.length).toBeGreaterThan(3)
    expect(declared.filter(m => !(m in grid))).toEqual([])
    expect(Object.keys(grid).filter(m => !declared.includes(m))).toEqual([])
  })

  for (const name of Object.keys(grid)) {
    it(`${name} refuses`, async () => {
      const db = await seeded()
      await db.task.create({ data: { id: 1, title: 'seed' }, select: false })
      const e = await err(() => grid[name](db))
      expect(e?.errors?.[0]).toEqual({ path: ['tag'], message: 'nope is not in TaskTag' })
    })
  }
})

// ─── open, against a narrowed set ─────────────────────────────────────────────
//
// `FJS-434`. A value missing from a NARROWED set is two things and only one of
// them may be added: one nobody has ever used, and one the list has deliberately
// stopped offering. Creating the second hits the source's own `@unique` and the
// caller is handed `UNIQUE constraint failed: colour.name` — SQLite's sentence,
// about a table they did not name, saying the opposite of what happened.
//
// Found by putting the feature into `example` rather than by a unit test, which
// is what that exercise is for.

describe('open — a value the set has stopped offering', () => {
  const SCHEMA = `
model Colour {
  id      Int     @id
  name    String  @unique
  retired Boolean @default(false)
  @@label(name)
  @@scope(current, retired == false)
}

valueset ProductColour { source Colour  value name  scope current }

model Variant {
  id     Int    @id
  sku    String @unique
  colour String @values(ProductColour, open)
}
`

  const fresh = async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    await db.colour.create({ data: { name: 'Navy' } })
    await db.colour.create({ data: { name: 'Ochre', retired: true } })
    return db
  }

  it('is refused by name, and says which list stopped offering it', async () => {
    const db = await fresh()
    const err = await db.variant.create({ data: { sku: 'A', colour: 'Ochre' } }).catch(e => e)

    expect(err.name).toBe('ValidationError')
    expect(err.message).toContain('Ochre')
    expect(err.message).toContain('ProductColour')
    // The half that was wrong: not SQLite's, and not about a missing value.
    expect(err.message).not.toContain('UNIQUE constraint')
    expect(err.message).toContain('not offered')
  })

  it('does not grow the list as a side effect of a refused write', async () => {
    const db = await fresh()
    // One batch offering both kinds. `Seafoam` is addable and `Ochre` is not,
    // and the batch is refused — so adding the first one would leave a shared
    // list grown by a write that never landed.
    await db.variant.createMany({ data: [
      { sku: 'A', colour: 'Seafoam' },
      { sku: 'B', colour: 'Ochre' },
    ] }).catch(() => {})

    expect(await db.colour.count()).toBe(2)
    expect(await db.variant.count()).toBe(0)
  })

  it('still adds a value the source has never held', async () => {
    const db = await fresh()
    await db.variant.create({ data: { sku: 'A', colour: 'Seafoam' } })

    expect((await db.colour.findFirst({ where: { name: 'Seafoam' } }))?.retired).toBe(false)
    expect(await db.variant.count()).toBe(1)
  })

  it('costs no extra query where the set is not narrowed', async () => {
    // An unnarrowed set cannot hold a value outside itself, so the second read
    // is skipped rather than asked and thrown away.
    const db = await createClient({
      schema: SCHEMA.replace('  scope current }', ' }').replace('@@scope(current, retired == false)', ''),
      db: ':memory:',
    })
    await db.colour.create({ data: { name: 'Ochre', retired: true } })
    await db.variant.create({ data: { sku: 'A', colour: 'Ochre' } })

    expect(await db.colour.count()).toBe(1)
    expect(await db.variant.count()).toBe(1)
  })
})

// ─── a `where` mints a scope ──────────────────────────────────────────────────
//
// `FJS-430`. A `where` is SQL, and a browser may never send SQL (Invariant 8) —
// so a set narrowed that way used to be narrowed at the Data boundary and
// nowhere else: a picker built from it offered the whole source, the person
// chose a row the set excludes, and the save was refused with nothing before
// that having said the option was not real.
//
// It mints a `@@scope` on the source named after the set. A NAME crosses, is
// looked up in the schema's own table, and compiles to the same SQL — so the
// offered list and the accepted list come from one declaration rather than two
// mechanisms that agree by hand.

describe('a declared `where` becomes a scope with a name', () => {
  const SCHEMA = `
model Tag {
  id    Int     @id
  label String  @unique
  team  String?
  @@label(label)
  @@scope(mine, team == "a")
}

valueset LiveTag { source Tag  value label  where "label <> 'retired'" }

model Post {
  id    Int     @id
  title String
  tag   String? @values(LiveTag)
}
`
  const fresh = async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    for (const label of ['alpha', 'retired', 'beta'])
      await db.tag.create({ data: { label, team: label === 'beta' ? 'b' : 'a' } })
    return db
  }

  it('is published, so a picker can name it and $checkWhere accepts it', async () => {
    const db = await fresh()
    // Listed rather than hidden: a scope missing from the published list is one
    // `$checkWhere` reports as unknown, which is the opposite of usable.
    expect(db.$scopes('tag')).toEqual({ mine: "team == 'a'", LiveTag: "label <> 'retired'" })
    expect(db.$checkWhere('tag', { $scope: 'LiveTag' })).toEqual([])
    expect(db.$checkWhere('tag', { $scope: 'Nope' })[0].message).toContain('LiveTag')
  })

  it('compiles to the predicate it was written as', async () => {
    const db = await fresh()
    expect((await db.tag.findMany({ where: { $scope: 'LiveTag' } })).map(r => r.label)).toEqual(['alpha', 'beta'])
  })

  it('conjoins with a declared scope rather than replacing it', async () => {
    const db = await fresh()
    expect((await db.tag.findMany({ where: { $scope: ['LiveTag', 'mine'] } })).map(r => r.label)).toEqual(['alpha'])
  })

  it('reaches the binding as a name, never as a predicate', async () => {
    const { parse } = await import('../src/core/parser.js')
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const js = generateJsonSchema(parse(SCHEMA).schema)
    const bind = js.$defs.Post.properties.tag['x-values']

    expect(bind.scopes).toEqual(['LiveTag'])
    // The SQL is the one thing that must not travel.
    expect(JSON.stringify(bind)).not.toContain('retired')
  })

  it('narrows the write the same way it narrows the read', async () => {
    const db = await fresh()
    await expect(db.post.create({ data: { id: 1, title: 't', tag: 'retired' } }))
      .rejects.toThrow(/retired is not in LiveTag/)
    await db.post.create({ data: { id: 2, title: 't', tag: 'alpha' } })
    expect(await db.post.count()).toBe(1)
  })

  it('refuses a name the source already uses, rather than shadowing it', async () => {
    const { parse } = await import('../src/core/parser.js')
    const clash = SCHEMA
      .replace('@@scope(mine, team == "a")', '@@scope(LiveTag, team == "a")')
    const p = parse(clash)
    expect(p.valid).toBe(false)
    expect(p.errors.join('\n')).toContain('already declares one')
  })
})
