# Files

A `File` field keeps bytes in object storage and a small reference in SQLite. Upload, URL resolution and cleanup happen on ordinary creates, updates and deletes.

```lite
model User {
  id     Int    @id
  email  String
  avatar File?  @accept("image/*")
}
```

The `local` provider writes to a folder; `r2`, `s3`, `b2` and `minio` write to a bucket.

```js
import { FileStorage } from '@frontierjs/litestone/storage'

const db = await createClient({
  path: './schema.lite', db: ':memory:',
  plugins: [FileStorage({ provider: 'local', localPath: './storage', publicBase: 'https://cdn.example.com' })],
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

await db.user.create({ data: { id: 1, email: 'a@example.com', avatar: new File([png], 'a.png', { type: 'image/png' }) } })

const user = await db.user.findUnique({ where: { id: 1 } })
if (!String(user.avatar).startsWith('https://cdn.example.com/User/avatar/')) throw new Error(`expected a URL, got ${user.avatar}`)
```

## What else it can do

- `File[]` holds several files as a list of references
- `@accept("image/*")` grades the bytes, not the file name, and a refusal is a `ValidationError`
- A read resolves the reference to a URL; `select: { avatar: { resolve: false } }` returns the reference
- Replacing a file deletes the old object, unless the field is `@keepVersions`
- Deleting the row deletes its objects, and a failed write deletes the ones it stored
- A `File`, `Blob`, `Buffer`, `Uint8Array`, `ArrayBuffer` or base64 data URL is accepted as input
- `fromPath` and `fromStream` store a file from disk or a request body without holding it whole
- `@digest(sha256)` keeps a `String` column following the file's SHA-256
- `useStorage(config)` gives `url`, `sign`, `download`, `stream`, `path` and `delete`
- `keyPattern` sets the object key, such as `:model/:field/:uuid.:ext`
- `ExternalRefPlugin` builds a field type for another backend

**In depth:** [File storage](../../file-storage.md), [§ Usage](../../file-storage.md#usage), [§ Resolving URLs](../../file-storage.md#resolving-urls), [§ Orphan prevention](../../file-storage.md#orphan-prevention), [Guide: File uploads](../../guides/file-uploads.md)
