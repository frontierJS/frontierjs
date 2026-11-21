# Raw routes

A route is a URL an outsider fixes, such as a vendor's webhook setting or a link in an inbox. `app.get`, `app.post` and the other verbs register a handler for one, and the handler receives a transport context rather than a service one.

```ts
import { request } from '@frontierjs/junction/testing'

app.get('/archive/{id}', ctx => ctx.json({ id: ctx.route.id, kind: 'archive' }))
app.post('/hooks/calendar', ctx => ctx.json({ received: ctx.body }, 202))

const got = await request(app).get('/archive/42')
if (got.status !== 200 || (got.body as { id: string }).id !== '42') throw new Error('the capture did not arrive as ctx.route.id')

const posted = await request(app).post('/hooks/calendar').send({ event: 'created' })
if (posted.status !== 202) throw new Error(`expected 202, got ${posted.status}`)

const literal = await request(app).get('/archive/:id')
if ((literal.body as { id: string }).id !== ':id') throw new Error('a path is matched as written')
```

## What else it can do

- A pattern writes a capture as `{id}`, read as `ctx.route.id`; a `:id` segment is matched literally and never captures
- `apiPrefix` applies to `app.get` and `app.post`; `app.http.router` registers a route outside it
- A file in `routes/` beside the services folder is a route, and its path is the URL: `routes/hooks/calendar.ts` answers `POST /hooks/calendar`
- A route file exports `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, and reaches the app as `ctx.app`
- `routes/archive/[id].ts` answers `GET /archive/{id}`, and a file or folder starting with `_` is private
- A route file's `options` export is keyed by verb, for example `{ PUT: { body: 'stream' } }` or `{ POST: { maxBodySize: 16 * 1024 * 1024 } }`
- Boot refuses a route file that exports no verb, throws, or answers the same URL as another
- A handler answers through the [response helpers](response-helpers.md), and a service is reached with `ctx.app.service(name)`

**In depth:** [README § Where the routes are](../../../README.md#where-the-routes-are)
