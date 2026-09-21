// A primary key the CALLER supplies, through a service (FJS-608).
//
// `generateJsonSchema(…, { mode: 'create' })` excluded every `@id` as
// *server-assigned*, so for a model keyed by anything the server does not
// generate, the key was not merely un-required but ABSENT from the schema
// `autoValidate` compiles.
//
// **The symptom is the opposite of a rejection, and that is what made it hard to
// read.** Junction STRIPS what the create schema does not declare rather than
// refusing it, so the key was removed from the payload in silence and the
// refusal came from the Data boundary one layer down. Measured against the
// pre-fix emitter: `POST /memberships {orgId, userId, role}` answered
// **400 `orgId is required, userId is required`** — about the two fields the
// request had just sent. A generated form had no box to type one into either.
//
// It reads as a composite-key problem and is not: a single `code String @id` —
// a slug, a stock keeping unit, an external system's identifier — behaves
// identically. Every `@id` was treated as though it were
// `Int @id @default(autoincrement())`, the one case where excluding it is right.
//
// This is the half litestone's own suite cannot assert. There the schema is a
// document; here it is compiled into a validator that stands between an HTTP
// body and a row, which is where the exclusion actually bit.

import { describe, test, expect } from 'bun:test'
import { request }      from '../src/testing/index.ts'
import { createApp }    from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { createClient } from '../../litestone/src/index.js'

const SCHEMA = `
  model Membership {
    orgId  String
    userId String
    role   String
    @@id([orgId, userId])
  }

  model Sku {
    code  String @id
    label String
  }

  model Note {
    id   Int    @id
    body String
  }
`

async function appWith() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  // `createApp({ db })` rather than `createTestApp`, which always installs its
  // own in-memory stub — and `db` is what installs the per-request scoping hook,
  // without which a base service refuses to reach `app.db` at all.
  const app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  for (const [name, model] of [['memberships', 'Membership'], ['skus', 'Sku'], ['notes', 'Note']])
    app.services.register(createService({ name, model } as never))
  return { app, db }
}

describe('a key the caller supplies survives autoValidate', () => {

  test('a composite key is accepted, and the row is keyed by it', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/memberships')
      .send({ orgId: 'acme', userId: 'ada', role: 'admin' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ orgId: 'acme', userId: 'ada', role: 'admin' })
  })

  test('a single caller-supplied `String @id` is too — it is the same defect', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/skus').send({ code: 'FJS-HOOD-CLY-L', label: 'Hoodie' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ code: 'FJS-HOOD-CLY-L', label: 'Hoodie' })
  })

  // The negative control, and the half that says the key is DEMANDED rather than
  // merely tolerated. Without it this file passes against a schema that dropped
  // `additionalProperties` and validates nothing.
  test('omitting it is a 400 naming the key, not a raw NOT NULL from SQLite', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/memberships').send({ role: 'admin' })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/orgId/)
    expect(JSON.stringify(res.body)).toMatch(/userId/)
    expect(JSON.stringify(res.body)).not.toMatch(/NOT NULL constraint failed/)
  })

  // The other side of the rule: an `Int @id` IS SQLite's rowid alias, so
  // demanding it would refuse every create on the commonest model there is.
  test('an autoincrementing key is still not asked for', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/notes').send({ body: 'hello' })

    expect(res.status).toBe(201)
    expect((res.body as { id: number }).id).toBeGreaterThan(0)
  })

  // Stating it is DROPPED rather than refused — the create schema does not
  // declare the column, and junction strips what it does not declare instead of
  // rejecting it. Asserted because it is the mechanism the whole defect ran on:
  // the strip is silent, so a key that is missing from the schema is a key that
  // never reaches the row, and the refusal then comes from the Data boundary
  // one layer down, about a field the caller plainly sent.
  test('stating an autoincrementing key is dropped, not honored', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/notes').send({ id: 99, body: 'hello' })

    expect(res.status).toBe(201)
    expect((res.body as { id: number }).id).not.toBe(99)
  })
})
