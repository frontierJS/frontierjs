// test/method-answers.test.ts — `answers:` on a `methods:` entry (FJS-2012, FJS-D914).
//
// A custom method may answer ANOTHER model's row: `messages.promote()` answers
// the Task a message became. The announcement used to grade that answer against
// the service's own model -- 22 keys against Message's 17 columns -- and re-read
// a MESSAGE by the task's id, which is a wrong row or a stranger's.
//
// A REAL Litestone client: the completeness check and the re-read both go
// through its schema and its tables.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createApp } from '../src/core/app.ts'
import { createService, buildService } from '../src/core/service.ts'
import { channels } from '../src/transport/channels.ts'

const SCHEMA = `
  model Message { id Int @id  body String  state String }
  model Task    { id Int @id  title String  status String  due String? }
`

const tick = () => new Promise((r) => setImmediate(r))

type Sys = { asSystem(): Record<string, Record<string, (a: unknown) => Promise<any>>> }

async function mkApp(answers: string | null = 'Task') {
  const db = await createClient({ db: ':memory:', schema: SCHEMA }) as never as Sys & Record<string, unknown>
  const app = createApp({ db: db as never })
  app.services.register(createService({
    name: 'messages', model: 'Message', db: db as never,
    channel: 'messages',
    methods: [{ method: 'promote', ...(answers ? { answers } : {}) }],
    async promote() {
      return db.asSystem().task.create({ data: { title: 'from a message', status: 'open' } })
    },
  } as never))
  app.configure(channels(() => {}))
  await app._startForTest()

  const sys = db.asSystem()
  // Message 1 exists, so a re-read of a MESSAGE by the task's id 1 finds a row
  // -- the wrong one.
  await sys.message.create({ data: { body: 'stranger', state: 'new' } })
  await tick()

  const heard: Array<Record<string, unknown>> = []
  app.events.on('messages:promote', (row: Record<string, unknown>) => { heard.push(row) })
  const frames: string[] = []
  app.channels.channel('messages').join({
    socket: { readyState: 1, send: (f: string) => { frames.push(f); return 1 } },
  } as never)
  return { db, app, heard, frames }
}

const promote = (app: Awaited<ReturnType<typeof mkApp>>['app']) =>
  (app.service('messages') as never as { call(m: string): Promise<unknown> }).call('promote')

describe('a method that answers another model\'s row', () => {

  test('is announced as that row, not re-read as the service\'s own', async () => {
    const { app, heard } = await mkApp('Task')
    await promote(app)
    await tick()
    expect(heard).toHaveLength(1)
    expect(heard[0]!.title).toBe('from a message')
    expect(heard[0]!.body).toBeUndefined()
  })

  test('reaches the channel as that row', async () => {
    const { app, frames } = await mkApp('Task')
    await promote(app)
    await tick()
    const sent = frames.map(f => JSON.parse(f) as { event?: string, data?: Record<string, unknown> })
      .filter(f => (f.event ?? '').startsWith('messages '))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.data!.title).toBe('from a message')
  })

  test('is graded per recipient against that model', async () => {
    const { db, app } = await mkApp('Task')
    const asked: string[] = []
    const real = (db as never as { $readGrading: (...a: unknown[]) => unknown }).$readGrading.bind(db)
    ;(db as never as { $readGrading: unknown }).$readGrading = (accessor: string, ...rest: unknown[]) => {
      asked.push(accessor)
      return real(accessor, ...rest)
    }
    await promote(app)
    await tick()
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every(a => a.toLowerCase() === 'task')).toBe(true)
  })

  test('without the declaration the announcement is still the wrong row', async () => {
    const { app, heard } = await mkApp(null)
    const warn = console.warn
    console.warn = () => {}
    try { await promote(app); await tick() } finally { console.warn = warn }
    expect(heard[0]!.body).toBe('stranger')
  })
})

describe('the declaration', () => {

  test('describe() names it', () => {
    const svc = buildService({
      name: 'messages', model: 'Message',
      methods: [{ method: 'promote', answers: 'Task' }],
      promote: async () => ({}),
    } as never)
    expect(svc.describe().answers).toEqual({ promote: 'Task' })
  })

  test('is refused unless it names a model', () => {
    expect(() => buildService({
      name: 'messages', model: 'Message',
      methods: [{ method: 'promote', answers: '' }],
      promote: async () => ({}),
    } as never)).toThrow(/declares answers/)
  })

  test('is refused on a CRUD verb, which answers the service\'s own model', () => {
    expect(() => buildService({
      name: 'messages', model: 'Message',
      methods: [{ method: 'find', answers: 'Task' }],
    } as never)).toThrow(/CRUD verb/)
  })

  test('naming a model the schema lacks is refused at boot', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    app.services.register(createService({
      name: 'messages', model: 'Message', db: db as never,
      methods: [{ method: 'promote', answers: 'Taks' }],
      promote: async () => ({}),
    } as never))
    await expect(app._startForTest()).rejects.toThrow(/Taks/)
  })
})
