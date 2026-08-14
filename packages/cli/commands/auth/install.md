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
//
// KEEP IN SYNC WITH `packages/auth/schema.ts` — this used to be a hand-copy that
// had drifted: pre-rename scalars (Text/Integer, which no longer parse), no
// `role`/`accountId` on User, no Session indexes, and `@@gate("9…")`. Nine is
// LOCKED — an absolute wall nothing can pass, `asSystem()` included — so the
// generated schema locked the auth tables against the auth package itself.
// SYSTEM is 8.

const authSchemaFragments = (db) => `
// ─── Auth — injected by fli auth:install ─────────────────────────────────────
// Users:         identity table — who you are
// Credentials:   how you prove it — passwords, API keys, OAuth tokens
// Sessions:      are you currently logged in
// Verifications: ephemeral tokens — password reset, email verify

model User {
  id             String    @id @default(uuid())
  email          String    @email @unique @lower
  name           String?   @trim
  // The two columns a caller must not write about themselves. role is what an
  // app's own resolver grades on, and marking your own address verified is
  // skipping the verification. auth().isAdmin is the standing
  // FrontierGateGetLevel and sessionGateLevel() both read for ADMINISTRATOR(5),
  // so the level that may delete a person is the level that may set their role
  // — one idea, not two. asSystem() writes both regardless, which is how this
  // package sets them.
  emailVerified  Boolean   @default(false) @allow('write', auth().isAdmin)
  role           String    @default("user") @allow('write', auth().isAdmin)
  accountId      Int?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @default(now()) @updatedAt

  @@db(${db})
  // R.C.U.D. Read, create and update are USER: an app's own screens list its
  // people, and a signed-in caller edits their own profile. Delete is
  // ADMINISTRATOR — removing a person is not self-service.
  //
  // A GATE IS PER MODEL, NOT PER ROW, so the level alone would say *any
  // signed-in caller may write any user row*. The policy is what makes it
  // their own row, and an admin's the exception — the same standing the gate's
  // delete position names. Together with the two field policies above, this is
  // the whole shape an app needs: a level for what kind of caller, a policy for
  // whose row, and a field policy for the columns the level itself is graded
  // from. A column the caller can write is not a column a level can be graded
  // from.
  //
  // Registration is unaffected: every write this package makes goes through
  // asSystem(), which is above the ladder. The three models below stay at 8 —
  // they hold the credential material, and that is the case 8 is for.
  // Hand copy of packages/auth/schema.ts — change one, change both.
  @@gate("4.4.4.5")
  @@allow('update', id == auth().id || auth().isAdmin)
  @@log(audit)
}

model Credential {
  id              Int        @id
  userId          String
  type            String
  value           String     @guarded(all)
  label           String?
  accessToken     String?    @secret
  refreshToken    String?    @secret
  tokenExpiresAt  DateTime?
  scope           String?
  createdAt       DateTime   @default(now())

  @@db(${db})
  @@gate("8")
  @@index([userId, type])
  @@index([type, value])
}

model Session {
  id         String    @id @default(uuid())
  userId     String
  token      String    @unique @guarded(all)
  expiresAt  DateTime
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime  @default(now())

  @@db(${db})
  @@gate("8")
  @@log(audit)
  @@index([userId])
  @@index([expiresAt])
}

model Verification {
  id          Int       @id
  identifier  String
  value       String    @guarded(all)
  expiresAt   DateTime
  createdAt   DateTime  @default(now())

  @@db(${db})
  @@gate("8")
  @@index([identifier])
}
`

// ─── auth.ts scaffold ─────────────────────────────────────────────────────────

