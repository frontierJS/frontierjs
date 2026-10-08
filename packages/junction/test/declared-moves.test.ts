// test/declared-moves.test.ts
//
// A service over a model serves each `@@transitions` move by its own name
// (`FJS-1255`).
//
// A screen draws its buttons from `@@transitions` — sierra's
// `resource.transitions(row)` — and the only thing it can call is
// `invoke(move.name, id)`. A generated service is one line and writes no method
// of that name, so every derived button answered 405. The move is served now as
// `transition(id, move)` on the CALLER's client, so everything below that is a
// refusal is the Data boundary's refusal, not a check written here.
//
// Every refusal is paired with the same move made by somebody entitled to make
// it (`FJS-351`): a served move that refused everyone would pass every half that
// only asks about refusing.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createService, createBaseService } from '../src/core/service.ts'

const SCHEMA = `
database main { path "./a.db" }

enum TodoState { open  done  archived }

model Todo {
  id      Int       @id @default(autoincrement())
  title   String    @default("t")
  ownerId String
  status  TodoState @default(open)
  @@allow('read',   ownerId == auth().id || auth().isStaff)
  @@allow('create', auth() != null)
  @@allow('update', ownerId == auth().id)
  @@transitions(status,
    complete: open -> done,
    reopen:   done -> open,
    archive:  done -> archived @system
  )
  @@db(main)
}
`

const AS: Record<string, unknown> = {
  owner:    { userId: 'u1', userType: 'user', role: 'user' },
  stranger: { userId: 'u2', userType: 'user', role: 'user' },
  // Reads every todo and updates none of them: the case a 404 would lie about.
  staff:    { userId: 'u3', userType: 'user', role: 'user', isStaff: true },
}

let app: any
let db: any

beforeAll(async () => {
  db = await createClient({ databases: ':memory:', schema: SCHEMA })
  const { createApp, defaultConfig } = await import('../index.ts')
  app = createApp({
    db,
    config: { port: 0, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 50 } },
  } as never)

  // The generated shape, exactly: a one-line base the loader names and wraps.
  app.services.register(createService({
    name: 'todos', ...(createBaseService({ channel: 'todos' }) as unknown as Record<string, unknown>),
  } as never))

  // An author's own `complete` beside the moves. It wins.
  app.services.register(createService({
    name: 'tasks', model: 'Todo',
    async complete() { return { handwritten: true } },
  }))

  // An allow-list that names one move and not the others. A move listed with no
  // function written is not a finding — start() below would refuse if it were.
  app.services.register(createService({
    name: 'chores', model: 'Todo',
    methods: ['find', 'get', 'complete'],
    hooks: { before: { complete: [] } },
  }))

  app.setAuth({ verifySession: async (t: string) => AS[t] ?? null })
  await app.start()
})

afterAll(async () => { await app?.stop() })

async function seed(ownerId = 'u1') {
  return db.asSystem().todo.create({ data: { ownerId } })
}

async function statusOf(id: number) {
  return (await db.asSystem().todo.findFirst({ where: { id } })).status
}

async function invoke(who: string, svc: string, method: string, id: number | string) {
  const res = await app.http.fetch(new Request(`http://localhost/${svc}/${id}`, {
    method: 'POST',
    headers: { 'x-service-method': method, 'content-type': 'application/json', authorization: `Bearer ${who}` },
    body: '{}',
  }))
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, body }
}

describe('a base service with no custom methods serves the moves', () => {

  test('complete moves the row and answers the moved row', async () => {
    const t = await seed()
    const res = await invoke('owner', 'todos', 'complete', t.id)
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toContain('"done"')
    expect(await statusOf(t.id)).toBe('done')

    // And the move back, by its own name.
    expect((await invoke('owner', 'todos', 'reopen', t.id)).status).toBe(200)
    expect(await statusOf(t.id)).toBe('open')
  })

  test('it is on the service object as well as in the table, as a written method is', async () => {
    const svc = app.services.get('todos')
    expect(typeof svc.complete).toBe('function')
    expect(Object.keys(svc._customMethods)).toEqual(['complete', 'reopen', 'archive'])
  })

  test('a second complete on the same row is refused, and the row stays done', async () => {
    const t = await seed()
    expect((await invoke('owner', 'todos', 'complete', t.id)).status).toBe(200)
    const again = await invoke('owner', 'todos', 'complete', t.id)
    expect(again.status).toBe(409)
    expect(await statusOf(t.id)).toBe('done')
  })
})

