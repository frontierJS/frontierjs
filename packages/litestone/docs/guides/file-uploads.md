# Guide: File Uploads

Store file metadata in SQLite and file bytes in S3-compatible object storage, with automatic cleanup, type validation, and presigned URLs.

---

## What we're building

- User profile photo upload
- Multi-file document attachments
- Content-type validation
- Presigned download URLs with expiry
- Automatic cleanup when rows are deleted

---

## Schema

```lite
model User {
  id     Int @id
  email  String    @unique
  avatar File?                                  // single optional file
}

model Document {
  id          Int  @id
  name        String
  ownerId     Int
  attachments File[]   @accept("application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  images      File[]   @accept("image/*")       // wildcard — any image type
  banner      File?    @keepVersions            // old file kept on update
  createdAt   DateTime @default(now())
}
```

`@accept` grades the uploaded bytes against the list before storing — the
sniffed type where the format has a magic number, the claimed type otherwise —
and refuses by name: `Document.attachments: file type "image/png" not allowed —
accepted: application/pdf, …`.

`@keepVersions` prevents the old object from being deleted when the field is updated. Useful for versioned assets or files with external references.

---

## Setup

```js
// lib/db.js
import { createClient } from '@frontierjs/litestone'
import { FileStorage } from '@frontierjs/litestone/storage'

export const db = await createClient({
  path: './schema.lite',
  db:   './app.db',
  plugins: [FileStorage({
    provider:        process.env.R2_ENDPOINT ? 'r2' : 'local',   // ./storage/ until a bucket is configured
    bucket:          process.env.R2_BUCKET,
    endpoint:        process.env.R2_ENDPOINT,    // https://<account>.r2.cloudflarestorage.com
    accessKeyId:     process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    publicBase:      process.env.ASSETS_URL ?? 'http://localhost:3001/storage',   // what a stored ref resolves to
    keyPattern:      ':model/:field/:uuid.:ext',
  })]
})
```

`provider: 'local'` writes to `./storage/` and needs no credentials. With no
`provider` and no `endpoint` at all, the plugin picks `local` when `NODE_ENV`
is `development` or `test` and refuses to build otherwise, so a production
process cannot fall back to a local directory by accident.

