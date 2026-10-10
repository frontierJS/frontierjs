# File Storage

The `FileStorage` plugin stores file bytes in S3-compatible object storage (Cloudflare R2, Backblaze B2, AWS S3, MinIO) or local disk, while keeping a JSON reference object in SQLite. The ORM handles upload, cleanup, and URL resolution transparently.

## Schema

```lite
model User {
  id      Int    @id
  email   String
  avatar  File?              // single file — uploaded on create/update, deleted on row delete
  resume  File?  @keepVersions  // keep old S3 object when field is updated
  photos  File[]             // multiple files — stored as JSON array of refs
  docs    File[] @accept("application/pdf,application/msword")
  banner  File?  @accept("image/*")   // wildcards supported
}
```

## Setup

```js
import { FileStorage } from '@frontierjs/litestone/storage'

const db = await createClient({
  path: './schema.lite',
  db:   ':memory:',
  plugins: [FileStorage({
    provider:        'r2',
    bucket:          'my-app',
    endpoint:        process.env.S3_ENDPOINT,
    accessKeyId:     process.env.S3_KEY,
    secretAccessKey: process.env.S3_SECRET,
    publicBase:      'https://cdn.example.com',       // what a read resolves a ref against
    keyPattern:      ':model/:field/:uuid.:ext',      // object key template
  })]
})
```

`provider` is `r2`, `s3`, `b2`, `minio` (all S3-compatible) or `local`, which writes under `localPath` (default `./storage`) and answers URLs under `localUrl`. With neither `provider` nor `endpoint` given, the plugin picks `local` under `NODE_ENV=development` or `test` and refuses to build otherwise, naming the option. The client builds without credentials; a missing secret fails at the first upload, not at startup. `keyPattern` may not name `:id` — a create has no id when the object is written.

## Usage

```js
import { FileStorage, fromPath } from '@frontierjs/litestone/storage'

const db = await createClient({
  path: './schema.lite', db: ':memory:',
  plugins: [FileStorage({ provider: 'local', localPath: './storage', keyPattern: ':model/:field/:uuid.:ext' })],
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const avatarFile = new File([png], 'alice.png', { type: 'image/png' })

// Create with file — pass a File, Blob, Buffer, Uint8Array or ArrayBuffer
const user = await db.user.create({
  data: { id: 1, email: 'alice@example.com', avatar: avatarFile }
})

// From the server's disk — code only. A string is never read as a path, under
// asSystem() too, so a request body naming /etc/passwd is refused (FJS-2061).
await Bun.write('./seed/alice.png', png)
await db.user.update({ where: { id: 1 }, data: { avatar: fromPath('./seed/alice.png') } })

// Over JSON (a JSON body, an /mcp tool call), the bytes go inline: a base64
// data URL, or { name, type, data } with base64 data (FJS-D666). A stored ref
// is never sent — the server writes it. The create and update JSON Schemas
// describe this value as `FileInput`; the bound is junction's http.maxBodySize
// (256KB by default, and base64 adds a third), so an app taking photos raises it.
await db.user.update({ where: { id: 1 }, data: { avatar: `data:image/png;base64,${png.toString('base64')}` } })
await db.user.update({ where: { id: 1 }, data: { avatar: { name: 'me.png', type: 'image/png', data: png.toString('base64') } } })

// Update file — old object deleted automatically (unless @keepVersions)
const updated = await db.user.update({
  where: { id: 1 },
  data:  { avatar: new File([png], 'new.png', { type: 'image/png' }) }
})

// Multiple files
const u2 = await db.user.update({
  where: { id: 1 },
  data:  { photos: [new File([png], 'p1.png', { type: 'image/png' }), new File([png], 'p2.png', { type: 'image/png' })] }
})

// Delete row — the avatar's object is deleted from storage with it
await db.user.delete({ where: { id: 1 } })
```

`@accept` grades the BYTES, not the name: the type is sniffed from the content where the format has a signature, and the claim (`File.type`, the extension) stands only where nothing identifies the bytes. A refused upload is a `ValidationError` naming the model, the field, the type found and the list accepted.

A row delete removes the objects a `File?` or a `File[]` names:

```js
import { FileStorage } from '@frontierjs/litestone/storage'
import { readdirSync } from 'node:fs'

const db = await createClient({
  path: './schema.lite', db: ':memory:',
  plugins: [FileStorage({ provider: 'local', localPath: './storage', keyPattern: ':model/:field/:uuid.:ext' })],
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
await db.user.create({ data: { id: 1, email: 'a@example.com', photos: [new File([png], 'p1.png', { type: 'image/png' })] } })
await db.user.delete({ where: { id: 1 } })
if (readdirSync('./storage/User/photos').length !== 0) throw new Error('the photo outlived its row')
```

## Resolving URLs