describe('the Data boundary grades the move', () => {

  test('a caller the row policy hides gets 404, never 200 null — the owner, paired, moves it', async () => {
    const t = await seed()
    const res = await invoke('stranger', 'todos', 'complete', t.id)
    expect(res.status).toBe(404)
    expect(await statusOf(t.id)).toBe('open')
    expect((await invoke('owner', 'todos', 'complete', t.id)).status).toBe(200)
  })

  test('a caller who may READ the row and not update it is refused by name (FJS-1790)', async () => {
    const t = await seed()
    const res = await invoke('staff', 'todos', 'complete', t.id)
    expect(res.status).toBe(403)
    expect(await statusOf(t.id)).toBe('open')
  })

  test('an @system move is refused for a user caller — the system client, paired, makes it', async () => {
    const t = await seed()
    await invoke('owner', 'todos', 'complete', t.id)
    const res = await invoke('owner', 'todos', 'archive', t.id)
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('@system')
    expect(await statusOf(t.id)).toBe('done')
    await db.asSystem().todo.transition(t.id, 'archive')
    expect(await statusOf(t.id)).toBe('archived')
  })
})

describe('one table', () => {

  test('a hand-written method of the same name wins', async () => {
    const t = await seed()
    const res = await invoke('owner', 'tasks', 'complete', t.id)
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toContain('handwritten')
    expect(await statusOf(t.id)).toBe('open')
    // The moves it did not write are still served.
    expect(app.services.get('tasks').describe().methods).toContain('reopen')
  })

  test('the moves are in the allowed-methods list and the 405 names them', async () => {
    const d = app.services.get('todos').describe()
    for (const m of ['complete', 'reopen', 'archive']) {
      expect(d.methods).toContain(m)
      expect(d.customMethods).toContain(m)
    }
    const t = await seed()
    const res = await invoke('owner', 'todos', 'bogus', t.id)
    // A name the service lacks entirely is a 404 ahead of the policy; the list
    // is the policy's 405 on the narrowed service below.
    expect(res.status).toBe(404)
  })

  test('a methods: allow-list still governs — the listed move is served, the others are 405', async () => {
    const d = app.services.get('chores').describe()
    expect(d.methods).toContain('complete')
    expect(d.methods).not.toContain('reopen')
    expect(app.services.get('chores')._authoringFindings).toEqual([])

    const t = await seed()
    expect((await invoke('owner', 'chores', 'complete', t.id)).status).toBe(200)
    const refused = await invoke('owner', 'chores', 'reopen', t.id)
    expect(refused.status).toBe(405)
    expect(JSON.stringify(refused.body)).toContain('complete')
    expect(await statusOf(t.id)).toBe('done')
  })

  test('a service over a model with no machine gains nothing', async () => {
    const plain = createService({ name: 'notes' })
    app.services.register(plain)
    expect(plain.describe().customMethods).toEqual([])
  })
})

// A move named for a CRUD verb was dropped, the button stayed drawn, and the
// call answered as the verb (`FJS-1909`). Paired with the same machine under a
// name that is free, so the refusal is about the name and nothing else.
describe('a move named for what a service already answers refuses start()', () => {
  const machine = (inverse: string) => `
database main { path "./a.db" }
enum ProjectState { active  archived }
model Project {
  id     Int          @id @default(autoincrement())
  status ProjectState @default(active)
  @@allow('all', true)
  @@transitions(status, archive: active -> archived, ${inverse}: archived -> active)
  @@db(main)
}
`
  async function boot(inverse: string) {
    const pdb = await createClient({ databases: ':memory:', schema: machine(inverse) })
    const { createApp, defaultConfig } = await import('../index.ts')
    const a = createApp({
      db: pdb,
      config: { port: 0, services: { dir: '/nonexistent' },
                http: { ...defaultConfig.http, drainTimeout: 50 } },
    } as never)
    const svc = createService({ name: 'projects', model: 'Project' })
    a.services.register(svc)
    return { a, svc }
  }

  test('restore is reported by name and start() refuses', async () => {
    const { a, svc } = await boot('restore')
    expect(svc._authoringFindings).toHaveLength(1)
    expect(svc._authoringFindings![0]).toContain(`move 'restore'`)
    await expect(a.start()).rejects.toThrow(/move 'restore'/)
    await a.stop()
  })

  test('the same move named unarchive is served', async () => {
    const { a, svc } = await boot('unarchive')
    expect(svc._authoringFindings).toEqual([])
    expect(svc.describe().customMethods).toContain('unarchive')
    await a.start()
    await a.stop()
  })
})
