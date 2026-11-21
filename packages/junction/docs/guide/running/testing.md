# Testing

`createTestApp()` builds a fully wired app that binds no port. `request(app)` sends an HTTP-shaped call through it, and `testCtx` with `callService` calls a service with no HTTP at all.

```ts
import { expect } from 'bun:test'
import { createService, createTestApp, testCtx, request, callService } from '@frontierjs/junction'

const notes = createService({ name: 'notes', async create(ctx) { return { id: 1, ...ctx.data } } })

const app = await createTestApp({
  services: [notes],
  users:    [{ id: 'u1', role: 'admin' }],
})

// A direct service call, no HTTP
const ctx = testCtx('notes', 'create', { title: 'Hello' }, { user: { id: 'u1' } })
await callService(app.services.get('notes')!, ctx)
expect(ctx.result.data.title).toBe('Hello')

// An HTTP-style call, still no port
const res = await request(app)
  .post('/notes')
  .auth(app.tokenFor('u1'))
  .send({ title: 'Hello', body: 'World' })
expect(res.status).toBe(201)
```

## What else it can do

- `request(app)` has `.get()`, `.post()`, `.patch()`, `.put()`, `.delete()` and `.options()`
- `app.tokenFor(id)` signs a bearer token for one of the `users` you gave it
- The first `request()` starts the app, so `app.configure(cors(...))` before it still wraps the routes
- `await app._startForTest()` then `app.http.fetch(new Request(...))` answers every route with no port
- Export a `buildApp()` factory and call it in each test file, since a module-level `app` is cached across files
- `createTestApp` creates no database, so pass `db` in when a test needs one
- `@frontierjs/testing` adds real factories and a principal bound into every call, over Litestone's `createTestEnv`

**In depth:** [README § Testing](../../../README.md#testing)
