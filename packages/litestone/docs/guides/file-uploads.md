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

## Setup

```js
// lib/db.js
import { createClient, FileStorage } from '@frontierjs/litestone'

export const db = await createClient({
  path: './schema.lite',
  plugins: [FileStorage({
    provider:        'r2',
    bucket:          process.env.R2_BUCKET,
    endpoint:        process.env.R2_ENDPOINT,    // https://<account>.r2.cloudflarestorage.com
    accessKeyId:     process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    keyPattern:      ':model/:id/:field/:uuid.:ext',
    dev:             'local',   // falls back to ./storage/ in development
  })]
})
```

`dev: 'local'` means no S3 config is needed during local development — files are written to `./storage/`.

---

## Schema

```prisma
model User {
  id     Integer @id
  email  Text    @unique
  avatar File?                                  // single optional file
}

model Document {
  id          Integer  @id
  name        Text
  ownerId     Integer
  attachments File[]   @accept("application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  images      File[]   @accept("image/*")       // wildcard — any image type
  banner      File?    @keepVersions            // old file kept on update
  createdAt   DateTime @default(now())
}
```

`@accept` validates the MIME type of the uploaded file before storing. It throws a `ValidationError` with a descriptive message if the type doesn't match.

`@keepVersions` prevents the old S3 object from being deleted when the field is updated. Useful for versioned assets or files with external references.

---

## Uploading files

Pass a `Blob`, `File`, `Buffer`, or `ReadableStream` as the field value:

```js
// Route handler — multipart form upload
app.post('/users/:id/avatar', async (req, res) => {
  const file = req.files.avatar   // Blob or File from multipart parser

  const user = await req.db.user.update({
    where: { id: Number(req.params.id) },
    data:  { avatar: file },
  })

  // user.avatar → resolved URL (autoResolve: true by default)
  res.json({ avatarUrl: user.avatar })
})
// → { avatarUrl: 'https://cdn.example.com/users/1/avatar/abc123.jpg' }
```

Multiple files:

```js
app.post('/documents/:id/attachments', async (req, res) => {
  const files = req.files.attachments   // array of Blobs

  const doc = await req.db.document.update({
    where: { id: Number(req.params.id) },
    data:  { attachments: files },
  })

  res.json({ attachments: doc.attachments })
  // → { attachments: ['https://...', 'https://...'] }
})
```

---

## Presigned download URLs

For private buckets, generate time-limited presigned URLs:

```js
import { useStorage } from '@frontierjs/litestone'

const storage = useStorage({
  provider:        'r2',
  bucket:          process.env.R2_BUCKET,
  endpoint:        process.env.R2_ENDPOINT,
  accessKeyId:     process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
})

app.get('/documents/:id/download/:field', async (req, res) => {
  const doc = await req.db.document.findUnique({
    where:  { id: Number(req.params.id) },
    select: { id: true, attachments: { resolve: false } },  // get raw refs, not URLs
  })

  // Sign each ref for 1 hour
  const signedUrls = await Promise.all(
    doc.attachments.map(ref => storage.sign(ref, { expiresIn: 3600 }))
  )

  res.json({ urls: signedUrls })
})
```

`select: { field: { resolve: false } }` returns the raw reference object instead of the resolved URL — necessary for signing.

---

## Downloading to buffer

```js
app.get('/users/:id/avatar/download', async (req, res) => {
  const user = await req.db.user.findUnique({
    where:  { id: Number(req.params.id) },
    select: { id: true, avatar: { resolve: false } },
  })

  const buffer = await storage.download(user.avatar)
  res.set('Content-Type', user.avatar.type)
  res.send(buffer)
})
```

---

## Automatic cleanup

FileStorage handles cleanup automatically:

- **On update** — old S3 object is deleted when a `File?` field is replaced (unless `@keepVersions`)
- **On row delete** — all S3 objects for the row are deleted after the SQL DELETE succeeds
- **On `File[]` update** — objects removed from the array are deleted, new objects uploaded

Cleanup uses `onBeforeDelete` / `onAfterDelete` hooks. If the SQL DELETE fails, no S3 cleanup runs (no orphaned objects).

---

## Serving from a CDN

If your R2 bucket has a public domain (Cloudflare R2's `r2.dev` domain or a custom domain), files resolve directly to CDN URLs. No presigning needed for public assets:

```js
FileStorage({
  provider:   'r2',
  bucket:     'my-app',
  endpoint:   process.env.R2_ENDPOINT,
  publicUrl:  'https://assets.example.com',  // CDN domain
  // ...
})
```

`user.avatar` → `'https://assets.example.com/users/1/avatar/abc123.jpg'`
