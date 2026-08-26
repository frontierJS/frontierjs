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
import { createRequire }                                       from 'node:module'
import { pathToFileURL }                                       from 'node:url'

// ─── Where the schema comes from ──────────────────────────────────────────────
//
// `@frontierjs/auth` ships `db/user.lite` and `db/auth.lite`, and this reads
// those bytes out of the APP's node_modules. It used to carry a hand copy of
// them, which drifted three times — pre-rename scalars that no longer parse, a
// missing `role`, and `@@gate("9")`, which is LOCKED and walled the auth tables
// off from the auth package itself (SYSTEM is 8).
//
// The copy existed because of two walls, not one. `fli` is global, so the
// package is not beside it — step 2 below is what answers that. And
// `fli` runs on NODE while `packages/auth/schema.ts` is TypeScript, so even
// resolved it could not be imported: reading a `.lite` file is what gets past
// both. Node resolves the subpaths through auth's `exports`, so nothing here
// guesses at a path inside the package.

const AUTH_PKG = '@frontierjs/auth'

// A shipped `.lite` file has to parse standalone, so it spells the attribute out
// rather than carrying a placeholder — `packages/auth/schema.ts` makes the same
// substitution for a caller assembling the schema in memory, and auth's
// `tests/schema-accessors.test.ts` lifts this arrow out of this file and runs it
// against the shipped bytes, so the two cannot disagree. Anchored to the line:
// both files discuss the attribute in their own headers, and a bare substring
// replace rewrote that prose too.
const retargetDb = (source, db) =>
  db === 'main' ? source : source.replace(/^([ \t]*)@@db\(main\)/gm, `$1@@db(${db})`)

/** Resolve a subpath of @frontierjs/auth from the app, or null if not installed. */
const resolveFromApp = (root, subpath) => {
  try {
    return createRequire(pathToFileURL(resolve(root, 'package.json'))).resolve(subpath)
  } catch {
    return null
  }
}

// ─── The block appended to schema.lite ───────────────────────────────────────
//
// An APPEND, not an insertion. `import` is legal anywhere at the top level and
// parseFile merges imported models ahead of local ones regardless of where the
// line sits, so there is no placement to get right — and nothing here has to
// parse the app's own file to find a spot in it.

const schemaBlock = (userModel, db) => `
// ─── Auth — installed by fli auth:install ────────────────────────────────────
//
// The credential machinery — Credential, Session, Verification — is imported
// from the package BY NAME, not copied here. All three are @@gate("8"): nothing
// outside asSystem() has anything to say to them, and @frontierjs/auth is the
// only thing that calls asSystem() on them, so they change when that package
// changes and not when this app does — and an upgrade to it reaches this schema
// with nothing to re-run.
//
// The specifier resolves through node, so @frontierjs/auth must be installed for
// this schema to parse.${db === 'main' ? '' : `\n// \`into ${db}\` is what lands those three in your ${db} database.`}
//
// User is here because it is yours. Add columns to it, point relations at it,
// and project what your app needs onto the session with sessionFields.

import "@frontierjs/auth/schema.lite"${db === 'main' ? '' : ` into ${db}`}

${userModel.trimStart()}`

// ─── auth.ts scaffold ─────────────────────────────────────────────────────────

const authScaffold = (db) => `import { createLitestoneAuth, createAuthCleanupJobs } from '@frontierjs/auth'
import { createClient, GatePlugin, LEVELS }       from '@frontierjs/litestone'
import { defineEnv }                               from '@frontierjs/junction'

// ─── Env ──────────────────────────────────────────────────────────────────────

