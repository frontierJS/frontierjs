// test/can-directive.test.ts — `$can`, the per-row ask (FJS-2997, FJS-D2283).
//
// A screen offered Edit on every row the caller could read, because the gate is
// the only grade the browser holds and a row policy is not a gate: the PATCH
// answered 403 for a row on screen. `$can` asks the Data boundary on the read
// the screen already makes, and each row answers `_can = { update, remove,
// moves }` graded as the caller. Every refusal is paired with the same row
// answered for somebody the policy admits, so a grader that refused everyone
// fails here too.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { buildService } from '../src/core/service.ts'

const SCHEMA = `
database main { path "./a.db" }

enum TodoState { open  done  archived }

model Todo {
  id      Int       @id @default(autoincrement())
  title   String    @default("t")
  ownerId String
  status  TodoState @default(open)
  @@allow(read,   ownerId == auth().id || auth().isStaff)
  @@allow(create, auth() != null)
  @@allow(update, ownerId == auth().id)
  @@allow(delete, ownerId == auth().id)
  @@transitions(status,
    complete: open -> done,
    reopen:   done -> open,
    archive:  done -> archived @system
  )
  @@db(main)
}
`

const AS: Record<string, unknown> = {
  owner: { id: 'u1', userType: 'user', role: 'user' },
  // Reads every todo and may change none of them.
  staff: { id: 'u3', userType: 'user', role: 'user', isStaff: true },
}

let app: any
let db: any

beforeAll(async () => {
  db = await createClient({ databases: ':memory:', schema: SCHEMA })
  const { createApp, defaultConfig } = await import('../index.ts')
  app = createApp({ db, config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 50 } } } as never)
  app.services.register(buildService({ name: 'todos' }))
  app.setAuth({ verifySession: async (t: string) => AS[t] ?? null })
  await app.start()
})

afterAll(async () => { await app?.stop() })

async function get(who: string, path: string) {
  const res = await app.http.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${who}` } }))
  return { status: res.status, body: await res.json() as any }
}

describe('$can answers on each row, graded as the caller', () => {
  test('a reader the update policy refuses is told so on the row', async () => {
    const t = await db.asSystem().todo.create({ data: { ownerId: 'u1' } })

    const staff = await get('staff', `/todos/${t.id}?$can=true`)
    expect(staff.status).toBe(200)
    expect(staff.body._can).toEqual({
      update: false, remove: false,
      moves:  { complete: { allowed: false, refusedBy: 'policy' } },
    })

    const owner = await get('owner', `/todos/${t.id}?$can=true`)
    expect(owner.body._can).toEqual({
      update: true, remove: true,
      moves:  { complete: { allowed: true, refusedBy: null } },
    })
  })

  test('a list answers every row of the page', async () => {
    await db.asSystem().todo.create({ data: { ownerId: 'u1', title: 'mine' } })
    const res = await get('staff', '/todos?$can&$orderBy=id')
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
    for (const row of res.body.data) expect(row._can.update).toBe(false)
  })

  test('a narrowed read is graded against the stored row, not the columns it selected', async () => {
    const t = await db.asSystem().todo.create({ data: { ownerId: 'u1' } })
    const res = await get('owner', `/todos/${t.id}?$can=true&$select=id,title`)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['_can', 'id', 'title'])
    expect(res.body._can.update).toBe(true)
  })

  test('unasked costs nothing and answers no _can', async () => {
    const t = await db.asSystem().todo.create({ data: { ownerId: 'u1' } })
    const res = await get('owner', `/todos/${t.id}`)
    expect(res.status).toBe(200)
    expect('_can' in res.body).toBe(false)
  })

  test('a value outside the flag grammar is refused by name', async () => {
    const res = await get('owner', '/todos?$can=maybe')
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('$can')
  })
})

// FJS-1508: the browser's button list offered every move on a model whose moves
// the @@capabilities grid says, and the server refused each by name. The grid is
// what the caller HOLDS, which no page can know, so `$can` is how it reaches
// `resource.transitions` — a move the bearer does not hold is refused here, with
// the reason a screen tells apart from the policy.
describe('$can grades the @@capabilities grid per move', () => {
  const GRID = `
database main { path "./b.db" }

enum Stage { applied  screened  rejected  withdrawn }

model Application {
  id    Int   @id @default(autoincrement())
  stage Stage @default(applied)
  @@gate(0)
  @@capabilities
  @@transitions(stage,
    screen:   applied -> screened,
    reject:   applied -> rejected,
    withdraw: applied -> withdrawn
  )
  @@db(main)
}
`
  const WHO: Record<string, unknown> = {
    applicant: { id: 'a1', userType: 'user', role: 'user', capabilities: ['Application.read', 'Application.withdraw'] },
    recruiter: { id: 'r1', userType: 'user', role: 'user', capabilities: ['Application.read', 'Application.screen', 'Application.reject', 'Application.withdraw'] },
  }
  let gridApp: any
  let gridDb: any

  beforeAll(async () => {
    gridDb = await createClient({ databases: ':memory:', schema: GRID })
    const { createApp, defaultConfig } = await import('../index.ts')
    gridApp = createApp({ db: gridDb, config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 50 } } } as never)
    gridApp.services.register(buildService({ name: 'applications' }))
    gridApp.setAuth({ verifySession: async (t: string) => WHO[t] ?? null })
    await gridApp.start()
  })

  afterAll(async () => { await gridApp?.stop() })

  const read = async (who: string, id: number) => {
    const res = await gridApp.http.fetch(new Request(`http://localhost/applications/${id}?$can=true`, { headers: { authorization: `Bearer ${who}` } }))
    return { status: res.status, body: await res.json() as any }
  }

  test('a move the caller does not hold is refused by the grid, and one it holds is offered', async () => {
    const a = await gridDb.asSystem().application.create({ data: {} })

    const applicant = await read('applicant', a.id)
    expect(applicant.status).toBe(200)
    expect(applicant.body._can.moves).toEqual({
      screen:   { allowed: false, refusedBy: 'capability' },
      reject:   { allowed: false, refusedBy: 'capability' },
      withdraw: { allowed: true,  refusedBy: null },
    })

    const recruiter = await read('recruiter', a.id)
    expect(Object.values(recruiter.body._can.moves).every((m: any) => m.allowed)).toBe(true)
  })
})