A `File` column stores a reference — `{ key, name, provider, bucket, endpoint,
size, mime, uploadedAt }` — and a read resolves it to a URL: the config's
current `publicBase` (or, failing that, the ref's `endpoint`) joined to the key,
so moving hosts re-points every file. With neither,
the field reads back as `null`.

---

## Uploading files

Pass a `Blob`, `File`, `Buffer`, or `ReadableStream` as the field value:

```js
import { FileStorage } from '@frontierjs/litestone/storage'
const db = await createClient({ path: './schema.lite', db: './app.db', plugins: [FileStorage({ provider: 'local', publicBase: 'http://localhost:3001/storage' })] })

const png  = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const file = new File([png], 'me.png', { type: 'image/png' })   // what a multipart parser hands you

await db.user.create({ data: { id: 1, email: 'ada@example.com' } })
await db.user.update({
  where: { id: 1 },
  data:  { avatar: file },
})

const user = await db.user.findUnique({ where: { id: 1 } })
// user.avatar → 'http://localhost:3001/storage/User/avatar/<uuid>.png'  (autoResolve: true by default)
if (!/^http:\/\/localhost:3001\/storage\/User\/avatar\/\w+\.png$/.test(user.avatar)) throw new Error(user.avatar)
```

A write answers its row like a read: the column is the resolved URL, or `null` where
the store has no address. A caller that wants the stored reference asks with
`select: { avatar: { resolve: false } }`, as on a read, and a handler answering a
private file keeps that key to itself:

```js
import { FileStorage } from '@frontierjs/litestone/storage'
const db = await createClient({ path: './schema.lite', db: './app.db', plugins: [FileStorage({ provider: 'local', publicBase: 'http://localhost:3001/storage' })] })
const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'me.png', { type: 'image/png' })
await db.user.create({ data: { id: 1, email: 'ada@example.com' } })
const user = await db.user.update({ where: { id: 1 }, data: { avatar: file }, select: { avatar: { resolve: false } } })
if (user.avatar.mime !== 'image/png') throw new Error(`update() returned ${JSON.stringify(user.avatar)}`)
```

Multiple files. A `File[]` read resolves to the list of URLs; `resolve: false`
returns the stored references:

```js
import { FileStorage } from '@frontierjs/litestone/storage'
const db = await createClient({ path: './schema.lite', db: './app.db', plugins: [FileStorage({ provider: 'local', publicBase: 'http://localhost:3001/storage' })] })
const pdf = new File([new TextEncoder().encode('%PDF-1.4 …')], 'spec.pdf', { type: 'application/pdf' })

await db.document.create({ data: { id: 1, name: 'Spec', ownerId: 1 } })
await db.document.update({
  where: { id: 1 },
  data:  { attachments: [pdf, pdf] },
})

const doc = await db.document.findUnique({ where: { id: 1 } })
// doc.attachments → ['http://…/Document/attachments/<uuid>.pdf', 'http://…/Document/attachments/<uuid>.pdf']
if (doc.attachments.length !== 2) throw new Error(`a File[] read answered ${JSON.stringify(doc.attachments)}`)
```

A type the field does not accept is refused before anything is stored:

```js throws
import { FileStorage } from '@frontierjs/litestone/storage'
const db = await createClient({ path: './schema.lite', db: './app.db', plugins: [FileStorage({ provider: 'local', publicBase: 'http://localhost:3001/storage' })] })
const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'x.png', { type: 'image/png' })
await db.document.create({ data: { id: 1, name: 'Spec', ownerId: 1 } })
await db.document.update({ where: { id: 1 }, data: { attachments: [png] } })
```

---

## Presigned download URLs

For private buckets, generate time-limited presigned URLs. `select: { field:
{ resolve: false } }` returns the stored reference instead of the resolved
URL — necessary for signing:

```js
import { FileStorage, useStorage } from '@frontierjs/litestone/storage'
const db = await createClient({ path: './schema.lite', db: './app.db', plugins: [FileStorage({ provider: 'local', publicBase: 'http://localhost:3001/storage' })] })

const storage = useStorage({
  provider:        process.env.R2_ENDPOINT ? 'r2' : 'local',
  bucket:          process.env.R2_BUCKET,
  endpoint:        process.env.R2_ENDPOINT,
  accessKeyId:     process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
})

const pdf = new File([new TextEncoder().encode('%PDF-1.4 …')], 'spec.pdf', { type: 'application/pdf' })
await db.document.create({ data: { id: 1, name: 'Spec', ownerId: 1, attachments: [pdf] } })

const doc = await db.document.findUnique({
  where:  { id: 1 },
  select: { id: true, attachments: { resolve: false } },  // raw refs, not URLs
})

// Sign each ref for 1 hour
const signedUrls = await Promise.all(
  doc.attachments.map(ref => storage.sign(ref, { expiresIn: 3600 }))
)
if (signedUrls.length !== 1 || !signedUrls[0].includes(doc.attachments[0].key)) throw new Error(JSON.stringify(signedUrls))
```

The local provider signs nothing — `sign()` answers the public URL.

---

## Downloading to buffer

A `File?` reference asked for with `resolve: false` comes back as the stored
object, the same shape a `File[]` item has; `storage.download` and
`storage.sign` read it:

```js
import { FileStorage, useStorage } from '@frontierjs/litestone/storage'
const db = await createClient({ path: './schema.lite', db: './app.db', plugins: [FileStorage({ provider: 'local', publicBase: 'http://localhost:3001/storage' })] })
// Unconfigured, a local store keeps bytes in `files/` beside the database,
// so a separate reader names the same directory.
const storage = useStorage({ provider: 'local', localPath: './files' })

const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], 'me.png', { type: 'image/png' })
await db.user.create({ data: { id: 1, email: 'ada@example.com', avatar: file } })

const user = await db.user.findUnique({
  where:  { id: 1 },
  select: { id: true, avatar: { resolve: false } },
})

const buffer = await storage.download(user.avatar)
// res.set('Content-Type', user.avatar.mime); res.send(buffer)
if (buffer.length !== 11 || user.avatar.mime !== 'image/png') throw new Error(`${buffer.length} ${user.avatar.mime}`)
```

The reference's type is under `mime`, and what is stored is what the bytes
were sniffed as, never only what the client claimed.

---

## Automatic cleanup

FileStorage handles cleanup automatically:

- **On update** — the old object is deleted when a `File?` field is replaced (unless `@keepVersions`)
- **On row delete** — all objects for the row are deleted after the SQL DELETE succeeds
- **On `File[]` update** — objects removed from the array are deleted, new objects uploaded

Cleanup uses `onBeforeDelete` / `onAfterDelete` hooks. If the SQL DELETE fails, no cleanup runs (no orphaned objects).

---

## Serving from a CDN

If your R2 bucket has a public domain (Cloudflare R2's `r2.dev` domain or a custom domain), set it as `publicBase` and files resolve directly to CDN URLs. No presigning needed for public assets:

```js fragment
FileStorage({
  provider:   'r2',
  bucket:     'my-app',
  endpoint:   process.env.R2_ENDPOINT,
  publicBase: 'https://assets.example.com',  // CDN domain
  // ...
})
```

`user.avatar` → `'https://assets.example.com/User/avatar/<uuid>.jpg'`

The base is written into each stored reference at upload time, so a reference
uploaded before the domain was configured keeps resolving against the endpoint.
