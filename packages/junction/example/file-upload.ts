// example/file-upload.ts — @file integration with Junction
//
// Three patterns shown:
//
//   A) Standard upload  — client POSTs multipart to the API, bridge merges
//                         the File into ctx.data, Litestone plugin uploads to R2
//
//   B) Response shaping — after hooks expand stored JSON refs to URLs
//                         so callers never see raw JSON blobs
//
//   C) Presigned upload — for large files, API issues a presigned URL,
//                         client uploads directly to R2, then PATCH the ref in
//
// Run: bun run example/file-upload.ts

import {
  createApp,
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
  useStorage,
  generateJsonSchema,
} from '@frontierjs/litestone'

import type { ServiceContext } from '../src/transport/bridge.ts'

const log = createLogger({ ns: 'file-example' })

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  model users {
    id        Integer  @id
    name      Text     @trim @length(1, 100)
    avatar    File?
    resume    File?    @keepVersions
    createdAt DateTime @default(now())
    updatedAt DateTime @default(now()) @updatedAt
  }
`

// ─── Storage config ───────────────────────────────────────────────────────────

const storageConfig = {
  provider:        process.env.S3_PROVIDER ?? 'r2',
  bucket:          process.env.S3_BUCKET   ?? 'my-app',
  endpoint:        process.env.S3_ENDPOINT,
  accessKeyId:     process.env.S3_KEY,
  secretAccessKey: process.env.S3_SECRET,
  publicBase:      process.env.CDN_BASE,
  keyPattern:      ':model/:id/:field/:uuid.:ext',
  dev:             'local',
}

// ─── DB ───────────────────────────────────────────────────────────────────────

const db = await createClient('./users.db', SCHEMA, {
  plugins: [FileStorage(storageConfig)]
})

autoMigrate(db)
const jsonSchema = generateJsonSchema(db.$schema)

// ─── Pattern B: expand file refs to URLs in after hooks ───────────────────────
//
// Stored value in SQLite is a JSON ref object.
// Callers want a URL. One after hook on all methods handles it.

function expandFileRefs(result: unknown) {
  const rows = Array.isArray(result)      ? result
    : (result as Record<string, unknown>)?.data ? (result as Record<string, unknown>).data as unknown[]
    : result ? [result]
    : []
  for (const row of (rows as Record<string, unknown>[])) {
    if (row.avatar) row.avatar = fileUrl(row.avatar as string) ?? row.avatar
    if (row.resume) row.resume = fileUrl(row.resume as string) ?? row.resume
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

const tokens = new Map<string, string>()

const app = createApp({
  config: { ...defaultConfig, port: 3000, database: { url: '', log: false } },
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

app.services.register(
  createService({
    name:   'users',
    model:  'users',
    schema: jsonSchema,  // @file fields mapped to type:'any' — validation skipped

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

app.patch('/api/users/:id/avatar', async ctx => {
  // ctx.files is UploadedFile[] — already parsed by Junction's body parser
  const upload = ctx.files.find(f => f.name === 'avatar')
  if (!upload) return ctx.json({ message: 'avatar file required' }, 400)

  // Construct a File object for Litestone's plugin to detect
  const file     = new File([upload.data], upload.filename, { type: upload.type })
  const userId   = parseInt(ctx.params.id)
  const scopedDb = db

  const user = await scopedDb.users.update({
    where: { id: userId },
    data:  { avatar: file },
  })

  if (!user) return ctx.json({ message: 'not found' }, 404)

  return ctx.json({ ...user as object, avatar: fileUrl((user as Record<string, unknown>).avatar as string) })
})

// ─── Pattern C: presigned upload ─────────────────────────────────────────────
//
// For large files (>10MB), skip the server entirely.
// Flow:
//   1. POST /api/users/:id/avatar/presign → { uploadUrl, ref }
//   2. Client PUT <uploadUrl> with file bytes directly to R2
//   3. Client PATCH /api/users/:id { avatar: JSON.stringify(ref) }
//
// On step 3, Litestone's plugin sees a string (not a File), recognises it as
// an existing ref, and stores it as-is. No re-upload.

const storage = useStorage(storageConfig)

app.post('/api/users/:id/avatar/presign', async ctx => {
  if (!ctx.user) return ctx.json({ message: 'auth required' }, 401)

  const userId   = parseInt(ctx.params.id)
  const { filename = 'avatar', contentType = 'application/octet-stream' } =
    (ctx.body ?? {}) as { filename?: string; contentType?: string }

  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  const key = `users/${userId}/avatar/${crypto.randomUUID()}${ext}`

  const uploadUrl = await storage.sign(key, { expiresIn: 600 })

  return ctx.json({
    uploadUrl,
    method: 'PUT',
    ref: {
      key,
      bucket:    storageConfig.bucket,
      provider:  storageConfig.provider,
      endpoint:  storageConfig.endpoint ?? null,
      publicBase: storageConfig.publicBase ?? null,
    },
    instructions: 'PUT the file to uploadUrl, then PATCH the user with JSON.stringify(ref) as avatar',
  })
})

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
log.info('  PATCH /api/users/:id/avatar  direct multipart upload')
log.info('  POST /api/users/:id/avatar/presign  get presigned upload URL')
