// @rank(scope:) — a position a person drags (FJS-D366).
//
// Every behavior below is one the linear and notion stressors wrote in app code
// and got wrong at least once: a literal default put 46 seeded rows on one key,
// a midpoint split by two devices tied, and nothing owned the rewrite once keys
// grew. Expected keys are written out by hand, never read back from the
// toolbelt functions the client calls, so a change to how a key is minted fails
// here rather than agreeing with itself.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'
import { generateJsonSchema } from '../src/jsonschema.js'

const SCHEMA = `
model Issue {
  id       Int     @id
  title    String
  stateId  Int?
  parentId Int?
  rank     String  @rank(scope: [stateId, parentId])
  version  Int     @version
}`

type Row = { id: number; stateId: number | null; parentId: number | null; rank: string; version: number }
type Table = { [m: string]: (a?: unknown) => Promise<any> }

async function client(schema = SCHEMA) {
  const db = await createClient({ schema, db: ':memory:' }) as any
  return { db, issue: db.asSystem().issue as Table }
}

const ids = (rows: Row[]) => rows.map(r => r.id)
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)))

describe('@rank parses and refuses by name', () => {
  it('takes one column or a list', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].fields.find((f: any) => f.name === 'rank').attributes[0]
    expect(attr).toEqual({ kind: 'rank', scope: ['stateId', 'parentId'] })
    expect(parse(`model A { id Int @id  s Int  rank String @rank(scope: s) }`).valid).toBe(true)
  })

  const refused: [string, string, RegExp][] = [
    ['a bare @rank',          `model A { id Int @id  rank String @rank }`,                                  /needs the columns it orders within/],
    ['an optional column',    `model A { id Int @id  s Int  rank String? @rank(scope: s) }`,                /non-optional String/],
    ['an Int column',         `model A { id Int @id  s Int  rank Int @rank(scope: s) }`,                    /requires a String field/],
    ['a scope that is absent', `model A { id Int @id  rank String @rank(scope: nope) }`,                    /'nope' does not exist/],
    ['a scope of itself',     `model A { id Int @id  rank String @rank(scope: rank) }`,                     /names the rank column itself/],
    ['a second owner',        `model A { id Int @id  s Int  rank String @default("V") @rank(scope: s) }`,   /conflicts with @default/],
    ['a relation as scope',   `model B { id Int @id  a A[] }
                               model A { id Int @id  bId Int  b B @relation(fields: [bId], references: [id])  rank String @rank(scope: b) }`,
                              /not a stored scalar column; a scope names the foreign key/],
  ]
  for (const [label, src, msg] of refused) {
    it(label, () => {
      let errors: string[] = []
      try { errors = parse(src).errors ?? [] } catch (e) { errors = [String((e as Error).message)] }
      expect(errors.join('\n')).toMatch(msg)
    })
  }
})

describe('a create with no key lands at the end of its scope', () => {
  it('each scope counts on its own, and NULL is one scope', async () => {
    const { issue } = await client()
    for (const [id, stateId, parentId] of [[1, 1, null], [2, 1, null], [3, 2, null], [4, 1, 7], [5, null, null], [6, null, null], [7, 1, null]])
      await issue.create({ data: { id, title: `t${id}`, stateId, parentId } })
    const rank = async (id: number) => (await issue.findUnique({ where: { id } })).rank
    expect([await rank(1), await rank(2), await rank(7)]).toEqual(['V', 'W', 'X'])
    expect(await rank(3)).toBe('V')
    expect(await rank(4)).toBe('V')
    // Two rows whose scope is all NULL share one — a UNIQUE would have put
    // each in a scope of its own, and both on 'V'.
    expect([await rank(5), await rank(6)]).toEqual(['V', 'W'])
  })

  it('a stated key is taken, and the next default lands after it', async () => {
    const { issue } = await client()
    await issue.create({ data: { id: 1, title: 'a', stateId: 1, rank: 'k' } })
    const b = await issue.create({ data: { id: 2, title: 'b', stateId: 1 } })
    expect(b.rank).toBe('l')
  })

  it('creates that race in one scope get distinct keys', async () => {
    const { issue } = await client()
    const made = await Promise.all(Array.from({ length: 20 }, (_, i) => issue.create({ data: { id: i + 1, title: 'x', stateId: 1 } })))
    expect(new Set(made.map((r: Row) => r.rank)).size).toBe(20)
  })

  it('createMany keys a batch in order, each row after the last', async () => {
    const { issue } = await client()
    await issue.create({ data: { id: 1, title: 'a', stateId: 1 } })
    await issue.createMany({ data: [
      { id: 2, title: 'b', stateId: 1 },
      { id: 3, title: 'c', stateId: 2 },
      { id: 4, title: 'd', stateId: 1 },
    ] })
    const rows = await issue.findMany({ orderBy: [{ stateId: 'asc' }, { rank: 'asc' }] })
    expect(rows.map((r: Row) => `${r.id}:${r.rank}`)).toEqual(['1:V', '2:W', '4:X', '3:V'])
  })

  it('a key that is not one the toolbelt could mint is refused', async () => {
    const { issue } = await client()
    for (const rank of ['a0', '', 'a-b', 'é'])
      await expect(issue.create({ data: { id: 1, title: 'x', stateId: 1, rank } })).rejects.toThrow(/must be a rank key/)
  })

  it('a scope whose last key is not a rank key refuses the default and names rebalance()', async () => {
    // A key written before the column declared @rank, as notion's literal
    // @default("a0") left every row.
    const ranked = await createClient({ schema: SCHEMA, db: ':memory:' }) as any
    const issue = ranked.asSystem().issue
    await issue.create({ data: { id: 1, title: 'legacy', stateId: 1, rank: 'V' } })
    await ranked.asSystem().sql`UPDATE issue SET rank = 'a0' WHERE id = 1`
    await expect(issue.create({ data: { id: 2, title: 'next', stateId: 1 } }))
      .rejects.toThrow(/"a0", which is not a rank key.*rebalance/)
    // And the remedy it names works.
    await issue.rebalance({ where: { stateId: 1 } })
    expect((await issue.create({ data: { id: 2, title: 'next', stateId: 1 } })).rank).toBe('W')
  })
})

