// example/file-upload.ts — @file integration with Junction
//
// Two patterns shown:
//
//   A) Standard upload  — client POSTs multipart to the API, bridge merges
//                         the File into ctx.data, Litestone plugin uploads to R2
//
//   B) Response shaping — after hooks expand stored JSON refs to URLs
//                         so callers never see raw JSON blobs
//
// A third — presigned direct-to-bucket upload — is NOT supported by litestone's
// storage API today. See the note further down rather than the route that used
// to sit there.
//
// Runs offline with no credentials — files land in ./example-storage via the
// local provider. Set S3_KEY + S3_SECRET to exercise the real R2/S3 path.
//
// Run: bun run example/file-upload.ts
//
//   TOKEN=$(curl -s -X POST localhost:3000/auth/login \
//     -H 'content-type: application/json' -d '{"username":"demo"}' | jq -r .token)
//
//   curl -X POST localhost:3000/api/users -H "authorization: Bearer $TOKEN" \
//     -F name=Bob -F avatar=@some.jpg          # multipart create + upload
//   curl localhost:3000/api/users -H "authorization: Bearer $TOKEN"
//                                              # avatar comes back as a URL

import {
  createApp,
  createService,
  createLogger,
  authenticate,
  correlationId,
  requestLogger,
  defaultConfig,
  cors,
} from '../index.ts'

import { withLitestoneDb } from '../src/core/litestone.ts'

import {
  createClient,
  autoMigrate,
  FileStorage,
  fileUrl,
} from '@frontierjs/litestone'

import type { ServiceContext } from '../src/transport/bridge.ts'

const log = createLogger({ ns: 'file-example' })

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  model User {
    id        Int  @id
    name      String     @trim @length(1, 100)
    avatar    File?
    resume    File?    @keepVersions
    createdAt DateTime @default(now())
    updatedAt DateTime @default(now()) @updatedAt
  }
