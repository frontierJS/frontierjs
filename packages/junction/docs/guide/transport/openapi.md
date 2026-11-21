# OpenAPI

`openapi()` reads the registered services and serves a machine-readable spec, with a Swagger UI page if asked. Registering a schema for a method puts its fields in the spec.

```ts
import { createSchema, v } from '@frontierjs/junction'
import { openapi } from '@frontierjs/junction/openapi'
import { request } from '@frontierjs/junction/testing'

app.services.register(createService({ name: 'notes', async find() { return [] }, async create(ctx) { return ctx.data } }))

const CreateNoteSchema = createSchema({ title: v.required.string({ minLength: 1, maxLength: 200 }) })

app.configure(openapi({
  title:   'My API',
  version: '1.0.0',
  ui:      '/docs',
  schemas: { notes: { create: { body: CreateNoteSchema } } },
}))

const res  = await request(app).get('/openapi.json')
const spec = res.body as { info: { title: string }, paths: Record<string, unknown> }
if (res.status !== 200 || spec.info.title !== 'My API') throw new Error('the spec was not served')
if (!spec.paths['/notes']) throw new Error('the notes service is not in the spec')
if ((await request(app).get('/docs')).status !== 200) throw new Error('the UI page was not served')
```

## What else it can do

- `GET /openapi.json` is the spec, and `ui: '/docs'` adds an API docs page that loads its viewer from a CDN
- The spec follows `apiPrefix`, so with `/api/v2` the paths and the default endpoint move with it
- A `createSchema` object, raw or compiled, is read for its fields automatically
- `{ body, response }` per method describes a request and its answer, and a custom method takes the same pair
- Only what a service offers through `methods:` is listed

**In depth:** [README § OpenAPI](../../../README.md#openapi)
