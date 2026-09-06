// tests/unknown-keys.test.ts
//
// A key that names nothing.
//
// `autoValidate` copies the declared properties out of a payload and drops the
// rest, which is mass-assignment protection and is right about most of what it
// drops: `id` on a create, `createdAt`, a `@guarded` column. A client that
// fetches a row, edits one field and PUTs the whole thing back sends all three,
// and refusing them would break every such caller.
//
// It is wrong about the other kind. `{ title, titel: 'typo' }` answered 201
// with the typo gone and nothing said — a write the caller believes happened,
// which is the same harm `FJS-658` named for a dotted key and fixed in the
// other direction.
//
// The two are separated by ONE fact and it is derivable: does the key name a
// field the model declares. `createdAt` does. `titel` does not, and no schema
// change short of adding the column can make it. The set comes off `$schema`
// rather than the generated documents, because `createdAt` and `updatedAt` are
// in NO mode create/update/read emits — measured — so a document-derived set
// would refuse the commonest legitimate echo there is.
//
// Every refusal below is PAIRED with the acceptance of a key that IS a column
// and is dropped in silence (`FJS-351`): a mechanism that refused both would
// look identical from the refused side.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../../litestone/src/index.js'
import { createApp }              from '../src/core/app.ts'
import { createService }          from '../src/core/service.ts'
import { unknownKeys }            from '../src/core/litestone.ts'

const SCHEMA = `
  type PayOrder { reference String  amount Int @gte(1) }

  model Post {
    id        Int      @id
    title     String
    body      String?
    settings  Json?
    secret    String?  @guarded
    draft     String?  @transient
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
  }
`

async function mkApp() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({ db: db as never })
  app.services.register(createService({
    name: 'posts', model: 'Post', db: db as never,
    methods: ['find', 'get', 'create', 'update', 'patch', { method: 'pay', input: 'PayOrder' }],
    async pay(ctx: any) { ctx.dispatch = false; return { got: ctx.data } },
  } as never))
  await app._startForTest()
  return { app, db }
}

const call = (app: any, method: string, id: unknown, data: unknown) =>
  app.service('posts').call(method, id, data as never)

// ─── the derivation ───────────────────────────────────────────────────────

describe('unknownKeys', () => {
  const fields = new Set(['title', 'settings'])

  test('a key that names a field is not unknown', () => {
    expect(unknownKeys({ title: 'x' }, fields)).toEqual([])
  })

  test('a key that names nothing is', () => {
    expect(unknownKeys({ titel: 'x' }, fields)).toEqual(['titel'])
  })

  test('a dotted key is graded on its HEAD — FJS-658 carries it, the Data boundary answers it', () => {
    expect(unknownKeys({ 'settings.commute': 1 }, fields)).toEqual([])
    expect(unknownKeys({ 'nosuch.deep':      1 }, fields)).toEqual(['nosuch.deep'])
  })

  test('the derivation itself grades against whatever set it is handed', () => {
    // The fail-open for a model this cannot see lives in checkUnknownKeys, not
    // here — asserted below as `a service with no model refuses nothing`.
    expect(unknownKeys({ anything: 1 }, new Set())).toEqual(['anything'])
  })

  test('a non-object is not a payload', () => {
    expect(unknownKeys(null, fields)).toEqual([])
    expect(unknownKeys([{ titel: 1 }], fields)).toEqual([])
  })
})

// ─── the refusal, each paired with an acceptance ──────────────────────────

describe('a key that names nothing is refused', () => {

  test('a typo on create is a 400 naming it', async () => {
    const { app } = await mkApp()
    expect(call(app, 'create', null, { title: 'a', titel: 'x' }))
      .rejects.toThrow(/titel: is not a field of Post/)
  })

  test('…and the same request without it is a 201', async () => {
    const { app } = await mkApp()
    const row = await call(app, 'create', null, { title: 'a' }) as any
    expect(row.title).toBe('a')
  })

  test('a column the caller MAY NOT WRITE is still stripped in silence', async () => {
    // The pair that makes the refusal meaningful. `id` on a create and
    // `createdAt` are both real columns and both absent from every document
    // the generator emits — a client that fetched a row, edited one field and
    // PUT the whole thing back sends them on every write.
    const { app } = await mkApp()
    const row = await call(app, 'create', null,
      { title: 'a', id: 99, createdAt: '2020-01-01T00:00:00Z', secret: 'shh' }) as any
    expect(row.title).toBe('a')
    expect(row.id).not.toBe(99)
  })

  test('a @transient key is accepted — it is a declared field', async () => {
    // And it is the escape the refusal names, so this is what makes that
    // sentence true rather than advice.
    const { app } = await mkApp()
    const row = await call(app, 'create', null, { title: 'b', draft: 'd' }) as any
    expect(row.title).toBe('b')
  })

  test('a dotted key into a declared field is carried, per FJS-658', async () => {
    const { app } = await mkApp()
    const made = await call(app, 'create', null, { title: 'c' }) as any
    // Refused by the Data boundary in ITS words, never by this — the point of
    // FJS-658 is that the sentence names the column's type, which only
    // litestone knows.
    await call(app, 'patch', made.id, { 'settings.commute': 1 }).catch(() => {})
    expect(call(app, 'patch', made.id, { 'nosuch.deep': 1 }))
      .rejects.toThrow(/nosuch\.deep: is not a field of Post/)
  })

  test('a declared input type refuses in its own words', async () => {
    const { app } = await mkApp()
    expect(call(app, 'pay', null, { reference: 'r', amount: 1, amont: 2 }))
      .rejects.toThrow(/amont: is not a field of type PayOrder/)
  })

  test('…and accepts exactly what the type declares', async () => {
    const { app } = await mkApp()
    const out = await call(app, 'pay', null, { reference: 'r', amount: 1 }) as any
    expect(out.got).toEqual({ reference: 'r', amount: 1 })
  })

  test('a bulk write PARTITIONS rather than failing wholesale', async () => {
    // Per row for the same reason every other row error is: one typo in row
    // ninety must not cost the other ninety-nine.
    const db  = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    app.services.register(createService({
      name: 'posts', model: 'Post', db: db as never, allowBulk: true,
    } as never))
    await app._startForTest()

    const out = await app.service('posts').call('create', null,
      [{ title: 'ok' }, { title: 'bad', titel: 'x' }] as never) as any
    expect(out.data).toHaveLength(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].error.message).toMatch(/titel/)
  })

  test('a service with no model refuses nothing — the set is empty and it fails OPEN', async () => {
    const db  = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    const seen: unknown[] = []
    app.services.register(createService({
      name: 'reports',
      methods: ['run'],
      async run(ctx: any) { seen.push(ctx.data); ctx.dispatch = false; return { ok: true } },
    } as never))
    await app._startForTest()

    await app.service('reports').call('run', null, { anything: 1 } as never)
    expect(seen[0]).toEqual({ anything: 1 })
  })
})
