// base-service-override.test.ts — a CRUD method the author WROTE.
//
// `createBaseService` generates find/get/create/patch/remove from the model.
// A definition that also writes one of those names used to have it silently
// dropped: `collectCustomMethods` collects the non-CRUD names by construction,
// so `async get(ctx)` beside `model:` was never called and the generated
// row-by-id answered in its place. Nothing reported it, and what came back was
// a plausible wrong shape — the raw row rather than whatever the author had
// assembled — which is how it survives a smoke test.

import { describe, test, expect } from 'bun:test'
import { createBaseService } from '../src/core/service.ts'
import { createApp }         from '../src/core/app.ts'
import { createService }     from '../src/core/service.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

/** A plain client, which is the documented `db:` contract for this factory. */
function client() {
  const rows = [{ id: 1, name: 'one' }, { id: 2, name: 'two' }]
  const table = {
    async findMany() { return rows },
    async count()    { return rows.length },
    async findUnique({ where }: { where: { id: number } }) {
      return rows.find(r => r.id === Number(where.id)) ?? null
    },
    async create({ data }: { data: object }) { return { ...data } },
    async update({ data }: { data: object }) { return { ...data } },
    async delete()     { return { id: 1 } },
    async updateMany() { return { count: 0 } },
    async deleteMany() { return { count: 0 } },
  }
  return { widget: table }
}

async function appWith(def: object) {
  const app = createApp({ config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } } })
  app.services.register(createService(def as never))
  return app
}

describe('a written CRUD method wins over the generated one', () => {

  test('get', async () => {
    const app = await appWith(createBaseService({
      model: 'widget', name: 'widgets', db: () => client(),
      async get(ctx: ServiceContext) {
        return { id: Number(ctx.id), assembled: true }
      },
    } as never))

    expect(await app.service('widgets').get(1)).toEqual({ id: 1, assembled: true })
  })

  test('and the generated one still answers where nothing was written', async () => {
    const app = await appWith(createBaseService({
      model: 'widget', name: 'widgets', db: () => client(),
      async get() { return { assembled: true } },
    } as never))

    // `find` was not overridden, so this is the base's own implementation —
    // an override must not replace the whole CRUD surface.
    const list = await app.service('widgets').find()
    expect((list as { data: unknown[] }).data.length).toBe(2)
  })

  test('the override is not mistaken for a custom method', async () => {
    // A CRUD name in `_customMethods` would be dispatched as one — reachable
    // by X-Service-Method and listed as a custom verb in the manifest.
    const def = createBaseService({
      model: 'widget', name: 'widgets', db: () => client(),
      async get() { return {} },
      async reprice() { return {} },
    } as never) as unknown as { _customMethods: Record<string, unknown> }

    expect(Object.keys(def._customMethods)).toEqual(['reprice'])
  })
})
