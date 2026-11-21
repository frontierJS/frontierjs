# Getting started

Add the package, write one service and start the app. Junction runs on Bun only; Litestone is an optional peer that gives a service its CRUD from the schema.

```bash
bun add @frontierjs/junction
```

```ts
const app = createApp({
  config: { ...defaultConfig, name: 'hello', hostname: '127.0.0.1', port: 0, apiPrefix: '/api' },
})

app.services.register(createService({
  name: 'notes',
  async find() { return [{ id: 1, title: 'Hello' }] },
}))

await app.start()

const res  = await fetch(`http://127.0.0.1:${app.http.port}/api/notes`)
const body = await res.json() as { data: { title: string }[] }
if (res.status !== 200 || body.data[0].title !== 'Hello') throw new Error('unexpected answer')

await app.stop()
```

## What else it can do

- `fli new my-app` scaffolds the whole layout; Junction has no scaffolder of its own
- `port` is `3000` unless `FRONTIER_PORT_BE`, `PORT` or the config says otherwise, and `0` takes a free one
- `apiPrefix` moves every route the app registers
- `createApp({ db })` takes a Litestone client, and a service named for a model then needs no methods written
- `createApp({ root: import.meta.url })` loads `services/` and `routes/` beside the file
- `app.configure(health())` adds `GET /health` and `GET /metrics`
- In a clone of the monorepo, `bun run dev` starts the example app with `--watch` and `bun run repl` opens a shell on it

**In depth:** [README § Install](../../../README.md#install), [§ Quick start](../../../README.md#quick-start)
