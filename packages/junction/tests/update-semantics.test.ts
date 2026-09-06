// What `update` (PUT) means, and the strip that made it unusable (`FJS-663`,
// ruled `FJS-D179`).
//
// `update` was validated against the CREATE-mode document. That document omits
// `@version` — it is emitted for update and only for update — so the validator
// STRIPPED the version a PUT carried, and the Data boundary then refused the
// write for not carrying one. **`FJS-335` exactly, one method along**, and it
// went unfound because nothing in this repo drives a PUT on a versioned model.
// Measured on `example`: `PUT /api/tax-rates/1` carrying the version read one
// request earlier was a 400 naming `version`; the identical payload through
// PATCH was a 200.
//
// The fix is not only the strip. What create mode bought `update` was
// REQUIREDNESS, and the write underneath is litestone's `table.update`, which
// merges — so it demanded fields that would not be replaced. `update` is patch
// with an id required and no bulk path, and these tests say so in both
// directions.

import { describe, test, expect } from 'bun:test'
import { request }       from '../src/testing/index.ts'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { createClient }  from '../../litestone/src/index.js'

const SCHEMA = `
  model Doc {
    id       Int     @id
    title    String
    subtitle String?
    version  Int     @version
  }

  model Plain {
    id       Int     @id
    title    String
    subtitle String?
  }
`

async function appWith() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  app.services.register(createService({ name: 'docs',   model: 'Doc'   } as never))
  app.services.register(createService({ name: 'plains', model: 'Plain', allowBulk: true } as never))
  return { app, db }
}

const made = async (app: ReturnType<typeof createApp>, path = '/docs') =>
  (await request(app).post(path).send({ title: 'A', subtitle: 'keep me' })).body as
    { id: number; version: number; title: string; subtitle: string | null }

describe('a PUT to a @version model', () => {

  test('succeeds carrying the version it read', async () => {
    const { app } = await appWith()
    const row = await made(app)

    const res = await request(app).put(`/docs/${row.id}`)
      .send({ title: 'B', subtitle: 'keep me', version: row.version })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ title: 'B' })
  })

  // The version has to still MEAN something. A validator that carried the key
  // and a boundary that ignored it would pass the test above.
  test('and a stale version is still a 409, not an overwrite', async () => {
    const { app } = await appWith()
    const row = await made(app)
    await request(app).put(`/docs/${row.id}`).send({ title: 'B', version: row.version })

    const res = await request(app).put(`/docs/${row.id}`)
      .send({ title: 'C', version: row.version })

    expect(res.status).toBe(409)
  })

  // The pair for the strip: the same call omitting it must still be refused, or
  // the fix would read as "the boundary stopped asking".
  test('omitting it is refused by the Data boundary', async () => {
    const { app } = await appWith()
    const row = await made(app)

    const res = await request(app).put(`/docs/${row.id}`).send({ title: 'B' })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/version/)
  })
})

describe('what update IS — patch with an id required', () => {

  test('it MERGES: a column the PUT did not name keeps its value', async () => {
    const { app } = await appWith()
    const row = await made(app, '/plains')

    const res = await request(app).put(`/plains/${row.id}`).send({ title: 'B' })

    // Feathers' update replaces; this one does not, and the ruling is that the
    // documentation follows the write rather than the other way round.
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ title: 'B', subtitle: 'keep me' })
  })

  test('so a partial body is accepted — create-mode requiredness is gone', async () => {
    const { app } = await appWith()
    const row = await made(app, '/plains')

    const res = await request(app).put(`/plains/${row.id}`).send({ subtitle: 'only this' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ title: 'A', subtitle: 'only this' })
  })

  test('the same body through PATCH does the same thing', async () => {
    const { app } = await appWith()
    const a = await made(app, '/plains')
    const b = await made(app, '/plains')

    const put   = await request(app).put(`/plains/${a.id}`).send({ subtitle: 'x' })
    const patch = await request(app).patch(`/plains/${b.id}`).send({ subtitle: 'x' })

    expect(put.status).toBe(patch.status)
    expect({ ...(put.body as object), id: 0 }).toEqual({ ...(patch.body as object), id: 0 })
  })

  // The distinction that survives, and the reason the verb is still worth
  // having: patch's query path is a bulk write and PUT can never reach it.
  test('but an id is REQUIRED, where patch without one is a bulk write', async () => {
    const { app } = await appWith()
    await made(app, '/plains')

    const put = await request(app).put('/plains?title=A').send({ subtitle: 'bulk' })
    expect(put.status).toBe(400)
    expect(JSON.stringify(put.body)).toMatch(/id/)

    const patch = await request(app).patch('/plains?title=A').send({ subtitle: 'bulk' })
    expect(patch.status).toBe(200)
  })

  // Validation did not go away with requiredness — the shape is still graded.
  test('a bad value is still a 400', async () => {
    const { app } = await appWith()
    const row = await made(app, '/plains')

    const res = await request(app).put(`/plains/${row.id}`).send({ title: 42 })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/title/)
  })

  test('and a key that names no column is a 400 naming it', async () => {
    // It was a silent 200 with the key dropped until FJS-889. A PUT is where
    // that cost most: the caller sent a field and watched the write succeed
    // without it.
    const { app } = await appWith()
    const row = await made(app, '/plains')

    const res = await request(app).put(`/plains/${row.id}`).send({ title: 'B', nope: 1 })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/nope/)
  })

  test('…while a column the caller may not WRITE is dropped in silence', async () => {
    // The pair. Refusing this one would break every client that PUTs back a
    // row it fetched, which is the commonest REST idiom there is.
    const { app } = await appWith()
    const row = await made(app, '/plains')

    const res = await request(app).put(`/plains/${row.id}`).send({ title: 'B', id: 9999 })

    expect(res.status).toBe(200)
    expect((res.body as { id: number }).id).toBe(row.id)
  })
})
