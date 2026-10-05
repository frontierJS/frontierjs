// `declaredFields` — the custom fields one workspace declared on an
// @@extensible model, served per tenant through the model's own read gate
// (`FJS-D487`, `FJS-1388`).
//
// The rows are the two halves of one claim: a model with @@extensible answers
// its OWN declarations, and a model without it is a 404 rather than an empty
// list, because an empty list says "nothing declared" about a model that can
// never declare anything.

import { describe, test, expect } from 'bun:test'
import { request }       from '../src/testing/index.ts'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { createClient }  from '../../litestone/src/index.js'

const SCHEMA = `
  enum FieldKind { text number }
  model CustomField {
    id    Int    @id
    model String
    key   String
    type  FieldKind
    slot  String?
    @@unique([model, key])
    @@unique([model, slot], nullsDistinct: true)
  }
  model Customer {
    id     Int    @id
    name   String
    fields Json   @default("{}")
    @@extensible(fields, declaredBy: CustomField)
  }
  model Product {
    id     Int    @id
    name   String
    fields Json   @default("{}")
    @@extensible(fields, declaredBy: CustomField)
  }
  model Plain {
    id   Int    @id
    name String
  }
`

async function appWith() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem() as unknown as Record<string, { createMany(a: unknown): Promise<unknown> }>
  await sys.customField!.createMany({ data: [
    { model: 'Customer', key: 'tier', type: 'text' },
    { model: 'Customer', key: 'ltv',  type: 'number' },
    { model: 'Product',  key: 'care', type: 'text' },
  ] })

  const app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  app.services.register(createService({ name: 'customers', model: 'Customer' } as never))
  app.services.register(createService({ name: 'products',  model: 'Product'  } as never))
  app.services.register(createService({ name: 'plains',    model: 'Plain'    } as never))
  app.services.register(createService({ name: 'readers',   model: 'Customer', methods: 'readOnly' } as never))
  return app
}

const declared = (app: unknown, service: string) =>
  request(app as never).post(`/${service}`).set('X-Service-Method', 'declaredFields').send({} as never)

const keysOf = (body: unknown): string[] => {
  const rows = (Array.isArray(body) ? body : (body as { data: unknown[] }).data) as { key: string }[]
  return rows.map(r => r.key).sort()
}

describe('declaredFields', () => {
  test('an @@extensible model answers its own declarations, and the other its own', async () => {
    const app = await appWith()
    const cust = await declared(app, 'customers')
    expect(cust.status).toBe(200)
    expect(keysOf(cust.body)).toEqual(['ltv', 'tier'])
    expect(keysOf((await declared(app, 'products')).body)).toEqual(['care'])
  })

  test('a model with no @@extensible is a 404, not an empty list', async () => {
    const res = await declared(await appWith(), 'plains')
    expect(res.status).toBe(404)
  })

  test('a readOnly service answers it, since its screens filter on the same columns', async () => {
    const res = await declared(await appWith(), 'readers')
    expect(res.status).toBe(200)
    expect(keysOf(res.body)).toEqual(['ltv', 'tier'])
  })

  test('it is not an advertised method, so no service claims one it will 404', async () => {
    const app = await appWith() as unknown as { services: { get(n: string): { describe(): { methods: string[]; customMethods: string[] } } } }
    const d = app.services.get('plains').describe()
    expect(d.customMethods).not.toContain('declaredFields')
    expect(d.methods).not.toContain('declaredFields')
  })
})
