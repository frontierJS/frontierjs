// test/surface-method-body.test.ts
//
// `junction surface` records what a custom method's BODY is beside the floor
// that grades the caller (`FJS-1794`).
//
// The grade says who may call; it cannot say whether the body then writes as the
// caller or as the app. A declared `gate: 0` method that creates rows through
// `asSystem()` was absent from the register, and the two caller-scoped moves
// beside it were listed as if they were the same risk. A method served from
// `@@transitions` has no body at all, and only the Data boundary stands in front
// of it — which the register says about no method today.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createService, buildBase } from '../src/core/service.ts'
import { describeSurface } from '../src/core/app-model.ts'
import { renderSurfaceSnapshot } from '../tools/surface.ts'
import { $ } from '../index.ts'

const SCHEMA = `
database main { path "./a.db" }

enum TodoState { open  done }

model Todo {
  id      Int       @id @default(autoincrement())
  title   String    @default("t")
  status  TodoState @default(open)
  @@gate(1.1.1.1)
  @@transitions(status, complete: open -> done)
  @@db(main)
}
`

let app: any
let out: string
let surface: ReturnType<typeof describeSurface>

beforeAll(async () => {
  const db = await createClient({ databases: ':memory:', schema: SCHEMA })
  const { createApp, defaultConfig } = await import('../index.ts')
  app = createApp({
    db,
    config: { port: 0, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 50 } },
  } as never)

  // The generated shape: no body, the moves are derived.
  app.services.register(createService({
    name: 'todos', ...(buildBase({ channel: 'todos' }) as unknown as Record<string, unknown>),
  } as never))

  app.services.register(createService({
    name: 'desk', model: 'Todo',
    methods: ['find', 'get', 'close', { method: 'book', gate: 0 }, 'sweep'],
    async close() { return $.db.todo.transition($.id!, 'complete') },
    async book()  { return $.db.asSystem().todo.create({ data: { title: 'x' } }) },
    async sweep() { return $.db.asSystem().todo.findMany() },
  }))

  await app.start()
  surface = describeSurface(app)
  out = renderSurfaceSnapshot(surface)
})

afterAll(async () => { await app?.stop() })

const svc = (name: string) => surface.services.find(s => s.name === name)!

describe('a custom method\'s body, read beside its grade', () => {

  test('a body that names asSystem is recorded, whatever its declared level', () => {
    expect(svc('desk').methodBodies.book).toBe('elevated')
    expect(svc('desk').methodBodies.sweep).toBe('elevated')
    expect(svc('desk').methodBodies.close).toBe('scoped')
  })

  test('a move the service never wrote is recorded as derived', () => {
    expect(svc('todos').methodBodies.complete).toBe('derived')
  })

  test('a written method with a move\'s name is not derived', () => {
    expect(svc('desk').methodBodies.close).not.toBe('derived')
  })

  test('the gate-0 elevated method appears in the register', () => {
    const section = out.slice(out.indexOf('## Custom methods whose body writes as the app'),
                              out.indexOf("## Custom methods whose caller"))
    expect(section).toContain('`desk.book`')
    expect(section).toContain('declared `gate: 0`')
    expect(section).toContain('`desk.sweep`')
    expect(section).not.toContain('`desk.close`')
  })

  test('a derived move says only the Data boundary stands in front of it', () => {
    const derived = out.slice(out.indexOf('### No body'), out.indexOf('## App hooks'))
    expect(derived).toContain('| `todos.complete` |')
    expect(out).toContain('no body, a derived move')
    const bare = out.slice(out.indexOf('### Nothing in front'), out.indexOf('### A service hook'))
    expect(bare).not.toContain('`todos.complete`')
  })
})
