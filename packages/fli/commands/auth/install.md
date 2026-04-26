---
title: auth:install
description: Install FJS native authentication — injects schema models, generates keys, scaffolds auth.ts
alias: auth-install
examples:
  - fli auth:install
  - fli auth:install --db auth
  - fli auth:install --dry
flags:
  db:
    char: d
    type: string
    description: Database block to use for auth tables (must exist in schema.lite)
    defaultValue: main
  dry:
    type: boolean
    description: Show what would be done without writing anything
    defaultValue: false
  open:
    char: o
    type: boolean
    description: Open scaffolded auth.ts in editor after install
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve }                                             from 'path'

// ─── Auth schema fragments ────────────────────────────────────────────────────
// Injected at the end of schema.lite.
// @@db is parameterized from --db flag.

const authSchemaFragments = (db) => `
// ─── Auth — injected by fli auth:install ─────────────────────────────────────

model users {
  id            Text      @id @default(uuid())
  email         Text      @email @unique @lower
  name          Text?     @trim
  emailVerified Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @default(now()) @updatedAt

  @@db(${db})
  @@gate("9.9.4.9")
  @@log(audit)
}

model credentials {
  id             Integer   @id
  userId         Text
  type           Text
  value          Text      @guarded(all)
  label          Text?
  accessToken    Text?     @secret
  refreshToken   Text?     @secret
  tokenExpiresAt DateTime?
  scope          Text?
  createdAt      DateTime  @default(now())

  @@db(${db})
  @@gate("9.9.9.9")
  @@index([userId, type])
  @@index([type, value])
}

model sessions {
  id        Text     @id @default(uuid())
  userId    Text
  token     Text     @unique @guarded(all)
  expiresAt DateTime
  ipAddress Text?
  userAgent Text?
  createdAt DateTime @default(now())

  @@db(${db})
  @@gate("9.9.9.9")
  @@log(audit)
}

model verifications {
  id         Integer  @id
  identifier Text
  value      Text     @guarded(all)
  expiresAt  DateTime
  createdAt  DateTime @default(now())

  @@db(${db})
  @@gate("9.9.9.9")
  @@index([identifier])
}
`

// ─── auth.ts scaffold ─────────────────────────────────────────────────────────

const authScaffold = (db) => `import { createFjsAuth, createAuthCleanupJobs } from '@frontierjs/auth'
import { createClient, GatePlugin, LEVELS }       from '@frontierjs/litestone'
import { defineEnv }                               from '@frontierjs/junction'

// ─── Env ──────────────────────────────────────────────────────────────────────

export const env = defineEnv({
  ENCRYPTION_KEY: { required: true, minLength: 64, description: 'AES-256 key for @secret fields (64 hex chars)' },
  AUTH_SECRET:    { required: true, minLength: 64, description: 'Auth signing secret (64 hex chars)' },
  APP_URL:        { required: true,                description: 'Base URL for verification links' },
})

// ─── Database ─────────────────────────────────────────────────────────────────

export const db = await createClient('./db/schema.lite', {
  encryption: { key: env.ENCRYPTION_KEY },
  plugins: [
    new GatePlugin({
      getLevel(user) {
        if (!user)                        return LEVELS.STRANGER
        if (user.userType === 'admin')    return LEVELS.ADMINISTRATOR
        return LEVELS.USER
      }
    })
  ]
})

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const auth = createFjsAuth(db, {
  sessionTtl:           '30 days',
  passwordResetTtl:     '1 hour',
  emailVerificationTtl: '24 hours',

  // Wire these to your mailer once you have one configured:
  // onPasswordResetRequested: async (email, token) => {
  //   await mailer.send({
  //     to:      email,
  //     subject: 'Reset your password',
  //     html:    \`<a href="\${env.APP_URL}/auth/password-reset/confirm?token=\${token}">Reset password</a>\`,
  //   })
  // },
  // onEmailVerificationRequested: async (email, token) => {
  //   await mailer.send({
  //     to:      email,
  //     subject: 'Verify your email',
  //     html:    \`<a href="\${env.APP_URL}/auth/email/verify?token=\${token}">Verify email</a>\`,
  //   })
  // },
})

// ─── Cleanup jobs (expired sessions + verifications) ──────────────────────────

export const authCleanup = createAuthCleanupJobs(db)
`

// ─── server.ts wiring hint ────────────────────────────────────────────────────

const serverHint = `
// ─── Add to api/src/server.ts ──────────────────────────────────────────────────

import { auth, db, authCleanup }           from './auth.ts'
import { createFjsAuthPlugin }             from '@frontierjs/auth'
import { withLitestoneDb }                 from '@frontierjs/junction'

const app = createApp({ auth })

app.configure(createFjsAuthPlugin(auth, {
  prefix:    '/auth',
  cookieAuth: false,
}))

app.configure(withLitestoneDb(db))

// Start cleanup jobs after app starts
app.configure({
  name: 'auth-cleanup',
  register() {},
  async boot() { authCleanup.start() },
})
`

// ─── .env.example entries ─────────────────────────────────────────────────────

const envExampleEntries = `
# Auth — generated by fli auth:install
ENCRYPTION_KEY=   # 64 hex chars — fli keygen aes --name ENCRYPTION_KEY --env
AUTH_SECRET=      # 64 hex chars — fli keygen --name AUTH_SECRET --env
APP_URL=          # e.g. https://myapp.com
`
</script>

