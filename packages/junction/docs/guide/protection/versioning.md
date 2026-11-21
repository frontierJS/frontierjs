# API versioning

`apiPrefix` mounts everything the app registers under one path, so `/api/v1` can sit beside a later `/api/v2` deployment.

```ts
import { createTestApp, request } from '@frontierjs/junction/testing'

const app = await createTestApp({ config: { apiPrefix: '/api/v1' } })
app.services.register(createService({ name: 'notes', async find() { return [{ id: 1 }] } }))
app.get('/ping', ctx => ctx.json({ pong: true }))

const versioned = await request(app).get('/api/v1/notes')
if (versioned.status !== 200) throw new Error(`expected /api/v1/notes to answer, got ${versioned.status}`)

const ping = await request(app).get('/api/v1/ping')
if (ping.status !== 200) throw new Error('a route from app.get moves with the prefix')

const bare = await request(app).get('/notes')
if (bare.status !== 404) throw new Error(`the unprefixed path should not answer, got ${bare.status}`)
```

## What else it can do

- It defaults to `''`, which mounts services at `/{service}`
- `api`, `/api` and `/api/` all mean the same prefix
- Every route registered through `app.get` and `app.post` moves with it, not only the service routes
- A route that must sit at a fixed path goes on `app.http.router`, which applies no prefix
- The browser client takes the same value: `createJunctionClient({ url, apiPrefix: '/api/v1' })`
- Auth's own prefix stays relative to this one

**In depth:** [README § API versioning](../../../README.md#api-versioning)
