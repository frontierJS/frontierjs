// test/deny-message.test.ts
//
// A write the row policy refuses carries the sentence the schema authored
// (`FJS-3129`). Create already said it; update, remove and a transition came
// back as a bare "is not one you may change", and a late autosave is the
// refusal a student's tab most needs a reason for.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { buildService } from '../src/core/service.ts'

const LATE = 'The deadline for this attempt has passed'

const SCHEMA = `
database main { path "./a.db" }

enum AnswerState { open  sent }

model Answer {
  id      Int         @id @default(autoincrement())
  body    String      @default("a")
  ownerId String
  late    Boolean     @default(false)
  state   AnswerState @default(open)
  @@allow(read,   true)
  @@allow(create, auth() != null)
  @@allow(update, ownerId == auth().id)
  @@allow(delete, ownerId == auth().id)
  @@deny(write, late == true, "${LATE}")
  @@transitions(state, send: open -> sent)
  @@db(main)
}
`

const AS: Record<string, unknown> = {
  owner:    { id: 'u1', userType: 'user', role: 'user' },
  stranger: { id: 'u2', userType: 'user', role: 'user' },
}

let app: any
let db: any

beforeAll(async () => {
  db = await createClient({ databases: ':memory:', schema: SCHEMA })
  const { createApp, defaultConfig } = await import('../index.ts')
  app = createApp({
    db,
    config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 50 } },
  } as never)
  app.services.register(buildService({ name: 'answers' }))
  app.setAuth({ verifySession: async (t: string) => AS[t] ?? null })
  await app.start()
})

afterAll(async () => { await app?.stop() })

const seed = (late: boolean) => db.asSystem().answer.create({ data: { ownerId: 'u1', late } })

async function send(who: string, method: string, id: number, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.http.fetch(new Request(`http://localhost/answers/${id}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${who}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, text, body: parsed }
}

describe('a refusal the schema wrote a sentence for', () => {
  for (const [verb, body] of [['PATCH', { body: 'x' }], ['PUT', { body: 'x' }], ['DELETE', undefined]] as const) {
    test(`${verb} says the sentence`, async () => {
      const a = await seed(true)
      const r = await send('owner', verb, a.id, body)
      expect(r.status).toBe(403)
      expect(r.text).toContain(LATE)
    })
  }

  test('a transition says the sentence', async () => {
    const a = await seed(true)
    const r = await send('owner', 'POST', a.id, {}, { 'x-service-method': 'send' })
    expect(r.status).toBe(403)
    expect(r.text).toContain(LATE)
  })

  test('a refusal with no authored sentence stays the bare one', async () => {
    const a = await seed(false)
    const r = await send('stranger', 'PATCH', a.id, { body: 'x' })
    expect(r.status).toBe(403)
    expect(r.text).toContain('is not one you may change')
  })

  test('the same writes land while the deny does not fire', async () => {
    const a = await seed(false)
    expect((await send('owner', 'PATCH', a.id, { body: 'x' })).status).toBe(200)
    expect((await send('owner', 'POST', a.id, {}, { 'x-service-method': 'send' })).status).toBe(200)
  })
})
