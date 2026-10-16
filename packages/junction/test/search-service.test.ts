// test/search-service.test.ts — searchService({ models }): one round trip,
// graded by the Data boundary, held to the models the mount names (FJS-D970).
//
// Three `@@fts` models and a mount that names two. The third is in litestone's
// `_search` like the others, so `$search` would answer it; the mount is the only
// thing between a caller and it, and that refusal is what this file pins. The
// grade is not re-tested here — `search-spanning.test.ts` owns it in litestone —
// but one cross-tenant row per model asserts the caller's client is the one the
// service reads through, since a service handed the root client would leak it.

import { describe, test, expect, beforeAll } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { searchService } from '../src/plugins/search/index.ts'
import { withLitestoneDb } from '../src/core/litestone.ts'
import { createTestApp, request } from '../src/testing/index.ts'
import type { TestApp } from '../src/testing/index.ts'

const SCHEMA = `
model User {
  id String @id
  @@auth
}

model Issue {
  id      String @id
  ownerId String
  title   String
  @@allow('read', ownerId == auth().id)
  @@fts([title])
  @@label(title)
}

model Comment {
  id      String @id
  ownerId String
  author  String
  body    String
  @@allow('read', ownerId == auth().id)
  @@fts([body])
  @@label(author)
}

model Secret {
  id      String @id
  ownerId String
  name    String
  @@allow('read', ownerId == auth().id)
  @@fts([name])
  @@label(name)
}
`

type Hit  = { model: string; id: string; title: string; _rank: number | null }
const hits = (b: unknown): Hit[] => Array.isArray(b) ? b as Hit[] : ((b as { data: Hit[] }).data ?? [])

let app: TestApp
let db: any

beforeAll(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  for (const owner of ['ana', 'bo']) {
    await sys.user.create({ data: { id: owner } })
    await sys.issue.create({ data: { id: `${owner}-i`, ownerId: owner, title: 'quasar lattice' } })
    await sys.comment.create({ data: { id: `${owner}-c`, ownerId: owner, author: owner, body: 'the quasar lattice is slow' } })
    await sys.secret.create({ data: { id: `${owner}-s`, ownerId: owner, name: 'quasar launch codes' } })
  }
  app = await createTestApp({
    users:    [{ id: 'ana' }, { id: 'bo' }],
    services: [searchService({ models: ['issue', 'comment'] })],
    hooks:    { around: { all: [withLitestoneDb(db)] } } as never,
  })
})

const search = (query: Record<string, string>) =>
  request(app).get('/search').auth('test-token-ana').query(query)

describe('searchService', () => {
  test('one call answers every mounted model, ranked, as the caller', async () => {
    const res = await search({ q: 'quasar' })
    expect(res.status).toBe(200)
    const got = hits(res.body)
    expect(got.map(h => h.id).sort()).toEqual(['ana-c', 'ana-i'])
    // A title outranks a body on the one scale (FJS-D970).
    expect(got[0]!.model).toBe('issue')
  })

  test('models narrows the mount, comma-separated on the wire', async () => {
    const res = await search({ q: 'quasar', models: 'comment' })
    expect(res.status).toBe(200)
    expect(hits(res.body).map(h => h.id)).toEqual(['ana-c'])
  })

  test('a model outside the mount is refused by name, though the index holds it', async () => {
    const res = await search({ q: 'quasar', models: 'issue,secret' })
    expect(res.status).toBe(400)
    const msg = (res.body as { message: string }).message
    expect(msg).toContain(`'secret' is not in this search`)
    expect(msg).toContain('issue, comment')
  })

  test('a key that is neither q nor models is refused rather than ignored', async () => {
    const res = await search({ q: 'quasar', model: 'comment' })
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain(`'model' is not a search key`)
  })

  test('an empty box answers nothing', async () => {
    for (const q of ['', '   ']) {
      const res = await search({ q })
      expect(res.status).toBe(200)
      expect(hits(res.body)).toEqual([])
    }
    const none = await request(app).get('/search').auth('test-token-ana')
    expect(hits(none.body)).toEqual([])
  })

  test('the last word is a prefix, as a palette types it', async () => {
    expect(hits((await search({ q: 'quasar latt' })).body).map(h => h.id).sort()).toEqual(['ana-c', 'ana-i'])
  })

  test('$limit reaches the one query', async () => {
    expect(hits((await search({ q: 'quasar', $limit: '1' })).body)).toHaveLength(1)
  })

  test('an internal call takes the same keys and the same refusal', async () => {
    const got = await app.runAs('bo', () => app.service('search').find({ q: 'quasar', models: ['issue'] }))
    expect(hits(got).map(h => h.id)).toEqual(['bo-i'])
    const err = await app.runAs('bo', () => app.service('search').find({ q: 'quasar', models: ['secret'] })).catch((e: Error) => e) as Error & { code?: number }
    expect(err.code).toBe(400)
  })

  test('a mount that names nothing is refused at construction', () => {
    expect(() => searchService({ models: [] })).toThrow(/names the accessors this search holds/)
  })

  test('a mounted model without @@fts fails its first call with litestone\'s refusal', async () => {
    const bad = await createTestApp({
      users:    [{ id: 'ana' }],
      services: [searchService({ models: ['issue', 'user'] })],
      hooks:    { around: { all: [withLitestoneDb(db)] } } as never,
    })
    const res = await request(bad).get('/search').auth('test-token-ana').query({ q: 'quasar' })
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain('@@fts')
  })
})