`

// ─── Storage config ───────────────────────────────────────────────────────────

// Runs offline by default. createProvider() picks the S3-compatible provider
// for anything that is not literally `provider: 'local'` — it does NOT read a
// `dev` key (this example used to pass `dev: 'local'`, which is not a thing, so
// with no credentials every upload died on `secret.length` inside the signer).
// Set S3_KEY + S3_SECRET to exercise the real R2/S3 path.

const hasS3Credentials = Boolean(process.env.S3_KEY && process.env.S3_SECRET)

const storageConfig = hasS3Credentials
  ? {
      provider:        process.env.S3_PROVIDER ?? 'r2',
      bucket:          process.env.S3_BUCKET   ?? 'my-app',
      endpoint:        process.env.S3_ENDPOINT,
      accessKeyId:     process.env.S3_KEY,
      secretAccessKey: process.env.S3_SECRET,
      publicBase:      process.env.CDN_BASE,
      keyPattern:      ':model/:id/:field/:uuid.:ext',
    }
  : {
      provider:   'local',
      bucket:     'my-app',
      localPath:  './example-storage',              // files land here
      localUrl:   'http://localhost:3000/storage',
      // publicBase is copied INTO each stored ref at write time, and fileUrl()
      // reads it back out. Without it fileUrl() returns null and Pattern B
      // below silently falls back to showing the raw JSON ref.
      publicBase: 'http://localhost:3000/storage',
      keyPattern: ':model/:id/:field/:uuid.:ext',
    }

// ─── DB ───────────────────────────────────────────────────────────────────────

const db = await createClient({
  db:      './users.db',
  schema:  SCHEMA,
  plugins: [FileStorage(storageConfig)],
})

autoMigrate(db)

// ─── Pattern B: expand file refs to URLs in after hooks ───────────────────────
//
// Stored value in SQLite is a JSON ref object.
// Callers want a URL. One after hook on all methods handles it.

// Normalising the result is the whole trick, and the reason this used to 500.
// ctx.result is a ServiceResult envelope; `kind` says which shape `data` is:
//   kind: 'list'   → data is an array of rows
//   kind: 'single' → data is ONE row object
// The old version did `result.data ? result.data as unknown[] : …` and then
// `for (const row of rows)`, so every single-record write hit
// `for (const row of {})` → "{} is not iterable". Lists worked, writes 500'd.

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object') return []
  const r       = result as Record<string, unknown>
  const payload = ('kind' in r && 'data' in r) ? r.data : r   // envelope or bare
  if (!payload || typeof payload !== 'object') return []
  return (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[]
}

function expandFileRefs(result: unknown) {
  for (const row of rowsOf(result)) {
    if (row.avatar) row.avatar = fileUrl(row.avatar as string) ?? row.avatar
    if (row.resume) row.resume = fileUrl(row.resume as string) ?? row.resume
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

const tokens = new Map<string, string>()

const app = createApp({
  // apiPrefix defaults to '' — without it the users service mounts at /users
  // while the hand-written avatar route below sits at /api/users/..., putting
  // the two halves of the documented flow on different paths.
  config: { ...defaultConfig, port: 3000, apiPrefix: '/api', database: { url: '', log: false } },
  auth: {
    async verifySession(token: string) {
      const userId = tokens.get(token)
      if (!userId) return null
      return { userId: userId, userType: 'user', authMethod: 'session' as const, role: 'user', scopes: [] }
    },
    async login()          { return { token: '', user: null as never } },
    async logout()         { return },
    async createUser()     { return { userId: '', userType: 'user', authMethod: 'session' as const, role: 'user', scopes: [] } },
    async deleteUser()     { return },
    async createApiKey(id) { return { key: `key-${id}`, id: `key-${id}` } },
    async revokeApiKey()   { return },
    async verifyApiKey()   { return null },
  }
})

app.configure(cors({ origins: ['*'] }))
app.configure(correlationId())
app.configure(requestLogger())

// Single-arg — scoping happens inside getTable() at call time
app.hooks({
  around: { all: [withLitestoneDb(db)] }
})

// ─── Pattern A: standard CRUD with multipart ──────────────────────────────────
//
// The bridge automatically merges multipart files into ctx.data as File objects.
// For multipart/form-data with avatar=<file bytes>, the bridge builds:
//   ctx.data = { name: 'Alice', avatar: File { ... } }
//
// Litestone's FileStorage plugin detects the File instance, uploads to R2,
// and swaps ctx.data.avatar with a JSON ref before the DB write. The service
// method never knows files were involved.

// NOTE: no `schema:` here, deliberately.
//
// generateJsonSchema() emits a File field as
//   avatar: { anyOf: [ { $ref: '#/$defs/FileRef' }, { type: 'null' } ] }
// and Junction's validator does not resolve `$ref`/`$defs` — it fails with
// "{} is not iterable" on every write. Passing the generated schema here made
// `POST /api/users` a 500 for any model with a File field. (The older comment
// claimed @file fields map to `type: 'any'` and are skipped; they don't.)
//
// Dropping it costs the schema-derived 400s on this one service and keeps the
// example runnable. The real fix is $ref resolution in the validator —
// src/core/schema.ts — which is a framework change, not an example change.

app.services.register(
  createService({
    name:   'users',
    model:  'user',

    hooks: {
      before: {
        create: [authenticate],
        patch:  [authenticate],
        remove: [authenticate],
      },
      after: {
        all: [async (ctx: ServiceContext) => {
          if (ctx.result) expandFileRefs(ctx.result)
        }],
      },
    },
  })
)

// ─── Pattern A: custom route variant ─────────────────────────────────────────
//
// When you need more control than createService provides,
// access uploaded files via ctx.files — Junction's already-parsed file list.
// No manual formData() parsing needed.

app.patch('/api/users/{id}/avatar', async ctx => {
  // ctx.files is UploadedFile[] — already parsed by Junction's body parser
  const upload = ctx.files.find(f => f.name === 'avatar')
  if (!upload) return ctx.json({ message: 'avatar file required' }, 400)

  // Construct a File object for Litestone's plugin to detect
  const file     = new File([upload.data], upload.filename, { type: upload.type })
  const userId   = parseInt(ctx.params.id)
  const scopedDb = db

  const user = await scopedDb.user.update({
    where: { id: userId },
    data:  { avatar: file },
  })

  if (!user) return ctx.json({ message: 'not found' }, 404)

  return ctx.json({ ...user as object, avatar: fileUrl((user as Record<string, unknown>).avatar as string) })
})

// ─── Pattern C: presigned direct-to-bucket upload — NOT SUPPORTED YET ────────
//
// This example used to carry a working-looking /avatar/presign route. It could
// never have worked, and it is removed rather than left as a demo of an API
// that does not exist:
//
//   • litestone's `useStorage().sign(value)` signs an EXISTING stored file
//     reference. It runs the value through parseRef() and throws
//     "invalid file reference" on a bare key like `users/1/avatar/x.jpg`.
//   • The URL it mints is a GET. `provider.sign()` calls
//     `presignUrl('GET', …)` — S3 provider, src/storage/providers/s3.js.
//     The local dev provider does not sign at all; it returns the public URL.
//   • Nothing in litestone ever calls `presignUrl` with 'PUT', so there is no
//     upload URL to hand a browser.
//
// The primitive is close: `presignUrl(method, url, opts, expiresIn)` in
// litestone's src/storage/sigv4.js already takes a method. Presigned uploads
// need a `signUpload(key, { expiresIn, contentType })` on the provider and on
// useStorage() — a litestone feature, not something this example can fake.
//
// Until then, Pattern A (multipart through the API) is the supported path.

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/auth/login', async ctx => {
  const { username } = (ctx.body ?? {}) as { username?: string }
  if (!username) return ctx.json({ error: 'username required' }, 400)
  const token = `tok-${username}-${Date.now()}`
  tokens.set(token, `user-${username}`)
  return ctx.json({ token })
})

// ─── Start ────────────────────────────────────────────────────────────────────

await app.start()

log.info('file upload server running')
log.info('  POST /auth/login')
log.info('  GET  /api/users              list users (avatar expanded to URL)')
log.info('  POST /api/users              create user (multipart or JSON)')
log.info('  PATCH /api/users/{id}/avatar  direct multipart upload')
