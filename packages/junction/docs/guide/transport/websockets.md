# WebSockets

`app.ws()` registers a socket route with the same `{param}` path syntax as an HTTP route. The handler's context arrives with the path captures, the query, the headers and the user already resolved, and no raw Bun types.

```ts
const app = createApp({ config: { ...defaultConfig, name: 'chat', hostname: '127.0.0.1', port: 0, apiPrefix: '/api' } })

app.ws('/chat/{roomId}', {
  open(ctx) { ctx.send({ type: 'welcome', room: ctx.route.roomId }) },
  message(ctx, msg) { ctx.send({ echo: msg }) },
  close(ctx, code, reason) {},
})

await app.start()

const socket = new WebSocket(`ws://127.0.0.1:${app.http.port}/api/chat/tavern`)
const frames: string[] = []
socket.onmessage = e => { frames.push(String(e.data)) }
await new Promise<void>((res, rej) => { socket.onopen = () => res(); socket.onerror = () => rej(new Error('refused')) })
await new Promise(res => setTimeout(res, 100))

if (JSON.parse(frames[0]).room !== 'tavern') throw new Error('the capture did not arrive as ctx.route.roomId')

socket.close()
await app.stop()
```

## What else it can do

- `open`, `message`, `close` and `drain` handlers receive a `WsContext` with `ctx.route`, `ctx.query`, `ctx.headers` and `ctx.user`
- Auth is resolved before `open()` is called
- The path takes `apiPrefix`, as `app.post` does
- `app.ws` is the raw door: junction sends the peer no `connected` and no error frame
- Per-socket state is `ctx.locals`, and a handler's throw goes to `onError`
- A third argument sets the route's bounds: `limits` over `config.http.ws` field by field, and `upgrade(req)` to refuse before the socket exists
- A frame past a bound closes the socket `1008` with the code as the reason
- A frame sent as the socket opens waits for `open()` to settle
- Services reach sockets through [live updates](live-updates.md), not through this route

**In depth:** [README § 4. WebSocket routing](../../../README.md#4-websocket-routing--appws)