export const env = defineEnv({
  ENCRYPTION_KEY: { required: true, minLength: 64, description: 'AES-256 key for @secret fields (64 hex chars)' },
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

  // Acting on an auth event. Awaited, and A THROW REFUSES — which is what makes
  // lockout possible here rather than only in a hook in front of the route.
  // One ordering rule: a hook runs BEFORE the thing it can refuse, so none of
  // them is handed what its refusal would have prevented. What happened after
  // is the audit trail's job — the hook is the gate, db.$audit is the record.
  //
  // onLogin({ user })                       before the session is issued
  // onLoginFailed({ email, userId, reason }) before the refusal is raised;
  //                                          throwing replaces the 401
  // onLogout({ userId, sessionId })          before the session is deleted
  // onRegister({ email, name })              before the user is created
  //
  // onLoginFailed: async ({ email }) => {
  //   if (await attempts.bump(email) > 5)
  //     throw new TooManyRequests('Locked. Try again in 15 minutes.')
  // },

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

// ─── app.ts wiring hint ────────────────────────────────────────────────────

const serverHint = `
// ─── Add to api/src/app.ts ──────────────────────────────────────────────────

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
APP_URL=          # e.g. https://myapp.com
`
</script>

Installs FJS native authentication into the current project.

What it does:
- Installs `@frontierjs/auth` if the project does not already have it
- Appends `import "@frontierjs/auth/schema.lite"` plus `model User` to
  `db/schema.lite` — the three `@@gate("8")` models stay in the package
- Pushes the schema changes to the database
- Generates `ENCRYPTION_KEY` in `.env`
- Scaffolds `api/src/auth.ts` with `createLitestoneAuth` wired up
- Prints the two lines to add to `api/src/app.ts`

The split is by owner. `User` lands in your own `schema.lite`, where you can add
columns to it and point relations at it. The other three are `@@gate("8")` —
nothing outside `asSystem()` speaks to them — so they are imported from the
package by name and a `bun update` reaches them. `--db` becomes `into <db>` on
that import line.

```js
const schemaPath  = resolve(context.paths.db,  'schema.lite')
const authLitePath = resolve(context.paths.db, 'auth.lite')
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

// Anchored, PascalCase, word-bounded. This read `'model users'` and the
// fragments have emitted `model User` since the rename, so it matched nothing
// and every re-run appended a second copy of all four models.
//
// Three layouts count as installed, because all three have shipped: the machinery
// imported by name (now), copied to db/auth.lite and imported (briefly), and all
// four models pasted into schema.lite (before the split). Missing any of them
// injects over an app that already has auth.
const declared = [schemaContents, existsSync(authLitePath) ? readFileSync(authLitePath, 'utf8') : '']
  .join('\n')

const declares = (m) => new RegExp(`^\\s*model\\s+${m}\\b`, 'm').test(declared)
const importsMachinery = /^[ \t]*import\s+["'](@frontierjs\/auth\/schema\.lite|\.\/auth\.lite)["']/m
  .test(schemaContents)

const alreadyInstalled = declares('User') &&
  (importsMachinery || ['Credential', 'Session', 'Verification'].every(declares))

if (alreadyInstalled) {
  log.warn('Auth models already present — skipping schema injection')
  log.info('Run fli auth:create-user to add your first user')
  return
}

// Check the requested db block exists. `main` is checked like any other — it is
// not implicit, and exempting it let auth inject models naming a database that
// was never declared, which fails the whole parse at createClient.
// `audit` is separate: User and Session both carry @@log(audit).
for (const name of [flag.db, 'audit']) {
  if (new RegExp(`database\\s+${name}\\s*\\{`).test(schemaContents)) continue
  log.error(`Database block '${name}' not found in schema.lite`)
  log.info(`Add a 'database ${name} { path ... }' block to schema.lite first`)
  return
}

echo('')
log.info('Installing FJS auth...')
echo('')

// ─── 2. Make sure @frontierjs/auth is actually installed ─────────────────────
//
// `fli new` offers auth and this command is the add-later path, so it usually
// is not. The test is a RESOLVE rather than a package.json read: a declared
// dependency nobody installed fails here in exactly the same way, and this is
// about to read files out of the package.

let userLite = resolveFromApp(context.paths.root, `${AUTH_PKG}/user.lite`)

if (!userLite) {
  if (flag.dry) {
    log.dry(`Would run: bun add ${AUTH_PKG}`)
  } else {
    log.info(`Installing ${AUTH_PKG}...`)
    context.exec({ command: `cd ${context.paths.root} && bun add ${AUTH_PKG}` })
    userLite = resolveFromApp(context.paths.root, `${AUTH_PKG}/user.lite`)
  }
}

// `schema.lite` is only resolved to check it is reachable — the schema imports it
// by name and nothing copies it. `user.lite` IS read, because User is appended as
// text for the app to own and edit.
const machineryLite = userLite ? resolveFromApp(context.paths.root, `${AUTH_PKG}/schema.lite`) : null

if (!flag.dry && !(userLite && machineryLite)) {
  log.error(`Could not resolve ${AUTH_PKG}'s schema files from ${context.paths.root}`)
  log.info(`Install it first: bun add ${AUTH_PKG}`)
  log.info(`A version older than 1.0.2 does not ship them — it kept the schema in TypeScript.`)
  return
}

// ─── 3. Append the import and model User to schema.lite ──────────────────────
//
// Only User is written out. The three @@gate("8") models stay in the package and
// are imported by name, so `bun update` reaches them — which is the whole reason
// the specifier is a package rather than a path.

const importLine = `import "${AUTH_PKG}/schema.lite"` + (flag.db === 'main' ? '' : ` into ${flag.db}`)

if (flag.dry) {
  log.dry(`Would append ${importLine} + model User to ${schemaPath}`)
} else {
  const userModel = retargetDb(readFileSync(userLite, 'utf8'), flag.db)
  writeFileSync(schemaPath, schemaContents + schemaBlock(userModel, flag.db), 'utf8')
  log.success(`Appended ${importLine} and model User to schema.lite`)
}

// ─── 4. Generate ENCRYPTION_KEY ───────────────────────────────────────────────
//
// Before the push, not after: the fragments carry @secret columns, so a schema
// with no key refuses to compile and the push dies rather than the app later.
// The test is for a VALUE — a scaffolded .env ships the bare name with nothing
// after it, which a substring test reads as already set.

// [ \t] rather than \s — \s matches the newline, so `KEY=` followed by a blank
// line and a comment reads as a key whose value is `#`.
const hasKey = (name) => existsSync(envPath) &&
  new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*\\S`, 'm').test(readFileSync(envPath, 'utf8'))

// `.env` is this machine's; `.env.example` is the one that is committed, so a key
// written only to the first is a key the next clone has no name for. Declared with
// no value — the example file is the list of what must be set, never the values.
const examplePath = resolve(context.paths.root, '.env.example')

function declareInExample(name) {
  if (flag.dry || !existsSync(examplePath)) return
  const body = readFileSync(examplePath, 'utf8')
  if (new RegExp(`^[ \\t]*${name}[ \\t]*=`, 'm').test(body)) return
  writeFileSync(examplePath, body.replace(/\n*$/, '\n') + `\n# Required — generated by \`fli auth:install\`\n${name}=\n`, 'utf8')
  log.success(`Declared ${name} in .env.example`)
}

const encKeyExists = hasKey('ENCRYPTION_KEY')

if (encKeyExists) {
  log.info('ENCRYPTION_KEY already set in .env — skipping')
} else if (flag.dry) {
  log.dry('Would generate ENCRYPTION_KEY (64 hex chars) → .env')
} else {
  context.exec({ command: `cd ${context.paths.root} && ${context.fli} keygen aes --name ENCRYPTION_KEY --env --format hex` })
  declareInExample('ENCRYPTION_KEY')
}

// No AUTH_SECRET is generated, and that is a statement rather than an omission
// (`FJS-360`). A session here is a ROW — `generateSessionToken()` is a random
// UUID stored on `Session`, verified by looking it up — so nothing is signed and
// there is nothing for a signing secret to sign. An API key is hashed with
// `ENCRYPTION_KEY`. A second secret with no reader is worse than no secret: it
// gets rotated, nothing breaks, and everybody learns that rotating is safe.
// Sessions becoming stateless tokens is what would bring it back.

// ─── 5. Push schema to database ───────────────────────────────────────────────
//
// Read what was just written and hand it to the child EXPLICITLY. Two things
// stack here and either one alone breaks the push:
//
//   · bootstrap.js loads the project .env at startup, so a scaffolded
//     `ENCRYPTION_KEY=` puts an EMPTY string on this process's environment. A
//     child that already has the name set does not take .env's value for it, so
//     the push reports no key while the file beside it holds a good one.
//   · assigning `process.env.X` under BUN does not reach a child at all —
//     child_process hands over the environment the process STARTED with. Under
//     node it would, which is why the adoption below looked like a fix and was
//     a no-op for the only runtime fli runs on (FJS-343).

const childEnv = { ...process.env }

if (!flag.dry && existsSync(envPath)) {
  const written = readFileSync(envPath, 'utf8')
  for (const name of ['ENCRYPTION_KEY']) {
    const m = written.match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(\\S+)`, 'm'))
    if (m) childEnv[name] = process.env[name] = m[1]
  }
}

// The push needs the litestone BINARY, which only exists once the app's
// dependencies are installed. `fli new --no-install` and `npm create frontier`
// both reach here with an empty node_modules, and there the push is not a
// failure — it is a step that cannot have happened yet. Said rather than
// swallowed: the schema is written either way, and the row it would have
// created is one `bun install` away.
const litestoneBin = resolve(context.paths.root, 'node_modules', '.bin', 'litestone')

if (flag.dry) {
  log.dry('Would run: fli db:push')
} else if (!existsSync(litestoneBin)) {
  log.warn('Skipped the schema push — node_modules is empty, so there is no litestone to run')
  log.info('  Run `bun install`, then `fli db:push`. The schema itself is already written.')
} else {
  log.info('Pushing schema to database...')
  context.exec({
    command: `cd ${context.paths.root} && bun run litestone db push --schema db/schema.lite`,
    env:     childEnv,
  })
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
//
// Only for an app that has no auth wiring. `fli new` writes `api/src/core/auth.ts`
// and imports it from `api/src/app.ts`, so writing this file into that layout
// produced a SECOND `createLitestoneAuth` over a SECOND `createClient` on the
// same SQLite file, imported by nothing — and the hint below then named
// `api/src/server.ts`, which does not exist in that app, and told the reader to
// call `createApp({ auth })` again when app.ts already does.

const coreAuthPath = resolve(context.paths.api, 'src/core/auth.ts')
const alreadyWired = existsSync(coreAuthPath)

if (alreadyWired) {
  log.info('api/src/core/auth.ts is already wired from api/src/app.ts — nothing to scaffold')
} else if (existsSync(authTsPath)) {
  log.warn(`${authTsPath} already exists — skipping scaffold`)
} else if (flag.dry) {
  log.dry(`Would create ${authTsPath}`)
} else {
  const srcDir = resolve(context.paths.api, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(authTsPath, authScaffold(flag.db), 'utf8')
  log.success(`Created api/src/auth.ts`)
}

// ─── 8. Print wiring hint ────────────────────────────────────────────────────

echo('')
log.success('Auth installed')
echo('')
if (alreadyWired) {
  echo('  api/src/app.ts already configures it. Nothing to add.')
} else {
  echo('  Next — add to api/src/app.ts:')
  echo('')
  for (const line of serverHint.trim().split('\n')) {
    echo(`  ${line}`)
  }
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
