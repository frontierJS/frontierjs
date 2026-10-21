// test/m2m-populate.test.ts — `$populate` over an implicit many-to-many (FJS-3314).

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../../litestone/src/index.js'
import { createApp }              from '../src/core/app.ts'
import { createService }          from '../src/core/service.ts'
import { request }                 from '../src/testing/index.ts'

const SCHEMA = `
  model User {
    id    Int    @id
    name  String
    tasks Task[]
  }
  model Task {
    id      Int    @id
    title   String
    members User[]
  }
`

async function mkApp() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as any
  const sys = db.asSystem()
  await sys.user.create({ data: { id: 1, name: 'a' } })
  await sys.task.create({ data: { id: 1, title: 't', members: { connect: [{ id: 1 }] } } })
  await sys.task.create({ data: { id: 2, title: 'u', members: { connect: [{ id: 1 }] } } })
  const app = createApp({ db: db as never })
  for (const [name, model] of [['users', 'User'], ['tasks', 'Task']])
    app.services.register(createService({ name, model, db: db as never } as never))
  await app._startForTest()
  return { app }
}

describe('$populate over an implicit many-to-many', () => {
  test('find answers the related rows', async () => {
    const { app } = await mkApp()
    const out = await app.service('users').find({}, { directives: { populate: 'tasks' } } as never) as any
    const row = (out.data ?? out)[0]
    expect(row.tasks.map((t: any) => t.id).sort()).toEqual([1, 2])
  })

  test('get answers the related rows', async () => {
    const { app } = await mkApp()
    const row = await app.service('users').get(1, { directives: { populate: 'tasks' } } as never) as any
    expect(row.tasks.map((t: any) => t.id).sort()).toEqual([1, 2])
  })

  test('over HTTP, from either side', async () => {
    const { app } = await mkApp()
    for (const [path, rel] of [['users', 'tasks'], ['tasks', 'members']] as const) {
      const res  = await request(app).get(`/${path}?$populate=${rel}`)
      const body = res.body as any
      const rows = body.data ?? body
      expect(res.status).toBe(200)
      expect(Array.isArray(rows[0][rel])).toBe(true)
      expect(rows[0][rel].length).toBeGreaterThan(0)
    }
  })
})

describe('the spelling', () => {
  test('a field list narrows the related rows', async () => {
    const { app } = await mkApp()
    const res = await request(app).get('/users?$populate=tasks:id')
    expect(res.status).toBe(200)
    expect((res.body as any).data[0].tasks).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('`$include` is refused by name, never answered as null', async () => {
    const { app } = await mkApp()
    const res = await request(app).get('/users?$include=tasks')
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('$include')
  })
})
