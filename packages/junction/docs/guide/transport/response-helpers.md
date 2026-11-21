# Response helpers

A raw route answers through methods on its context, so the status, the content type and the body are stated together. A service method does not use them: it returns a value and the envelope is built for it.

```ts
import { request } from '@frontierjs/junction/testing'

app.get('/hello', ctx => ctx.text('hello'))
app.get('/page',  ctx => ctx.html('<h1>Hello</h1>'))
app.get('/gone',  ctx => ctx.empty(204))
app.get('/old',   ctx => ctx.redirect('/hello', 302))
app.get('/rows',  ctx => ctx.paginate([{ id: 1 }], 41, { limit: 20, offset: 0 }))

const text = await request(app).get('/hello')
if (text.text !== 'hello' || !text.headers['content-type'].startsWith('text/plain')) throw new Error('ctx.text')

const html = await request(app).get('/page')
if (!html.headers['content-type'].startsWith('text/html')) throw new Error('ctx.html')

if ((await request(app).get('/gone')).status !== 204) throw new Error('ctx.empty')

const old = await request(app).get('/old')
if (old.status !== 302 || old.headers.location !== '/hello') throw new Error('ctx.redirect')

const page = (await request(app).get('/rows')).body as { total: number, next: string, prev: null }
if (page.total !== 41 || !page.next.includes('offset=20') || page.prev !== null) throw new Error('ctx.paginate')
```

## What else it can do

- `ctx.json(data, status?)` answers JSON and is the one the other pages use
- `ctx.file(path, { download, etag, type, cacheControl })` serves a file with `304`, `Range` and `nosniff` handled
- `ctx.stream(readable, type, status?)` answers a body as it is produced
- `ctx.sse()` returns `{ response, send, close, onDisconnect }` for Server-Sent Events
- `onDisconnect` fires when the client leaves, which is where a timer or a subscription is cleaned up
- `ctx.paginate` builds `next` and `prev` links from the request URL
- A stream built by hand arrives in one piece to a client that accepts gzip, so build it with `ctx.stream()` or `ctx.sse()`

**In depth:** [README § Response helpers](../../../README.md#response-helpers)
