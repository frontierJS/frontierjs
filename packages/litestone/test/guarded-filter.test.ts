// `@guarded` on the way IN — a caller may not NAME the column either.
//
// The attribute locks a column in both directions, and the read half used to be
// only a strip: the value never came back, and the same caller could still put
// the column in a `where` or an `orderBy`. That recovers it. The extraction
// below is the measurement that opened `FJS-393` — eleven characters of an SSN,
// one `startsWith` each, against a client that reads the row and sees no `ssn`
// at all — and an `orderBy` leaks the ordering of every row in one request
// rather than one character.
//
// **The walk crosses relations, because the filter grammar does.** A guarded
// column is reachable through `where: { author: { is: { … } } }`, through a
// relation `orderBy`, and through a nested `include` — three ways of asking a
// question of a model this table is not. So the refusal is per model and the
// suite asserts each crossing rather than the flat case alone.
//
// What this is NOT: a statement about which columns can be compared. That is
// `filterableKeysFor`, a fact about the schema, and it is why `$checkWhere` may
// be asked of any flavor of client and answers the same thing every time. This
// asks who is asking, so `asSystem()` still filters and sorts freely.

import { describe, it, expect } from 'bun:test'
import { createClient, AccessDeniedError } from '../src/index.js'

const SCHEMA = `
model User {
  id    Int     @id
  name  String
  ssn   String? @guarded
  token String? @secret
  posts Post[]
}

model Post {
  id       Int    @id
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}

model Plain {
  id   Int    @id
  name String
}
`

const KEY = 'a'.repeat(64)

async function seeded() {
  const db  = await createClient({ schema: SCHEMA, db: ':memory:', encryptionKey: KEY })
  const sys = db.asSystem()
  await sys.user.create({ data: { id: 1, name: 'ada', ssn: '123-45-6789', token: 'sk_live_abc' } })
  await sys.user.create({ data: { id: 2, name: 'bea', ssn: '987-65-4321', token: 'sk_live_xyz' } })
  await sys.post.create({ data: { id: 1, title: 'p', authorId: 1 } })
  return { db, sys, as: db.$setAuth({ id: 1 }) }
}

const refuses = async (fn: () => Promise<unknown>) => {
  try { await fn() } catch (e) { return e }
  return null
}

describe('@guarded — the value cannot be recovered by asking about it', () => {
  it('does not answer the column to the caller in the first place', async () => {
    const { as } = await seeded()
    const row = await as.user.findUnique({ where: { id: 1 } })
    expect(row.name).toBe('ada')
    expect('ssn' in row).toBe(false)
  })

  it('refuses the character-at-a-time extraction that opened FJS-393', async () => {
    const { as } = await seeded()
    // The attack: one request per candidate character, the match telling you
    // which one was right. It reached the whole SSN before this refusal existed.
    const err = await refuses(() => as.user.findFirst({ where: { ssn: { startsWith: '1' } } }))
    expect(err).toBeInstanceOf(AccessDeniedError)
    expect(err.message).toContain('ssn')
    expect(err.message).toContain('@guarded')
  })

  it('refuses an orderBy, which leaks every row at once rather than one character', async () => {
    const { as } = await seeded()
    expect(await refuses(() => as.user.findMany({ orderBy: { ssn: 'asc' } }))).toBeInstanceOf(AccessDeniedError)
  })

  it('covers @secret, which was protected only by the encryption under it', async () => {
    const { as } = await seeded()
    // @secret expands to @encrypted @guarded. The filter refusal it used
    // to get was the ENCRYPTED half — ciphertext under a random IV can never
    // equal a plaintext — which says nothing about the guard and does not
    // extend to a sort.
    expect(await refuses(() => as.user.findMany({ orderBy: { token: 'asc' } }))).toBeInstanceOf(AccessDeniedError)
    expect(await refuses(() => as.user.findMany({ where: { token: 'sk_live_abc' } }))).toBeInstanceOf(AccessDeniedError)
  })
})

describe('@guarded — every shape a caller can name a column in', () => {
  const shapes: Record<string, (as: any) => Promise<unknown>> = {
    'where on a read':        as => as.user.findMany({ where: { ssn: '1' } }),
    'where nested in OR':     as => as.user.findMany({ where: { OR: [{ name: 'ada' }, { ssn: { startsWith: '1' } }] } }),
    'where nested in NOT':    as => as.user.findMany({ where: { NOT: { ssn: { startsWith: '1' } } } }),
    'findUnique':             as => as.user.findUnique({ where: { ssn: '123-45-6789' } }),
    'count':                  as => as.user.count({ where: { ssn: { startsWith: '1' } } }),
    'exists':                 as => as.user.exists({ where: { ssn: { startsWith: '1' } } }),
    'orderBy':                as => as.user.findMany({ orderBy: { ssn: 'asc' } }),
    'cursor':                 as => as.user.findManyCursor({ cursor: { ssn: '1' }, limit: 1 }),
    // A write's `where` is the same oracle with the row count as the answer.
    'where on a write':       as => as.user.updateMany({ where: { ssn: { startsWith: '1' } }, data: { name: 'x' } }),
    'where on a delete':      as => as.user.deleteMany({ where: { ssn: { startsWith: '1' } } }),
    // Across a relation — a model this table is not.
    'relation filter':        as => as.post.findMany({ where: { author: { is: { ssn: { startsWith: '1' } } } } }),
    'relation orderBy':       as => as.post.findMany({ orderBy: { author: { ssn: 'asc' } } }),
    'include where':          as => as.post.findMany({ include: { author: { where: { ssn: { startsWith: '1' } } } } }),
    'include orderBy':        as => as.user.findMany({ include: { posts: { orderBy: { author: { ssn: 'asc' } } } } }),
    'query dispatcher':       as => as.query({ u: { model: 'user', where: { ssn: { startsWith: '1' } } } }),
  }

  for (const [shape, run] of Object.entries(shapes)) {
    it(`refuses ${shape}`, async () => {
      const { as } = await seeded()
      const err = await refuses(() => run(as))
      expect(err).toBeInstanceOf(AccessDeniedError)
      expect(err.model).toBe('User')
      expect(err.operation).toBe('read')
    })
  }
})

