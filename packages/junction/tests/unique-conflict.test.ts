// tests/unique-conflict.test.ts
//
// What a taken `@unique` value looks like from a browser (`FJS-441`).
//
// It used to be measured through `example`'s API as:
//
//   500 {"name":"GeneralError","message":"UNIQUE constraint failed: product_variant.sku"}
//
// Three separate things wrong with that, and this file grades each one: the
// STATUS pages somebody and is retried by clients that would not retry a 4xx;
// there is no FIELD, so a form has nothing to key on and renders "the server
// broke" instead of marking the box; and the physical table name is neither
// the name the caller used nor anything a browser should learn.
//
// Written against a real Litestone client rather than a thrown stand-in: the
// translation happens down in the write path, and the point of the test is that
// it survives every hop to the wire.

import { describe, test, expect } from 'bun:test'
import { createClient } from '@frontierjs/litestone'
import { request } from '../src/testing/index.ts'
import { createApp } from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

const SCHEMA = `
model Variant {
  id   Int    @id @default(autoincrement())
  sku  String @unique
  name String
}
`

async function appWithVariants() {
  // The client is typed from a schema that exists only in this file, so the
  // accessor is `unknown` to tsc — junction is baselined at zero errors and a
  // test may not be the thing that raises it.
  const db  = await createClient({ schema: SCHEMA, db: ':memory:' }) as any
  const app = createApp({ db: db as never })
  app.services.register(createService({ name: 'variants', model: 'Variant', db: db as never }))
  await db.variant.create({ data: { sku: 'FJS-TEE', name: 'Tee' } })
  return { app, db }
}

describe('a taken @unique value, from the browser (FJS-441)', () => {

  test('is a 409, not a 500', async () => {
    const { app, db } = await appWithVariants()
    const res = await request(app).post('/variants').send({ sku: 'FJS-TEE', name: 'Other' })
    expect(res.status).toBe(409)
    db.$close()
  })

  test('names the field, so a form can mark the control', async () => {
    const { app, db } = await appWithVariants()
    const res  = await request(app).post('/variants').send({ sku: 'FJS-TEE', name: 'Other' })
    const body = res.body as { data?: Array<{ path?: string[], message?: string }> }
    // The `errors` channel, the one shape sierra's toFieldErrors already reads.
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data?.[0]?.path).toEqual(['sku'])
    expect(body.data?.[0]?.message).toContain('already taken')
    db.$close()
  })

  test('says nothing about the physical table', async () => {
    const { app, db } = await appWithVariants()
    const res  = await request(app).post('/variants').send({ sku: 'FJS-TEE', name: 'Other' })
    const text = JSON.stringify(res.body)
    expect(text).not.toContain('UNIQUE constraint failed')
    expect(text).not.toContain('variant.sku')
    db.$close()
  })

  test('is not retryable — the same request fails the same way', async () => {
    const { app, db } = await appWithVariants()
    const res = await request(app).post('/variants').send({ sku: 'FJS-TEE', name: 'Other' })
    expect((res.body as { retryable?: boolean }).retryable).toBe(false)
    db.$close()
  })

  test('an update onto a taken value is the same answer', async () => {
    const { app, db } = await appWithVariants()
    const row = await db.variant.create({ data: { sku: 'FJS-CAP', name: 'Cap' } })
    const res = await request(app).patch(`/variants/${row.id}`).send({ sku: 'FJS-TEE' })
    expect(res.status).toBe(409)
    expect((res.body as { data?: Array<{ path?: string[] }> }).data?.[0]?.path).toEqual(['sku'])
    db.$close()
  })
})
