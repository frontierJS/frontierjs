// search-spanning.test.ts — `db.$search()` spans models over ONE index, graded
// per model before its LIMIT (FJS-D970).
//
// linear's Q4 measured the two shorter spellings wrong on per-model indexes: a
// ranked UNION answered 20 of 20 rows the caller may not read, and rank-then-
// grade spent the limit on decoys and lost the caller's real hits. The same
// rows in one `_search` table rank on one bm25 scale, and the grade is each
// model's own `visibleWhere` as an EXISTS branch under the one MATCH. This is
// the leak and the starvation, asserted against the spanning read — and the
// ranking the gate measured: a title outranks a body, and a query of only
// words too short to index sorts last with `_rank` null (FJS-2332).

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const SCHEMA = `
model User {
  id String @id
  @@auth
}

model Team {
  id      String  @id
  ownerId String
  issues  Issue[]
  @@allow('read', ownerId == auth().id)
}

model Issue {
  id          String    @id
  teamId      String
  team        Team      @relation(fields: [teamId], references: [id])
  title       String
  description String?
  comments    Comment[]
  @@allow('read', check(team))
  @@fts([title, description])
  @@label(title)
}

model Comment {
  id      String @id
  issueId String
  issue   Issue  @relation(fields: [issueId], references: [id])
  author  String
  body    String
  @@allow('read', check(issue))
  @@fts([body])
  @@label(author)
}

model Note {
  id   String @id
  text String
}
`

let dir: string
let db: any

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'litestone-spanning-'))
  db  = await createClient({ schema: SCHEMA, db: join(dir, 'db.sqlite') })
  const sys = db.asSystem()
  // Two teams: Ana owns t1, Bo owns t2. Every text below exists under both,
  // so a leak is a hit under the other team and nothing else.
  for (const t of ['t1', 't2']) {
    await sys.team.create({ data: { id: t, ownerId: t === 't1' ? 'ana' : 'bo' } })
    // Q4's planted pair: identical text as a title and as a body. A comment is
    // titled by its author, so its words are in the BODY column alone.
    await sys.issue.create({ data: { id: `${t}-i-title`, teamId: t, title: 'quasar lattice' } })
    await sys.issue.create({ data: { id: `${t}-i-long`,  teamId: t, title: 'Rebuild the quasar lattice index nightly', description: 'cron it' } })
    await sys.comment.create({ data: { id: `${t}-c-body`, issueId: `${t}-i-title`, author: 'ana', body: 'quasar lattice' } })
    await sys.comment.create({ data: { id: `${t}-c-long`, issueId: `${t}-i-title`, author: 'ana', body: 'Long thread about the quasar lattice migration, the lattice rebuild, and why the quasar step is slow' } })
    // Decoys: twenty rows that match, all readable only by this team's owner.
    for (let n = 0; n < 20; n++) {
      await sys.issue.create({ data: { id: `${t}-decoy-${n}`, teamId: t, title: `quasar decoy ${n}` } })
    }
  }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A Role reads some models and not others: maid.tech's Site Manager holds
// Task.read and no Contact.read. Its box answers the tasks.
describe('$search — a model the caller may not read', () => {
  const CAPS = `
model Contact {
  id   Int    @id @default(autoincrement())
  name String
  @@capabilities(all)
  @@fts([name])
  @@label(name)
}

model Task {
  id    Int    @id @default(autoincrement())
  title String
  @@capabilities(all)
  @@fts([title])
  @@label(title)
}
`
  let caps: any
  beforeAll(async () => {
    caps = await createClient({ schema: CAPS, databases: ':memory:' })
    await caps.asSystem().contact.create({ data: { name: 'Quillon Marsh' } })
    await caps.asSystem().task.create({ data: { title: 'Call Quillon' } })
  })

  it('answers the models it may read and drops the one it may not', async () => {
    const hits = await caps.$setAuth({ id: 'site', capabilities: ['Task.read'] }).$search('quillon')
    expect(hits.map((h: any) => h.model)).toEqual(['task'])
  })

  it('reads both when it holds both', async () => {
    const hits = await caps.$setAuth({ id: 'owner', capabilities: ['Task.read', 'Contact.read'] }).$search('quillon')
    expect(hits.map((h: any) => h.model).sort()).toEqual(['contact', 'task'])
  })

  it('is refused by the capability\'s name when it may read none of them', async () => {
    await expect(caps.$setAuth({ id: 'nobody', capabilities: [] }).$search('quillon'))
      .rejects.toThrow(/Contact\.read/)
    await expect(caps.$setAuth({ id: 'site', capabilities: ['Task.read'] }).$search('quillon', { models: ['contact'] }))
      .rejects.toThrow(/Contact\.read/)
  })
})

