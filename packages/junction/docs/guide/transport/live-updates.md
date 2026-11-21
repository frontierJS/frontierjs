# Live updates

A channel is a named set of sockets. A service announces a write to one, and every socket in it receives an event, so a page updates without polling.

```ts
const app = createApp({ config: { ...defaultConfig, name: 'live', hostname: '127.0.0.1', port: 0 } })

app.configure(channels(app => {
  app.channels.on('connection', (session, conn) => { app.channel('deployments').join(conn) })
}))

app.services.register(createService({
  name: 'deployments',
  async create(ctx) { return { id: 1, ...ctx.data } },
  hooks: { after: { create: [announce(() => app.channel('deployments'))] } },
}))

await app.start()

const socket = new WebSocket(`ws://127.0.0.1:${app.http.port}/ws`, ['fjs'])
const events: any[] = []
socket.onmessage = e => { const f = JSON.parse(String(e.data)); if (f.type === 'event') events.push(f) }
await new Promise<void>((res, rej) => { socket.onopen = () => res(); socket.onerror = () => rej(new Error('refused')) })
await new Promise(res => setTimeout(res, 100))

await app.service('deployments').create({ name: 'api' })
await new Promise(res => setTimeout(res, 100))

if (events.length !== 1 || events[0].event !== 'deployments created') throw new Error('the write was not announced')
if (events[0].data.name !== 'api') throw new Error('the event holds the written row')

socket.close()
await app.stop()
```

## What else it can do

- `channels(setup)` configures the socket at `/ws`; `app.channel(name).join(conn)` is usually called in a `connection` hook
- `announce(fn)` is an `after` hook that sends the result to the channel `fn` returns
- A service can instead declare `channel: 'name'`, or a function `(row, ctx) => channel`, which also announces a write a job makes as the system; use one or the other
- A broadcast is graded per recipient, so a socket that may not read the row is not sent it
- The frame is `{ type: 'event', event: 'deployments created', data }`
- A write announces when the outermost transaction commits, and a rollback announces nothing
- `channels(setup, { rooms: { 'page:{id}': 'Page' } })` binds a channel to one row, and a member who loses the row leaves it
- `channels(setup, { presence: ['page:*'] })` reports who is in a channel
- The client picks a room at the upgrade with `socketQuery`, and asks for a later one with `client.presence.set('page:9')`
- A token from `client.setToken` reaches the connection hook as `conn.data.bearer`

**In depth:** [README § 5. Channels](../../../README.md#5-channels--real-time-without-polling)