describe('@guarded — what must keep working', () => {
  it('asSystem() filters and sorts by it', async () => {
    const { sys } = await seeded()
    const rows = await sys.user.findMany({ where: { ssn: { startsWith: '123' } }, orderBy: { ssn: 'asc' } })
    expect(rows.map(r => r.id)).toEqual([1])
    expect(rows[0].ssn).toBe('123-45-6789')
  })

  it('leaves every other column of the same model alone', async () => {
    const { as } = await seeded()
    const rows = await as.user.findMany({ where: { name: { startsWith: 'a' } }, orderBy: { name: 'asc' } })
    expect(rows.map(r => r.name)).toEqual(['ada'])
  })

  it('leaves a relation filter that names no guarded column alone', async () => {
    const { as } = await seeded()
    const rows = await as.post.findMany({ where: { author: { is: { name: 'ada' } } } })
    expect(rows.length).toBe(1)
  })

  it('leaves an include that names no guarded column alone', async () => {
    const { as } = await seeded()
    const rows = await as.user.findMany({ include: { posts: { orderBy: { title: 'asc' } } } })
    expect(rows[0].posts.length).toBe(1)
  })

  it('does not read a typed-Json path as a column of the same name', async () => {
    // The walk descends into a relation key and a logical operator, and nothing
    // else. A nested object under an ordinary column is a Json path, where a key
    // sharing a guarded column's name means something else entirely.
    const db = await createClient({ db: ':memory:', schema: `
      type Meta { ssn String }
      model Doc {
        id   Int     @id
        meta Json    @type(Meta)
        ssn  String? @guarded
      }
    ` })
    await db.asSystem().doc.create({ data: { id: 1, meta: { ssn: 'not-the-column' }, ssn: 'real' } })
    const as   = db.$setAuth({ id: 1 })
    const rows = await as.doc.findMany({ where: { meta: { ssn: 'not-the-column' } } })
    expect(rows.map(r => r.id)).toEqual([1])
  })

  it('costs a model with no guarded column nothing to decide', async () => {
    const { as } = await seeded()
    // `reaches` is false for Plain — no guarded column on it and none reachable
    // through any relation — so the walk never runs.
    expect((await as.plain.findMany({ where: { name: 'x' } })).length).toBe(0)
  })
})

describe('@guarded — filterability is still a fact about the schema', () => {
  it('$checkWhere and $checkOrderBy answer the same on every flavor of client', async () => {
    const { db, sys, as } = await seeded()
    // These say whether a column CAN be compared, which is why junction may ask
    // them of a caller's own client. Making them auth-dependent would give one
    // question two answers.
    for (const c of [db, sys, as]) {
      expect(c.$checkWhere('user', { ssn: 'x' })).toEqual([])
      expect(c.$checkOrderBy('user', { ssn: 'asc' })).toEqual([])
    }
  })

  it('still names the guarded column as protected', async () => {
    const { as } = await seeded()
    expect(as.$protectedFields('user').ssn).toBe('guarded')
  })
})

describe('@guarded — a credential lookup is a system read', () => {
  // A Session, Invitation or ApiKey token is `@guarded` and found BY its
  // value, so this is the one legitimate `where` over a guarded column. It goes
  // through asSystem() — auth and basecamp already did, and the alternative
  // (allowing bare equality on a caller's client) would keep them working while
  // leaving the hole open for anything low-entropy, which is what a probe
  // enumerates one guess at a time.
  const TOKENS = `
    model Invite {
      id    Int    @id
      email String
      token String @unique @guarded
    }
  `

  it('finds a row by its token through asSystem()', async () => {
    const db = await createClient({ schema: TOKENS, db: ':memory:' })
    await db.asSystem().invite.create({ data: { id: 1, email: 'a@b.c', token: 'tok_abc' } })
    const found = await db.asSystem().invite.findFirst({ where: { token: 'tok_abc' } })
    expect(found.email).toBe('a@b.c')
  })

  it('refuses the same lookup on a caller-scoped client', async () => {
    const db = await createClient({ schema: TOKENS, db: ':memory:' })
    await db.asSystem().invite.create({ data: { id: 1, email: 'a@b.c', token: 'tok_abc' } })
    const err = await refuses(() => db.$setAuth({ id: 1 }).invite.findFirst({ where: { token: 'tok_abc' } }))
    expect(err).toBeInstanceOf(AccessDeniedError)
  })
})
