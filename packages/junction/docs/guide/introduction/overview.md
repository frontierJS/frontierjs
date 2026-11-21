# Overview

Junction is the API realm of a FrontierJS app: services that answer over HTTP and WebSockets, a hook pipeline around every call, and the batteries an API needs. It runs on Bun and takes its model from a Litestone schema when one is installed.

```ts
const app = await createTestApp()

app.services.register(createService({
  name: 'notes',
  async create(ctx) { return { id: 1, ...ctx.data } },
}))

const res = await request(app).post('/notes').send({ title: 'Hello' })
if (res.status !== 201 || (res.body as { title: string }).title !== 'Hello') throw new Error('unexpected answer')
```

## What else it can do

- A service named `notes` is mounted at `/notes` with no route written, and `app.service('notes')` calls it in process
- `before`, `after` and `error` hooks run around every method, whichever transport carried the call
- One service answers HTTP, a WebSocket frame and an in-process call the same way
- `app.get` and `app.post` take a raw route for what is not a service
- `channels()` pushes a write to the clients watching it
- `createJunctionClient` is the browser's typed side of the same services
- The batteries, each behind a subpath: `/mail`, `/cache`, `/scheduler`, `/webhooks`, `/openapi`, `/outbox` and more
- `manifest()` serves `GET /manifest`, listing the services, hooks, channels and every route a plugin added
- Auth, jobs, integrations, notifications and agents are their own packages

**In depth:** [README § Where Junction lives in an app](../../../README.md#where-junction-lives-in-an-app), [§ What is actually mounted](../../../README.md#what-is-actually-mounted)