describe('$search — one index across models', () => {
  it('never answers a row the caller may not read', async () => {
    const hits = await db.$setAuth({ id: 'ana' }).$search('quasar', { limit: 100 })
    expect(hits.length).toBe(24)
    expect(hits.every((h: any) => String(h.id).startsWith('t1-'))).toBe(true)
  })

  it('spends the limit on readable rows, never on decoys', async () => {
    // Bo's 24 rows match the same words. A rank-then-grade spelling fills
    // Ana's 8 slots with whichever 8 rank first across both teams.
    const hits = await db.$setAuth({ id: 'ana' }).$search('quasar lattice', { limit: 8 })
    expect(hits.map((h: any) => h.id)).toEqual(['t1-i-title', 't1-i-long', 't1-c-body', 't1-c-long'])
  })

  it('is empty for a caller who reads nothing', async () => {
    expect(await db.$setAuth({ id: 'cy' }).$search('quasar')).toEqual([])
  })

  it('ranks on one scale: a title outranks a body for the same words', async () => {
    const hits = await db.$setAuth({ id: 'ana' }).$search('quasar lattice')
    expect(hits.map((h: any) => h.model)).toEqual(['issue', 'issue', 'comment', 'comment'])
    const ranks = hits.map((h: any) => h._rank)
    expect(ranks.every((r: unknown) => typeof r === 'number')).toBe(true)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('titles each hit from @@label and names the accessor', async () => {
    const [hit] = await db.$setAuth({ id: 'ana' }).$search('nightly')
    expect(hit).toMatchObject({ model: 'issue', id: 't1-i-long', title: 'Rebuild the quasar lattice index nightly' })
    const [c] = await db.$setAuth({ id: 'ana' }).$search('thread')
    expect(c).toMatchObject({ model: 'comment', id: 't1-c-long', title: 'ana' })
  })

  it('narrows to the accessors named, and refuses one outside @@fts by name', async () => {
    const only = await db.$setAuth({ id: 'ana' }).$search('quasar lattice', { models: ['comment'] })
    expect(only.map((h: any) => h.model)).toEqual(['comment', 'comment'])
    await expect(db.$setAuth({ id: 'ana' }).$search('x', { models: ['note'] })).rejects.toThrow(/Note.*@@fts/)
    await expect(db.$setAuth({ id: 'ana' }).$search('x', { models: ['nope'] })).rejects.toThrow(/nope/)
  })

  it('announces every statement it runs: the MATCH and one resolve per model hit', async () => {
    const seen: Array<{ model: string; operation: string }> = []
    const ana = db.$setAuth({ id: 'ana' })
    const off = db.$tapQuery((e: { model: string; operation: string }) => seen.push(e))
    try { await ana.$search('quasar lattice') } finally { off() }
    expect(seen.map(e => `${e.model}.${e.operation}`).sort()).toEqual(['_search.$search', 'comment.$search', 'issue.$search'])
  })

  it('a query of only short words answers unranked, after every ranked hit', async () => {
    const hits = await db.$setAuth({ id: 'ana' }).$search('qu')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h: any) => h._rank === null)).toBe(true)
    const mixed = await db.$setAuth({ id: 'ana' }).$search('lattice qu')
    const ranked = mixed.findIndex((h: any) => h._rank === null)
    expect(ranked === -1 || mixed.slice(ranked).every((h: any) => h._rank === null)).toBe(true)
  })
})

// `model` is an indexed column so `{ models }` narrows inside the MATCH and a
// small model skips the large ones' postings (FJS-2845). Indexed, a model's
// name is text the words could hit; and under trigram the narrowing is a
// substring test, so `post` would answer `postComment` without `model = ?`.
describe('$search — models narrowed inside the MATCH', () => {
  const NAMES = `
model Post {
  id    Int    @id @default(autoincrement())
  title String
  @@fts([title])
  @@label(title)
}

model PostComment {
  id   Int    @id @default(autoincrement())
  body String
  @@fts([body])
  @@label(body)
}

model Ox {
  id   Int    @id @default(autoincrement())
  name String
  @@fts([name])
  @@label(name)
}
`
  let nm: any
  beforeAll(async () => {
    nm = await createClient({ schema: NAMES, databases: ':memory:' })
    const sys = nm.asSystem()
    await sys.post.create({ data: { title: 'Zephyr launch notes' } })
    await sys.postComment.create({ data: { body: 'Zephyr launch went fine' } })
    await sys.postComment.create({ data: { body: 'a reply about the post' } })
    await sys.ox.create({ data: { name: 'Zephyr the ox' } })
  })

  it('does not answer a row for its model\'s name', async () => {
    const hits = await nm.asSystem().$search('post')
    expect(hits.map((h: any) => `${h.model}:${h.title}`)).toEqual(['postComment:a reply about the post'])
  })

  it('answers only the model named, though its name is inside another\'s', async () => {
    const hits = await nm.asSystem().$search('zephyr', { models: ['post'] })
    expect(hits.map((h: any) => h.model)).toEqual(['post'])
    const short = await nm.asSystem().$search('ze', { models: ['post'] })
    expect(short.map((h: any) => h.model)).toEqual(['post'])
  })

  it('narrows the MATCH itself to the models named', async () => {
    const seen: any[] = []
    const off = nm.$tapQuery((e: any) => { if (e.model === '_search') seen.push(e) })
    try { await nm.asSystem().$search('zephyr', { models: ['postComment'] }) } finally { off() }
    expect(seen[0].params[0]).toBe('{model} : ("postComment") AND {title body} : ("zephyr")')
  })

  it('answers a model whose name is too short to narrow by', async () => {
    const hits = await nm.asSystem().$search('zephyr', { models: ['ox'] })
    expect(hits.map((h: any) => h.model)).toEqual(['ox'])
    const both = await nm.asSystem().$search('zephyr', { models: ['ox', 'post'] })
    expect(both.map((h: any) => h.model).sort()).toEqual(['ox', 'post'])
  })
})