describe('an update moving a row to another scope', () => {
  async function three() {
    const c = await client()
    for (const [id, stateId] of [[1, 1], [2, 1], [3, 2]]) await c.issue.create({ data: { id, title: 'x', stateId } })
    return c
  }

  it('without a key lands at the end of the new scope', async () => {
    const { issue } = await three()
    const moved = await issue.update({ where: { id: 1 }, data: { stateId: 2 } })
    expect(moved.rank).toBe('W')
    expect(moved.version).toBe(2)
  })

  it('naming the scope it is already in does not move it', async () => {
    const { issue } = await three()
    const same = await issue.update({ where: { id: 1 }, data: { stateId: 1, title: 'edited' } })
    expect(same.rank).toBe('V')
  })

  it('stating both is taken as written', async () => {
    const { issue } = await three()
    const moved = await issue.update({ where: { id: 2 }, data: { stateId: 2, rank: 'G' } })
    expect(moved.rank).toBe('G')
  })

  it('moving one member of a list scope reads the rest off the row', async () => {
    const { issue } = await three()
    await issue.create({ data: { id: 4, title: 'child', stateId: 1, parentId: 9 } })
    const moved = await issue.update({ where: { id: 1 }, data: { parentId: 9 } })
    expect(moved.rank).toBe('W')
  })

  it('updateMany is refused by name, because one statement gives every row one key', async () => {
    const { issue } = await three()
    await expect(issue.updateMany({ where: { stateId: 1 }, data: { stateId: 3 } }))
      .rejects.toThrow(/updateMany moves rows to another stateId \+ parentId without stating rank/)
    // Nothing moved.
    expect(await issue.count({ where: { stateId: 1 } })).toBe(2)
    // A bulk write that leaves the scope alone is untouched by the rule.
    expect(await issue.updateMany({ where: { stateId: 1 }, data: { title: 'y' } })).toEqual({ count: 2 })
  })
})

describe('upsertMany', () => {
  it('a conflicting row keeps its key unless the conflict moves its scope', async () => {
    const { issue } = await client()
    for (const id of [1, 2]) await issue.create({ data: { id, title: 'x', stateId: 1 } })
    await issue.upsertMany({ data: [
      { id: 1, title: 'same scope', stateId: 1 },
      { id: 2, title: 'moved',      stateId: 2 },
      { id: 3, title: 'new',        stateId: 1 },
    ] })
    const rows = await issue.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: Row) => `${r.id}:${r.stateId}:${r.rank}`)).toEqual(['1:1:V', '2:2:V', '3:1:Y'])
  })
})

