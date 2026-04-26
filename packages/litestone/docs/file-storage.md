# File Storage

The `FileStorage` plugin stores file bytes in S3-compatible object storage (Cloudflare R2, Backblaze B2, AWS S3, MinIO) or local disk, while keeping a JSON reference object in SQLite. The ORM handles upload, cleanup, and URL resolution transparently.

## Setup

```js
import { FileStorage } from '@frontierjs/litestone'

const db = await createClient({
  path: './schema.lite',
  plugins: [FileStorage({
    provider:        'r2',
    bucket:          'my-app',
    endpoint:        process.env.S3_ENDPOINT,
    accessKeyId:     process.env.S3_KEY,
    secretAccessKey: process.env.S3_SECRET,
    keyPattern:      ':model/:id/:field/:uuid.:ext',  // object key template
    dev:             'local',   // fallback to ./storage/ when no endpoint
  })]
})
```

## Schema

```prisma
model User {
  avatar  File?              // single file — uploaded on create/update, deleted on row delete
  resume  File?  @keepVersions  // keep old S3 object when field is updated
  photos  File[]             // multiple files — stored as JSON array of refs
  docs    File[] @accept("application/pdf,application/msword")
  banner  File?  @accept("image/*")   // wildcards supported
}
```

## Usage

```js
// Create with file — pass a Blob, File, Buffer, or ReadableStream
const user = await db.user.create({
  data: { email: 'alice@example.com', avatar: avatarFile }
})

// Update file — old object deleted automatically (unless @keepVersions)
const updated = await db.user.update({
  where: { id: 1 },
  data:  { avatar: newAvatarFile }
})

// Delete row — file objects deleted from S3 automatically
await db.user.delete({ where: { id: 1 } })

// Multiple files
const u2 = await db.user.update({
  where: { id: 1 },
  data:  { photos: [photo1, photo2, photo3] }
})
```

## Resolving URLs

With `autoResolve: true` (the default), file fields return URLs directly — no extra step needed:

```js
user.avatar   // → 'https://cdn.example.com/users/1/avatar/abc123.jpg'
user.photos   // → ['https://...', 'https://...']
```

To get the raw reference object (for custom signing, etc.):

```js
const user = await db.user.findUnique({
  where:  { id: 1 },
  select: { id: true, avatar: { resolve: false } }
})
user.avatar   // → { key: 'users/1/avatar/abc123.jpg', size: 42048, type: 'image/jpeg' }
```

## Utilities

```js
import { fileUrl, fileUrls, useStorage } from '@frontierjs/litestone'

// Derive URL from a ref object
fileUrl(user.avatar)       // → 'https://...'
fileUrls(user.photos)      // → ['https://...', ...]

// Storage operations
const storage = useStorage(config)
await storage.sign(user.avatar, { expiresIn: 3600 })  // presigned URL
await storage.download(user.avatar)                    // → Buffer
await storage.delete(user.avatar)                      // manual cleanup
```

## Orphan prevention

Hook sequencing ensures no orphaned S3 objects:

- `onBeforeCreate`/`onBeforeUpdate` — serializes file to S3, stores ref in SQLite
- `onBeforeDelete` — stashes the S3 key before the SQL DELETE runs
- `onAfterDelete` — deletes from S3 only after SQL succeeds (SQL failure = no cleanup)

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
