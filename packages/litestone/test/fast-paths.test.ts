// test/fast-paths.test.ts
// findUnique by primary key and findMany({}) run one precompiled statement
// when no read rule but soft delete adds to the model's where — asked per
// model through READ_RULES' `narrows`, not client-wide. A client-wide
// `hasPolicies`/`hasPlugins` had turned both off for every model as soon as
// one model in the schema declared a gate, which is every real app.
//
// What running them with a plugin installed must keep: the gate's refusal
// (beforeRead), a plugin's afterRead, a plugin's read filter, and a
// beforeRead that rewrites the args. And the same `narrows` lets a write skip
// hiddenParents' exists() for a parent nothing can hide.
//
// Traps in this file:
//   • Which path ran is NOT readable off the SQL: the fold builds the same
//     statement for a plain lookup. It is read off the args instead — the
//     fold asks for `onlyTemplates` to refuse it by name on a model with no
//     templates, and the precompiled statement folds nothing.

import { describe, it, expect } from 'bun:test'
import { createClient, GatePlugin, LEVELS, Plugin } from '../src/index.js'

const SCHEMA = `
model Author {
  id    Int    @id
  name  String
  posts Post[]
}

model Post {
  id       Int    @id
  title    String
  authorId Int
  author   Author @relation(fields: [authorId], references: [id])
}

model Secret {
  id    Int    @id
  label String
  @@gate("8.8.8.8")
}

model Draft {
  id        Int       @id
  title     String
  deletedAt DateTime?
  @@softDelete
}
`

async function open(plugins: any[], sql: string[] = []) {
  const db = await createClient({ schema: SCHEMA, db: ':memory:', plugins, onQuery: (e: any) => sql.push(e.sql) })
  const sys = db.asSystem()
  await sys.author.create({ data: { id: 1, name: 'A' } })
  await sys.post.create({ data: { id: 1, title: 'P', authorId: 1 } })
  await sys.secret.create({ data: { id: 1, label: 'S' } })
  await sys.draft.create({ data: { id: 1, title: 'D' } })
  sql.length = 0
  return db
}

const user = { id: 9 }
const gate = () => new GatePlugin({ getLevel: () => LEVELS.USER })
// The keys a call read from its args.
function watched(args: any) {
  const read = new Set<string>()
  const proxy = new Proxy(args, { get(t, k) { if (typeof k === 'string') read.add(k); return t[k] } })
  return { proxy, folded: () => read.has('onlyTemplates') }
}

describe('the fast paths in an app with a gate', () => {
  it('a model with no gate of its own takes them', async () => {
    const db = (await open([gate()])).$setAuth(user)
    const unique = watched({ where: { id: 1 } })
    expect((await db.author.findUnique(unique.proxy))?.name).toBe('A')
    expect(unique.folded()).toBe(false)
    const many = watched({})
    expect(await db.draft.findMany(many.proxy)).toHaveLength(1)
    expect(many.folded()).toBe(false)
  })

  it('a gated model still refuses a caller below it', async () => {
    const db = (await open([gate()])).$setAuth(user)
    await expect(db.secret.findUnique({ where: { id: 1 } })).rejects.toThrow(/requires/)
  })

  it("a plugin's afterRead sees the row", async () => {
    const seen: string[] = []
    class Tap extends Plugin {
      async onAfterRead(model: string, rows: any[]) { for (const r of rows) seen.push(`${model}:${r.id}`) }
    }
    const db = await open([new Tap()])
    await db.author.findUnique({ where: { id: 1 } })
    await db.draft.findMany({})
    expect(seen).toEqual(['Author:1', 'Draft:1'])
  })

  it("a plugin's read filter narrows a lookup by id", async () => {
    class Hide extends Plugin {
      buildReadFilter(model: string) { return model === 'Author' ? { name: 'nobody' } : null }
    }
    const db = await open([new Hide()])
    expect(await db.author.findUnique({ where: { id: 1 } })).toBeNull()
  })

  it('a beforeRead that rewrites the where is honored', async () => {
    class Redirect extends Plugin {
      async onBeforeRead(model: string, args: any) { if (model === 'Author' && args.where) args.where = { id: 2 } }
    }
    const db = await open([new Redirect()])
    expect(await db.author.findUnique({ where: { id: 1 } })).toBeNull()
  })
})

describe('a write naming a parent nothing can hide', () => {
  it('runs no exists() for it', async () => {
    const sql: string[] = []
    const db = (await open([gate()], sql)).$setAuth(user)
    await db.post.create({ data: { id: 2, title: 'Q', authorId: 1 } })
    expect(sql.filter(s => s.startsWith('SELECT 1'))).toEqual([])
  })
})