With `autoResolve: true` (the default), a single `File?` field reads as a URL — `publicBase` (or, failing that, `endpoint`) joined to the stored key. A local store declaring neither reads as `null` (`FJS-1504`), and a `File[]` reads as the list of those URLs:

```js
import { FileStorage } from '@frontierjs/litestone/storage'

const db = await createClient({
  path: './schema.lite', db: ':memory:',
  plugins: [FileStorage({ provider: 'local', localPath: './storage', publicBase: 'https://cdn.example.com', keyPattern: ':model/:field/:uuid.:ext' })],
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
await db.user.create({ data: { id: 1, email: 'alice@example.com', avatar: new File([png], 'alice.png', { type: 'image/png' }) } })

const user = await db.user.findUnique({ where: { id: 1 } })
user.avatar   // → 'https://cdn.example.com/User/avatar/<uuid>.png'
if (!String(user.avatar).startsWith('https://cdn.example.com/User/avatar/')) throw new Error(`expected a URL, got ${user.avatar}`)
```

The row a `create` or `update` answers is not resolved: it carries the stored ref as written, the parsed object. To get the raw reference on a read (for custom signing, etc.):

```js
import { FileStorage, parseRef } from '@frontierjs/litestone/storage'

const db = await createClient({
  path: './schema.lite', db: ':memory:',
  plugins: [FileStorage({ provider: 'local', localPath: './storage', keyPattern: ':model/:field/:uuid.:ext' })],
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
await db.user.create({ data: { id: 1, email: 'alice@example.com', avatar: new File([png], 'alice.png', { type: 'image/png' }) } })

const user = await db.user.findUnique({
  where:  { id: 1 },
  select: { id: true, avatar: { resolve: false } }
})
const ref = parseRef(user.avatar)
// → { key: 'User/avatar/<uuid>.png', name: 'alice.png', bucket, provider: 'local', endpoint: null, publicBase: null, size: 70, mime: 'image/png', uploadedAt }
if (ref.mime !== 'image/png' || ref.size !== 70) throw new Error('expected the stored ref')
```

The ref is stored as JSON text and read back as the object; `parseRef` also turns the text into the object, for a ref held outside a row.

## Utilities

```js
import { FileStorage, fileUrl, fileUrls, useStorage, parseRef } from '@frontierjs/litestone/storage'

const config = { provider: 'local', localPath: './storage', publicBase: 'https://cdn.example.com', keyPattern: ':model/:field/:uuid.:ext' }
const db = await createClient({ path: './schema.lite', db: ':memory:', plugins: [FileStorage(config)] })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
await db.user.create({ data: { id: 1, email: 'alice@example.com', avatar: new File([png], 'alice.png', { type: 'image/png' }) } })
const user = await db.user.findUnique({ where: { id: 1 }, select: { avatar: { resolve: false }, photos: { resolve: false } } })

// Derive URL from a ref (the stored string or the parsed object) — null with no publicBase or endpoint
fileUrl(user.avatar)       // → 'https://cdn.example.com/User/avatar/<uuid>.png'
fileUrls(user.photos)      // → ['https://...', ...]

// Storage operations
const storage = useStorage(config)
await storage.sign(user.avatar, { expiresIn: 3600 })  // presigned URL; the local provider answers its public URL
const bytes = await storage.download(user.avatar)      // → Buffer
if (bytes.length !== 70) throw new Error('expected the uploaded bytes back')
await storage.delete(user.avatar)                      // manual cleanup
```

## Orphan prevention

Hook sequencing ensures no orphaned S3 objects:

- `onBeforeCreate`/`onBeforeUpdate` — serializes file to S3, stores ref in SQLite; an update stashes the ref it is replacing, read in one SELECT for every file field
- `onAfterWrite` — deletes the stashed old object only after the SQL succeeded (SQL failure = no cleanup)
- `onAfterDelete` — deletes the objects the deleted rows named, after the SQL DELETE

`@keepVersions` on a field skips the old object cleanup on update — useful for versioned assets or files with external references.

## ExternalRefPlugin — custom backends

`FileStorage` extends `ExternalRefPlugin`. Build your own plugin for any external-backed field type:

```js
import { ExternalRefPlugin } from '@frontierjs/litestone'

class VideoPlugin extends ExternalRefPlugin {
  fieldType = 'Video'

  _isRawValue(v) { return v instanceof Buffer }

  async serialize(value, { field, model, id }) {
    const key = `${model}/${id}/${field}`
    await videoService.upload(key, value)
    return { key, duration: await getVideoDuration(value) }
  }

  async resolve(ref, { field, model }) {
    return videoService.getStreamUrl(ref.key)
  }

  async cleanup(ref) {
    await videoService.delete(ref.key)
  }

  cacheKey(ref) { return ref.key }
}
```

The `cacheKey` method enables per-field response caching — return `null` to disable caching for that ref.