describe('a read sorted by the rank ties on the key, in the same direction', () => {
  it('two rows on one key come back in id order, both ways', async () => {
    const { issue } = await client()
    for (const [id, rank] of [[3, 'W'], [1, 'W'], [2, 'V'], [4, 'X']] as const)
      await issue.create({ data: { id, title: 'x', stateId: 1, rank } })
    expect(ids(await issue.findMany({ orderBy: { rank: 'asc' } }))).toEqual([2, 1, 3, 4])
    expect(ids(await issue.findMany({ orderBy: { rank: 'desc' } }))).toEqual([4, 3, 1, 2])
    expect(ids(await issue.findMany({ orderBy: [{ stateId: 'asc' }, { rank: { dir: 'desc' } }] }))).toEqual([4, 3, 1, 2])
    // An order that names the key itself is taken as written.
    expect(ids(await issue.findMany({ orderBy: [{ rank: 'asc' }, { id: 'desc' }] }))).toEqual([2, 3, 1, 4])
  })
})

describe('rebalance()', () => {
  it('rewrites each scope evenly, keeps the order, and announces each row', async () => {
    const { db, issue } = await client()
    // Ten drops into one gap, the shape that grows keys.
    await issue.create({ data: { id: 1, title: 'x', stateId: 1, rank: 'V' } })
    await issue.create({ data: { id: 2, title: 'x', stateId: 1, rank: 'W' } })
    let hi = 'W'
    for (let id = 3; id <= 12; id++) {
      hi = hi === 'W' ? 'VV' : hi.slice(0, -1) + 'V' + 'V'
      await issue.create({ data: { id, title: 'x', stateId: 1, rank: hi } })
    }
    await issue.create({ data: { id: 20, title: 'other', stateId: 2, rank: 'zzzzzz1' } })
    const before = ids(await issue.findMany({ where: { stateId: 1 }, orderBy: { rank: 'asc' } }))

    const seen: { operation?: string; scope?: string }[] = []
    db.$tapEvents((e: any) => { seen.push(e) })
    await settle()
    seen.length = 0
    const out = await issue.rebalance({ where: { stateId: { in: [1, 2] } } })
    await settle()

    const after = await issue.findMany({ where: { stateId: 1 }, orderBy: { rank: 'asc' } })
    expect(ids(after)).toEqual(before)
    expect(new Set(after.map((r: Row) => r.rank.length))).toEqual(new Set([1]))
    expect((await issue.findUnique({ where: { id: 20 } })).rank).toBe('V')
    expect(out.count).toBe(13)
    expect(seen.filter(e => e.operation === 'update' && e.scope === 'row').length).toBe(13)
    expect((await issue.findUnique({ where: { id: 1 } })).version).toBe(2)
  })

  it('refuses a model with no @rank, and asks which one when there are two', async () => {
    const plain = await createClient({ db: ':memory:', schema: `model Plain { id Int @id  x String }` }) as any
    await expect(plain.asSystem().plain.rebalance({})).rejects.toThrow(/@rank/)
    const two = await createClient({ db: ':memory:', schema: `
      model Card { id Int @id  boardId Int  laneId Int
                   boardRank String @rank(scope: boardId)
                   laneRank  String @rank(scope: laneId) }` }) as any
    await expect(two.asSystem().card.rebalance({})).rejects.toThrow(/name one: rebalance\(\{ where, field \}\)/)
    await two.asSystem().card.create({ data: { id: 1, boardId: 1, laneId: 1 } })
    expect(await two.asSystem().card.rebalance({ field: 'laneRank' })).toEqual({ count: 0 })
  })
})

describe('JSON Schema', () => {
  it('says which column orders the model and what its scope is, and a create need not state it', () => {
    const create = generateJsonSchema(parse(SCHEMA).schema, { mode: 'create' }).$defs.Issue
    expect(create.properties.rank['x-rank']).toEqual({ scope: ['stateId', 'parentId'] })
    expect(create.required).not.toContain('rank')
  })
})

describe('@map', () => {
  it('the default, the move and the tie-break all reach the mapped column', async () => {
    const { issue } = await client(`
      model Issue {
        id      Int    @id
        stateId Int    @map("state_id")
        rank    String @rank(scope: stateId) @map("sort_key")
      }`)
    await issue.create({ data: { id: 1, stateId: 1 } })
    await issue.create({ data: { id: 2, stateId: 1 } })
    expect((await issue.update({ where: { id: 1 }, data: { stateId: 2 } })).rank).toBe('V')
    await issue.upsertMany({ data: [{ id: 2, stateId: 2 }, { id: 3, stateId: 2 }] })
    expect((await issue.findMany({ orderBy: { rank: 'asc' } })).map((r: any) => `${r.id}:${r.rank}`)).toEqual(['1:V', '2:W', '3:X'])
  })
})