Installs FJS native authentication into the current project.

What it does:
- Injects `users`, `credentials`, `sessions`, `verifications` into `db/schema.lite`
- Pushes the schema changes to the database
- Generates `ENCRYPTION_KEY` and `AUTH_SECRET` in `.env`
- Scaffolds `api/src/auth.ts` with `createFjsAuth` wired up
- Prints the two lines to add to `api/server.ts`

```js
const schemaPath  = resolve(context.paths.db,  'schema.lite')
const authTsPath  = resolve(context.paths.api, 'src/auth.ts')
const envPath     = resolve(context.paths.root, '.env')
const envExPath   = resolve(context.paths.root, '.env.example')
const editor      = process.env.EDITOR || 'vi'

// ─── 1. Preflight checks ──────────────────────────────────────────────────────

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  log.info('Run fli db:push first to create the database')
  return
}

const schemaContents = readFileSync(schemaPath, 'utf8')

const alreadyInstalled = ['model users', 'model sessions', 'model credentials', 'model verifications']
  .every(m => schemaContents.includes(m))

if (alreadyInstalled) {
  log.warn('Auth models already present in schema.lite — skipping schema injection')
  log.info('Run fli auth:create-user to add your first user')
  return
}

// Check the requested db block exists
if (flag.db !== 'main') {
  const dbBlockRegex = new RegExp(`database\\s+${flag.db}\\s*\\{`)
  if (!dbBlockRegex.test(schemaContents)) {
    log.error(`Database block '${flag.db}' not found in schema.lite`)
    log.info(`Add a 'database ${flag.db} { path ... }' block to schema.lite first`)
    return
  }
}

echo('')
log.info('Installing FJS auth...')
echo('')

// ─── 2. Inject schema fragments ───────────────────────────────────────────────

if (flag.dry) {
  log.dry(`Would append auth models to ${schemaPath}`)
} else {
  const fragments = authSchemaFragments(flag.db)
  writeFileSync(schemaPath, schemaContents + fragments, 'utf8')
  log.success('Injected auth models into schema.lite')
}

// ─── 3. Push schema to database ───────────────────────────────────────────────

if (flag.dry) {
  log.dry('Would run: fli db:push')
} else {
  log.info('Pushing schema to database...')
  context.exec({ command: `cd ${context.paths.root} && bun run litestone push --schema db/schema.lite` })
  log.success('Schema pushed')
}

// ─── 4. Generate ENCRYPTION_KEY ───────────────────────────────────────────────

const encKeyExists = existsSync(envPath) && readFileSync(envPath, 'utf8').includes('ENCRYPTION_KEY=')

if (encKeyExists) {
  log.info('ENCRYPTION_KEY already set in .env — skipping')
} else if (flag.dry) {
  log.dry('Would generate ENCRYPTION_KEY (64 hex chars) → .env')
} else {
  context.exec({ command: `cd ${context.paths.root} && fli keygen aes --name ENCRYPTION_KEY --env --format hex` })
  log.success('Generated ENCRYPTION_KEY → .env')
}

// ─── 5. Generate AUTH_SECRET ──────────────────────────────────────────────────

const authSecretExists = existsSync(envPath) && readFileSync(envPath, 'utf8').includes('AUTH_SECRET=')

if (authSecretExists) {
  log.info('AUTH_SECRET already set in .env — skipping')
} else if (flag.dry) {
  log.dry('Would generate AUTH_SECRET (64 hex chars) → .env')
} else {
  context.exec({ command: `cd ${context.paths.root} && fli keygen --name AUTH_SECRET --env --format hex --length 32` })
  log.success('Generated AUTH_SECRET → .env')
}

// ─── 6. Append .env.example entries ──────────────────────────────────────────

if (!flag.dry && existsSync(envExPath)) {
  const envExContents = readFileSync(envExPath, 'utf8')
  if (!envExContents.includes('ENCRYPTION_KEY')) {
    writeFileSync(envExPath, envExContents + envExampleEntries, 'utf8')
    log.success('Appended auth vars to .env.example')
  }
}

// ─── 7. Scaffold api/src/auth.ts ──────────────────────────────────────────────

if (existsSync(authTsPath)) {
  log.warn(`${authTsPath} already exists — skipping scaffold`)
} else if (flag.dry) {
  log.dry(`Would create ${authTsPath}`)
} else {
  const srcDir = resolve(context.paths.api, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(authTsPath, authScaffold(flag.db), 'utf8')
  log.success(`Created api/src/auth.ts`)
}

// ─── 8. Print server.ts wiring hint ──────────────────────────────────────────

echo('')
log.success('Auth installed')
echo('')
echo('  Next — add to api/src/server.ts:')
echo('')
for (const line of serverHint.trim().split('\n')) {
  echo(`  ${line}`)
}

echo('')
echo('  Then create your first user:')
echo('    fli auth:create-user your@email.com --role admin')
echo('')

// ─── 9. Open auth.ts if requested ─────────────────────────────────────────────

if (flag.open && !flag.dry && existsSync(authTsPath)) {
  context.exec({ command: `${editor} "${authTsPath}"` })
}
```
