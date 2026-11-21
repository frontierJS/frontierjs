# File uploads

A `multipart/form-data` request reaches a service as plain data: the bridge merges the uploaded files into `ctx.data` as native `File` objects before the method runs. Junction owns no file store, only the crossing.

```ts
import { createTestApp } from '@frontierjs/junction/testing'

const app = await createTestApp()
app.services.register(createService({
  name: 'avatars',
  async create(ctx) {
    const { name, photo } = ctx.data
    return { name, isFile: photo instanceof File, filename: photo.name, bytes: photo.size }
  },
}))
await app._startForTest()
app.http.router.build()

const form = new FormData()
form.set('name', 'Alice')
form.set('photo', new File(['PNGDATA'], 'photo.png', { type: 'image/png' }))

const res = await app.http.fetch(new Request('http://localhost/avatars', { method: 'POST', body: form }))
const body = await res.json() as { name: string, isFile: boolean, filename: string, bytes: number }
if (res.status !== 201 || !body.isFile || body.name !== 'Alice' || body.bytes !== 7) throw new Error(`expected the file beside the text field, got ${res.status} ${JSON.stringify(body)}`)
```

## What else it can do

- A raw route reads the parsed upload as `ctx.files`, with no `formData()` call
- A Litestone `File` or `File?` column hands the `File` to the storage plugin, which stores it and keeps a reference in the row, so the service never sees storage
- The browser client sends a body holding a `File` as multipart and keeps its other values' types
- A route stating `{ body: 'stream' }` skips the parse: `ctx.body` is the unread stream, for an upload larger than memory
- `http.maxBodySize` bounds every route, and a route's own `maxBodySize` replaces it
- An `after` hook can expand a stored file reference into a URL with `fileUrl` from `@frontierjs/litestone/storage`
- Storing and serving the file is the [Litestone Files](../../../../litestone/docs/guide/built-in/files.md) page

**In depth:** [README § File uploads](../../../README.md#file-uploads)
