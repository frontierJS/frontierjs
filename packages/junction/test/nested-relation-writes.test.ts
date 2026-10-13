// test/nested-relation-writes.test.ts
//
// A nested relation write through a service is carried to the Data boundary
// (`FJS-2633`).
//
// A relation's name is a field of its model, so the unknown-key check let
// `{ members: { connect: [...] } }` through, and the compiled schema then
// stripped it: no generated document declares a relation as a property. The
// call answered 200 having written nothing, where the same payload through the
// Data client writes under the gate.
//
// The echo stays dropped. A client that fetched a row with `$include` and sends
// it back carries the relation as rows, not as an op object, and litestone
// reads only an op object as a nested write — so that is what is carried.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../../litestone/src/index.js'
import { createApp }              from '../src/core/app.ts'
import { createService }          from '../src/core/service.ts'
import { defaultConfig }          from '../index.ts'

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
  model Doc {
    id    Int    @id
    title String
    lines Line[]
  }
  model Line {
    id    Int    @id
    docId Int
    doc   Doc    @relation(fields: [docId], references: [id])
    text  String
  }
`

async function mkApp() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as any
  const sys = db.asSystem()
  await sys.user.create({ data: { id: 1, name: 'a' } })
  await sys.user.create({ data: { id: 2, name: 'b' } })
  await sys.task.create({ data: { id: 1, title: 't' } })
  await sys.doc.create({ data: { id: 1, title: 'd' } })
  await sys.line.create({ data: { id: 1, docId: 1, text: 'one' } })
  await sys.line.create({ data: { id: 2, docId: 1, text: 'two' } })

  const app = createApp({ db: db as never })
  for (const [name, model] of [['users', 'User'], ['tasks', 'Task'], ['docs', 'Doc'], ['lines', 'Line']])
    app.services.register(createService({ name, model, db: db as never } as never))
  await app._startForTest()
  return { app, sys }
}

const call = (app: any, service: string, method: string, id: unknown, data: unknown) =>
  app.service(service).call(method, id, data as never)

const membersOf = async (sys: any, id: number) =>
  ((await sys.task.findFirst({ where: { id }, include: { members: true } })).members as { id: number }[])
    .map(u => u.id).sort()

const linesOf = async (sys: any) =>
  ((await sys.line.findMany({ orderBy: { id: 'asc' } })) as { id: number, text: string }[])
    .map(l => `${l.id}:${l.text}`)

describe('an implicit many-to-many', () => {
  test('a PATCH connects', async () => {
    const { app, sys } = await mkApp()
    await call(app, 'tasks', 'patch', 1, { members: { connect: [{ id: 1 }, { id: 2 }] } })
    expect(await membersOf(sys, 1)).toEqual([1, 2])
  })

  test('a PATCH sets, then disconnects', async () => {
    const { app, sys } = await mkApp()
    await call(app, 'tasks', 'patch', 1, { members: { set: [{ id: 2 }] } })
    expect(await membersOf(sys, 1)).toEqual([2])
    await call(app, 'tasks', 'patch', 1, { members: { disconnect: [{ id: 2 }] } })
    expect(await membersOf(sys, 1)).toEqual([])
  })

  test('from the other side', async () => {
    const { app, sys } = await mkApp()
    await call(app, 'users', 'patch', 1, { tasks: { connect: [{ id: 1 }] } })
    expect(await membersOf(sys, 1)).toEqual([1])
  })

  test('a create carries its connect', async () => {
    const { app, sys } = await mkApp()
    await call(app, 'tasks', 'create', null, { id: 2, title: 'u', members: { connect: [{ id: 1 }] } })
    expect(await membersOf(sys, 2)).toEqual([1])
  })
})

describe('a hasMany', () => {
  test('a PATCH creates, updates and deletes children', async () => {
    const { app, sys } = await mkApp()
    await call(app, 'docs', 'patch', 1, { lines: {
      create: [{ id: 3, text: 'three' }],
      update: [{ where: { id: 1 }, data: { text: 'ONE' } }],
      delete: [{ id: 2 }],
    } })
    expect(await linesOf(sys)).toEqual(['1:ONE', '3:three'])
  })
})

describe('an echoed include is still dropped', () => {
  test('rows under the relation name write nothing and refuse nothing', async () => {
    const { app, sys } = await mkApp()
    const row = await call(app, 'docs', 'patch', 1, {
      title: 'd2',
      lines: [{ id: 1, docId: 1, text: 'edited' }],
    }) as any
    expect(row.title).toBe('d2')
    expect(await linesOf(sys)).toEqual(['1:one', '2:two'])
  })

  test('a belongsTo echoed as a row is dropped too', async () => {
    const { app, sys } = await mkApp()
    const row = await call(app, 'lines', 'patch', 1, { text: 'edited', doc: { id: 1, title: 'd' } }) as any
    expect(row.text).toBe('edited')
    expect(await linesOf(sys)).toEqual(['1:edited', '2:two'])
  })
})

// ─── the Data boundary still grades what is carried ────────────────────────

describe('over HTTP, under the gate', () => {
  const GATED = `
    model Folder {
      id    Int    @id
      title String
      notes Note[]
      @@gate("4.4.4.4")
    }
    model Note {
      id       Int    @id
      folderId Int
      folder   Folder @relation(fields: [folderId], references: [id])
      text     String
      @@gate("4.5.5.5")
    }
  `

  async function gated() {
    const db: any = await createClient({ db: ':memory:', schema: GATED })
    await db.asSystem().folder.create({ data: { id: 1, title: 'f' } })
    const app: any = createApp({ db: db as never, config: {
      port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http, drainTimeout: 50 },
    } } as never)
    app.services.register(createService({ name: 'folders', model: 'Folder' } as never))
    // sessionGateLevel grades a plain user 4 and an admin 5.
    const AS: Record<string, unknown> = {
      user:  { userId: 'u1', userType: 'user',  role: 'user' },
      admin: { userId: 'u2', userType: 'admin', role: 'admin', isStaff: true, isAdmin: true },
    }
    app.setAuth({ verifySession: async (t: string) => AS[t] ?? null })
    await app.start()
    const patch = (who: string, body: unknown) => app.http.fetch(new Request('http://localhost/folders/1', {
      method: 'PATCH', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${who}` },
    }))
    return { db, patch, close: async () => { await app.stop(); db.$close() } }
  }

  test('a nested create the child model refuses is refused, not dropped', async () => {
    const { db, patch, close } = await gated()
    const res = await patch('user', { notes: { create: [{ id: 1, text: 'n' }] } })
    expect(res.status).toBe(403)
    expect(await db.asSystem().note.count()).toBe(0)
    await close()
  })

  test('…and one it admits is written', async () => {
    const { db, patch, close } = await gated()
    const res = await patch('admin', { notes: { create: [{ id: 1, text: 'n' }] } })
    expect(res.status).toBe(200)
    expect(await db.asSystem().note.count()).toBe(1)
    await close()
  })
})