const authScaffold = (db) => `import { createLitestoneAuth, createAuthCleanupJobs } from '@frontierjs/auth'
import { createClient, GatePlugin, LEVELS }       from '@frontierjs/litestone'
import { defineEnv }                               from '@frontierjs/junction'

// ─── Env ──────────────────────────────────────────────────────────────────────

export const env = defineEnv({
  ENCRYPTION_KEY: { required: true, minLength: 64, description: 'AES-256 key for @secret fields (64 hex chars)' },
  AUTH_SECRET:    { required: true, minLength: 64, description: 'Auth signing secret (64 hex chars)' },
  APP_URL:        { required: true,                description: 'Base URL for verification links' },
})

// ─── Database ─────────────────────────────────────────────────────────────────

export const db = await createClient({
  path:          './db/schema.lite',
  encryptionKey: env.ENCRYPTION_KEY,
  plugins: [
    new GatePlugin({
      // STANDING, not a role string. isAdmin / isOwner / isSystemAdmin are what
      // Litestone's own resolver reads and what schema.lite's @@allow and field
      // policies read, so the level and the policies cannot disagree about who
      // an administrator is. What 'admin' MEANS is this app's decision, made
      // once in sessionFields below.
      getLevel(user) {
        if (!user)              return LEVELS.STRANGER
        if (user.isSystemAdmin) return LEVELS.SYSADMIN
        if (user.isOwner)       return LEVELS.OWNER
        if (user.isAdmin)       return LEVELS.ADMINISTRATOR
        return LEVELS.USER
      }
    })
  ]
})

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const auth = createLitestoneAuth(db, {
  // The one place this app says what 'admin' means. The User model ships a
  // role string that auth stores and never interprets; the gate and the row
  // and field policies all read isAdmin. Projecting it here means one owner
  // rather than a string matched in three files.
  sessionFields: (user) => ({ isAdmin: user.role === 'admin' }),

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
import { createAuthPlugin }             from '@frontierjs/auth'
import { withLitestoneDb }                 from '@frontierjs/junction'

const app = createApp({ auth })

app.configure(createAuthPlugin(auth, {
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
- Scaffolds `api/src/auth.ts` with `createLitestoneAuth` wired up
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

// Check the requested db block exists. `main` is checked like any other — it is
// not implicit, and exempting it let auth inject models naming a database that
// was never declared, which fails the whole parse at createClient.
// `audit` is separate: every fragment carries @@log(audit).
for (const name of [flag.db, 'audit']) {
  if (new RegExp(`database\\s+${name}\\s*\\{`).test(schemaContents)) continue
  log.error(`Database block '${name}' not found in schema.lite`)
  log.info(`Add a 'database ${name} { path ... }' block to schema.lite first`)
  return
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

// ─── 3. Generate ENCRYPTION_KEY ───────────────────────────────────────────────
//
// Before the push, not after: the fragments carry @secret columns, so a schema
// with no key refuses to compile and the push dies rather than the app later.
// The test is for a VALUE — a scaffolded .env ships the bare name with nothing
// after it, which a substring test reads as already set.

// [ \t] rather than \s — \s matches the newline, so `KEY=` followed by a blank
// line and a comment reads as a key whose value is `#`.
const hasKey = (name) => existsSync(envPath) &&
  new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*\\S`, 'm').test(readFileSync(envPath, 'utf8'))

const encKeyExists = hasKey('ENCRYPTION_KEY')

if (encKeyExists) {
  log.info('ENCRYPTION_KEY already set in .env — skipping')
} else if (flag.dry) {
  log.dry('Would generate ENCRYPTION_KEY (64 hex chars) → .env')
} else {
  context.exec({ command: `cd ${context.paths.root} && fli keygen aes --name ENCRYPTION_KEY --env --format hex` })
  log.success('Generated ENCRYPTION_KEY → .env')
}

// ─── 4. Generate AUTH_SECRET ──────────────────────────────────────────────────

const authSecretExists = hasKey('AUTH_SECRET')

if (authSecretExists) {
  log.info('AUTH_SECRET already set in .env — skipping')
} else if (flag.dry) {
  log.dry('Would generate AUTH_SECRET (64 hex chars) → .env')
} else {
  context.exec({ command: `cd ${context.paths.root} && fli keygen --name AUTH_SECRET --env --format hex --length 32` })
  log.success('Generated AUTH_SECRET → .env')
}

// ─── 5. Push schema to database ───────────────────────────────────────────────
//
// Adopt what was just written into THIS process first. bootstrap.js loaded the
// project .env at startup, so a scaffolded `ENCRYPTION_KEY=` put an EMPTY
// string on process.env — and a child inherits that empty value, which Bun's
// own .env loading will not override. Without this the push reports no key
// while the file it would have read holds a good one.

if (!flag.dry && existsSync(envPath)) {
  const written = readFileSync(envPath, 'utf8')
  for (const name of ['ENCRYPTION_KEY', 'AUTH_SECRET']) {
    const m = written.match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(\\S+)`, 'm'))
    if (m) process.env[name] = m[1]
  }
}

if (flag.dry) {
  log.dry('Would run: fli db:push')
} else {
  log.info('Pushing schema to database...')
  context.exec({ command: `cd ${context.paths.root} && bun run litestone db push --schema db/schema.lite` })
  log.success('Schema pushed')
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
