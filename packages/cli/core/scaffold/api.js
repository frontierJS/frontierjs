// ─── scaffold/api.js — the api/ surface fli new writes ─────────────────────
//
// Junction's entry, the app, env, gate, db, channels, principal, the auth
// wiring and the access test, plus junction.config.js. Each builder returns the
// file's text; what is written and where is `commands/project/new.md`'s list.
// A backtick inside a comment inside one of these literals closes the literal
// and the failure lands lines away — plain words or -- quoting.
// ─────────────────────────────────────────────────────────────────────────────

export function makeApiIndexTs() {
  return `// api/index.ts
// Run with: bun run api/index.ts

import app from './src/app.ts'

await app.start()
`
}

// `apiPrefix` is not stated here: junction.config.js states it once, for the
// full-stack template only, and sierra.config.js reads it from there. A second
// copy in this call would win the merge and move the routes under a proxy and a
// client that still read the first.
export function makeApiAppTs(useAuth, useQueue = false, useNotify = false) {
  const queueImport = (useQueue ? `\nimport { caravan } from '@frontierjs/caravan'\nimport { commitments } from '@frontierjs/junction/commitments'` : '')
    + (useNotify ? `\nimport { notifications } from '@frontierjs/notifications'` : '')
  const systemImport = useQueue ? `\nimport { SYSTEM }           from './core/gate.ts'` : ''
  // Deferred work nobody asked for -- a commitment's clock firing -- has no
  // caller, and no caller grades STRANGER on a gated model.
  const systemLine = useQueue ? `\n  system: SYSTEM,` : ''
  // The queue's own settings are DECLARED in junction.config.js (its database),
  // and its job directory is jobs/ beside the root, so the call takes none.
  const queue = useQueue ? `// ─── Deferred work ────────────────────────────────────────────────────────
// Caravan is a SQLite queue in its own file, jobs.db beside DATABASE_URL. \`boot()\` autoloads
// api/src/jobs/*.job.ts and \`work()\` starts the workers; a job that declares
// \`cron\` needs no line here. retention.job.ts is the one that matters on day
// one: the schema declares \`retention 90d\` on the audit trail, and litestone
// sweeps it once when the client opens, so a server that stays up prunes
// nothing after that unless a job does.
app.configure(caravan())

// A \`@@commitment\` in db/schema.lite is swept and fired by this plugin, which
// boot refuses to start without once the schema declares one. With none
// declared it holds a sweep that finds nothing. It requires caravan, so it
// stays below it.
app.configure(commitments())

` : ''
  const notify = useNotify ? `// ─── Notifications ────────────────────────────────────────────────────────
// app.notify(recipient, notification) -- an in-app record and a live event on
// the recipient's channel. A notification is a FILE and the file names it:
// api/src/notifications/OrderPaid.notification.ts is type "OrderPaid". Email is
// off: it needs app.configure(mail(...)) from
// '@frontierjs/junction/mail' above this line, then
// \`transports: { email: { mailer: 'default' } }\` here.
app.configure(notifications({ db }))

` : ''
  if (useAuth) {
    return `// api/src/app.ts
// The construction site — createApp + every plugin registration lives here.
// Read top-to-bottom for "how this app is wired."
//
// The default export is the configured but-not-yet-started app. The actual
// \`app.start()\` call lives in api/index.ts so that test code can import this
// file without binding a port.

import { createApp, channels } from '@frontierjs/junction'${queueImport}
import { auth, authPlugin } from './core/auth.ts'
import { joinChannels }     from './core/channels.ts'
import { db }               from './core/db.ts'
import { principal }        from './core/principal.ts'${systemImport}

// ─── The app ──────────────────────────────────────────────────────────────
// The db client is passed rather than wired, and it is not a convenience:
// handing it here installs the per-request scoping AND four things that have
// no other install site — the write announcement that reaches open tabs, the
// request context on every audit row, the audit metrics, and the query
// telemetry the devtools console reads. Scoping the client by hand instead
// gets the first of those and none of the rest, silently.
const app = createApp({
  // services/, jobs/, notifications/ beside this file, ../config above it.
  root: import.meta.url,
  auth,
  db,
  principal,${systemLine}
})

// ─── Real-time ────────────────────────────────────────────────────────────
// Registers the /ws route. Without it the browser client has nothing to
// upgrade to: it falls back to HTTP, which works, and reports itself
// disconnected forever with no error anywhere.
//
// The callback is the other half and is just as silent when it is missing: a
// service's \`channel:\` says where a write is announced, and until a
// connection JOINS that channel the announcement reaches nobody. core/channels.ts
// is where an app decides who listens to what.
app.configure(channels((a) => {
  a.channels.on('connection', (session, conn) => joinChannels(a, session, conn))
}))

// ─── Auth routes ──────────────────────────────────────────────────────────
// Mounts {apiPrefix}/auth/register, /auth/login, /auth/logout and the
// rest — apiPrefix moves the plugin's routes with everything else.
// Its work() phase also starts the hourly sweep of expired sessions and
// tokens, which a one-shot boot (junction call) skips.
app.configure(authPlugin)

${queue}${notify}// Services in api/src/services/*.service.ts are autoloaded at boot.

export default app
`
  }

  return `// api/src/app.ts
// The construction site — createApp + every plugin registration lives here.

import { createApp, channels } from '@frontierjs/junction'${queueImport}
import { joinChannels }                                  from './core/channels.ts'
import { db }                                            from './core/db.ts'
import { principal }                                     from './core/principal.ts'${systemImport}

// ─── The app ──────────────────────────────────────────────────────────────
// The db client is passed rather than wired: handing it here installs the
// per-request scoping AND the write announcement, the audit request context,
// the audit metrics and the query telemetry, none of which has another install
// site. Scoping by hand gets the scoping alone, and says nothing.
const app = createApp({
  // services/, jobs/, notifications/ beside this file, ../config above it.
  root: import.meta.url,
  db,
  principal,${systemLine}
})

// ─── Real-time ────────────────────────────────────────────────────────────
// Registers the /ws route the browser client upgrades to. The callback is the
// half that is silent without it: a write is announced on the channel its
// service declares, and reaches nobody until a connection has joined one.
app.configure(channels((a) => {
  a.channels.on('connection', (session, conn) => joinChannels(a, session, conn))
}))

${queue}${notify}// Services in api/src/services/*.service.ts are autoloaded at boot.

export default app
`
}

// A stub, because the resolver an app needs is its own: what a caller holds for
// THIS request (a workspace they belong to, a pass in a link) cannot be derived
// from the schema. An empty list runs nothing.
export function makeApiCorePrincipalTs() {
  return `// api/src/core/principal.ts -- what a caller holds for THIS request, beyond who
// they are. createApp({ principal }) runs each resolver for every request, a
// guest's included, and merges the claims onto the principal the Data boundary
// scopes the client from. Emit a claim only for a caller you have verified:
// membershipClaim() and bearerClaim() from '@frontierjs/junction' do, and
// a resolver returns {} for a caller with no standing.

import type { PrincipalResolver } from '@frontierjs/junction'

export const principal: PrincipalResolver[] = []
`
}

export function makeApiEnvTs() {
  return `// api/src/core/env.ts
// Validated at module load — a missing required var crashes the app
// before anything else runs. Import this from app.ts and other places
// that need env values.

import { defineEnv } from '@frontierjs/junction'

export const env = defineEnv({
  // Required — used for HMAC of API keys, encrypted columns, OAuth state.
  // Generate with: openssl rand -hex 32
  ENCRYPTION_KEY: { type: 'string', required: true, minLength: 64 },

  // Database file path. Use ':memory:' for tests.
  DATABASE_URL: { type: 'string', default: './db/app.db' },

  // The audit trail's file. Declared for the same reason DATABASE_URL is: a
  // deploy has to be able to put it on the mounted volume without editing the
  // schema.
  AUDIT_PATH: { type: 'string', default: './db/audit.db' },

  // fli auth:install generates this into .env. Declared so defineEnv can see it
  // — the name is one of three it warns about for length and placeholder values
  // — and NOT required, because no code in @frontierjs/auth or junction reads it:
  // auth signs with encryptionKey. A required refusal over a value nothing uses
  // is a container that will not boot for no reason (FJS-360).

  // No PORT: junction reads FRONTIER_PORT_BE, else PORT, itself, and
  // api/config/junction.config.js states 8100 for a run with neither.
  //
  // Where the web app is, for a link somebody is sent — a password reset lands
  // on a page, and the API's origin serves none. FRONTIER_PORT_FE is the port
  // fli dev hands web/, so the link follows the app to its slot.
  FRONTIER_APP_URL: { type: 'url', default: 'http://localhost:' + (process.env.FRONTIER_PORT_FE ?? 8000) },
  NODE_ENV: { type: 'string', default: 'development' },
})
`
}

export function makeApiCoreGateTs(useQueue = false) {
  return `// api/src/core/gate.ts
// Who a caller IS, as a level on Litestone's ladder — what every @@gate in
// db/schema.lite is compared against:
//   no user, or no id → STRANGER (0)
//   isAdmin standing  → ADMINISTRATOR (5)
//   anyone else       → USER (4)
//
// A principal with no id is a guest holding only a claim (a cart token, a
// pass): Junction hands its claims to the Data boundary as an object, so a
// test for null alone would grade it USER and let it write as nobody.
//
// STANDING, not a role string: isAdmin / isOwner / isSystemAdmin are what
// Litestone's own resolver reads and what schema.lite's @@allow and field
// policies read, so a level and a policy cannot disagree about who an
// administrator is. What 'admin' MEANS is the app's decision, made once in
// standing() below, which auth takes as its sessionFields -- getLevel never
// matches a role string.
//
// Its own file so a test can install it without opening the app's database
// (api/test/access.test.ts), and so \`fli db:repl --gate api/src/core/gate.ts\`
// can grade a console the way the API grades a request. Anything graded by a
// different resolver passes against a ladder the API does not run. It imports
// nothing from ./db.ts, which opens db/app.db at import: a test reaches
// standing() here because auth.ts, which holds the db, cannot be imported
// without the database.

import { GatePlugin, LEVELS } from '@frontierjs/litestone'

/** The standing a signed-in user's session carries, read off their row. */
export function standing(user: { role?: unknown }) {
  return { isAdmin: user.role === 'admin' }
}

export function getLevel(user: unknown) {
  const u = user as { id?: unknown; isAdmin?: boolean; isOwner?: boolean; isSystemAdmin?: boolean } | null
  if (!u || u.id == null) return LEVELS.STRANGER
  if (u.isSystemAdmin)    return LEVELS.SYSADMIN
  if (u.isOwner)          return LEVELS.OWNER
  if (u.isAdmin)          return LEVELS.ADMINISTRATOR
  return LEVELS.USER
}

export const gate = new GatePlugin({ getLevel })
${useQueue ? `
// The principal the app is when it acts on its own behalf -- passed once, as
// createApp({ system: SYSTEM }), and used only by work nobody asked for: a
// @@commitment's clock firing. A fire has no caller, and no caller grades
// STRANGER, so a gated model's move is refused unless this principal clears
// the gate AND the model's row policies admit it. Not a row in the users
// table and cannot log in.
export const SYSTEM = {
  id:            'system',
  userType:      'service',
  role:          'system',
  isSystemAdmin: true,
  email:         'system@localhost',
  authMethod:    'created' as const,
}
` : ''}`
}

// Written only with auth: every assertion is about the User model auth:install
// appends, and the principals are the sessions auth's sessionFields builds.
export function makeApiAccessTest() {
  return `// api/test/access.test.ts — who may do what to a User, asked of the real schema.
//
// Every rule under test is declared in db/schema.lite, not in a service: @@gate
// sets the level each operation needs, @@allow narrows an update to your own
// row, and @allow(write, auth().isAdmin) guards the role column. The resolver
// is the app's own (api/src/core/gate.ts), so this grades the ladder the API
// runs rather than a copy of it.
//
// Each refusal sits beside a caller who IS allowed the same thing. A schema that
// refused everybody would pass every refusal on its own.

/// <reference path="../../db/schema.d.ts" />
import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createTestEnv } from '@frontierjs/litestone/testing'
import { gate, standing } from '../src/core/gate.ts'

const schema = fileURLToPath(new URL('../../db/schema.lite', import.meta.url))

// A fresh database built from the schema — never db/app.db. It is thrown away
// with the run, so it takes a throwaway key rather than .env's, which CI does
// not have: the file is gitignored.
const env = await createTestEnv({
  schema,
  plugins:       [gate],
  encryptionKey: randomBytes(32).toString('hex'),
  autoFactories: true,
})
afterAll(() => env.close())

// Fixtures are written below the boundary, so a gate refusing the caller under
// test cannot refuse the setup. ONE factory for the file: asSystem() returns a
// copy, and each fresh copy restarts the sequence that keeps emails unique.
const users = env.factories.user.asSystem()

// The reference at the top is what types these: db/schema.d.ts registers the
// schema's client, and createTestEnv answers it. \`bun run typecheck\` writes
// the file first, so a fresh clone has it.
const system   = env.system
const actingAs = (principal: unknown) => env.actingAs(principal)

// A principal is the SESSION the API builds, not a row: standing() turns role
// "admin" into isAdmin at sign-in, and getLevel reads isAdmin.
const admin = { id: 'admin', ...standing({ role: 'admin' }) }

test('every @@gate answers the way the schema declares it', async () => {
  expect(await env.verifyGateLadder()).toEqual([])
})

describe('User', () => {
  test('a stranger cannot list users, and a signed-in user can', async () => {
    const me = await users.createOne()

    await expect(actingAs(null).user.findMany()).rejects.toThrow('requires level 4')
    expect(await actingAs({ id: me.id }).user.findMany()).not.toHaveLength(0)
  })

  test('a user can rename themselves, and cannot promote themselves', async () => {
    const me = await users.createOne({ role: 'user' })

    await actingAs({ id: me.id }).user.update({
      where: { id: me.id },
      data:  { name: 'Renamed', role: 'admin' },
    })

    // The field policy declines in silence: no error, the column unchanged.
    const row = await system.user.findFirst({ where: { id: me.id } })
    expect(row?.name).toBe('Renamed')
    expect(row?.role).toBe('user')
  })

  test('an admin can promote somebody', async () => {
    const person = await users.createOne({ role: 'user' })

    await actingAs(admin).user.update({ where: { id: person.id }, data: { role: 'admin' } })

    const row = await system.user.findFirst({ where: { id: person.id } })
    expect(row?.role).toBe('admin')
  })

  test("a user cannot edit somebody else's row, and an admin can", async () => {
    const me    = await users.createOne()
    const other = await users.createOne({ name: 'Other' })

    // The row policy filters the row out before the write, so the answer is
    // null rather than an error.
    const refused = await actingAs({ id: me.id }).user.update({
      where: { id: other.id },
      data:  { name: 'Hijacked' },
    })
    expect(refused).toBeNull()
    expect((await system.user.findFirst({ where: { id: other.id } }))?.name).toBe('Other')

    await actingAs(admin).user.update({ where: { id: other.id }, data: { name: 'Edited' } })
    expect((await system.user.findFirst({ where: { id: other.id } }))?.name).toBe('Edited')
  })

  test('deleting a user takes an administrator', async () => {
    const me    = await users.createOne()
    const other = await users.createOne()

    await expect(
      actingAs({ id: me.id }).user.delete({ where: { id: other.id } }),
    ).rejects.toThrow('requires level 5')

    await actingAs(admin).user.delete({ where: { id: other.id } })
    expect(await system.user.findFirst({ where: { id: other.id } })).toBeNull()
  })
})
`
}

export function makeApiCoreDbTs(useQueue = false) {
  const sys = useQueue ? `
// The documented bypass: no gate, no row policy. A job has no caller to grade,
// so retention.job.ts reaches the database through this and says so.
export const sys = db.asSystem()
` : ''
  return `// api/src/core/db.ts
// One Litestone client for the whole app, graded by the resolver in gate.ts.
//
// Schema is loaded from disk; createClient runs the DDL automatically
// on first run. No separate apply() step needed for fresh DBs.

import { fileURLToPath } from 'node:url'

import { createClient } from '@frontierjs/litestone'
import { env }  from './env.ts'
import { gate } from './gate.ts'

// Anchored to THIS FILE, never to the working directory. Not every command that
// imports this module runs from the app root — a \`site/\` build runs from its own
// surface — and both halves of getting that wrong are quiet: a schema path that
// resolves nowhere is a client that cannot open, and a DATABASE path that
// resolves nowhere is a NEW, EMPTY database, which prerenders a page with no
// rows in it and exits 0.
//
// \`resolveFrom: 'schema'\` then anchors env.DATABASE_URL to the app root as well,
// since that is the directory above the schema's own.
const schemaPath = fileURLToPath(new URL('../../../db/schema.lite', import.meta.url))

// No \`db:\` here on purpose. That option is an OVERRIDE and is resolved against
// the process — \`database main\` in the seed already declares
// \`env("DATABASE_URL", "./db/app.db")\`, which is the same variable, anchored to
// the app root by \`resolveFrom\` above. Passing it here would put the database
// wherever the command was typed from.
export const db = await createClient({
  // \`path:\`, not \`schema:\`. A path under \`schema:\` is read as one, but the two
  // keys mean different things — a schema STRING has no directory, so a relative
  // \`import\` in it resolves against nothing and is dropped — and no tool can tell
  // which was meant from the outside: \`fli check\`'s \`schema-in-memory\` fires on
  // the key, because that is all a source reader can see.
  path:          schemaPath,
  resolveFrom:   'schema',
  encryptionKey: env.ENCRYPTION_KEY,
  plugins:       [gate],
})
${sys}`
}

export function makeRetentionJobTs() {
  return `// api/src/jobs/retention.job.ts
//
// \`db/schema.lite\` says \`database audit { … retention 90d }\`, and without this
// file that sentence is true for exactly one moment: litestone sweeps once
// inside createClient, so an API that stays up for a month pruned on the day it
// booted and never again. The declaration is the policy; the schedule is the
// app's, because the clock belongs to the queue and litestone cannot import it.
//
// The file name is the job's name, \`cron\` is when it runs, and autoloading from
// api/src/jobs/ is the rest.

import { defineJob } from '@frontierjs/caravan'
import { sys }       from '../core/db.ts'

/**
 * Sweep every declared retention policy.
 *
 * \`sys\` because it is a DELETE against the base table and applies no gate, no
 * row policy and no \`@@softDelete\`. Answers one row per table it touched.
 *
 * 04:00 daily, the hour an app is quietest.
 */
export default defineJob({
  cron: '0 4 * * *',
  handler: async () => {
    const swept   = await sys.$retain()
    const removed = swept.reduce((n, r) => n + r.removed, 0)

    // A table it could not sweep is a declared policy quietly not applying,
    // which is the failure this job exists to stop being invisible.
    for (const row of swept.filter(r => r.error))
      console.error(\`[retention] \${row.model}: \${row.error}\`)

    if (removed)
      console.log(\`[retention] removed \${removed} row(s) across \${swept.filter(r => r.removed).length} table(s)\`)
  },
})
`
}

export function makeApiCoreChannelsTs(useAuth) {
  const notify = useAuth
    ? `
  // The in-app notification channel for one person. \`@frontierjs/notifications\`
  // owns this spelling; an anonymous connection has none to join, which is the
  // only reason this is not "join everything".
  const who    = (session ?? {}) as Session
  const userId = who.id
  if (userId) app.channel(\`notifications:user:\${userId}\`).join(conn as never)
`
    : ''

  // A parameter nothing reads is a type error under the tsconfig this scaffold
  // ships, so the no-auth variant takes `_session` and declares no shape for it.
  const sessionArg  = useAuth ? 'session' : '_session'
  const sessionType = useAuth
    ? `/** A session as this app can read one. Junction hands the handler \`unknown\`,
 *  because what a session IS belongs to whichever auth provider issued it —

 *  a session and a hand-built principal both put the id at \`id\`. */
type Session = { id?: string }
`
    : ''

  return `// api/src/core/channels.ts — who receives a broadcast.
//
// A service declares \`channel: 'notes'\` and Junction publishes every write on
// it. Nothing is delivered until a CONNECTION has joined that channel, and
// joining is this file's decision — the one an app makes and the framework
// cannot.
//
// It exists because a channel nobody joined broadcasts into NOTHING. No error,
// no log, no dropped frame: the broadcast succeeds, reaches an empty set, and the
// symptom is a screen that never updates.
//
// Joining is a subscription and not a permission. A broadcast is not a SELECT,
// so an \`@@allow\` — which compiles into a WHERE — could not reach one; junction
// grades every frame per recipient at the Data boundary now, and shapes it. So
// what is below is a list of what each connection LISTENS to, never of what it
// may read, and a channel joined by somebody entitled to nothing delivers
// nothing to them.
//
// Which is why the default is every channel a service declares: \`fli scaffold\`
// writes \`channel:\` into each service it generates, and a list repeated here
// by hand goes stale the first time you add a model. Narrow it when a channel
// is genuinely nobody's business until they ask for it.

import type { App } from '@frontierjs/junction'

${sessionType}
/** Everything one connection listens to. Called once, on connection. */
export function joinChannels(app: App, ${sessionArg}: unknown, conn: unknown): void {
  for (const service of app.services.values()) {
    // Only the string form. A function \`channel:\` computes its target per
    // broadcast, so there is no name here to join ahead of time — an app using
    // one names the channels it wants below, by hand.
    const declared = (service as { channel?: unknown }).channel
    if (typeof declared === 'string') app.channel(declared).join(conn as never)
  }
${notify}}
`
}

export function makeApiCoreAuthTs() {
  return `// api/src/core/auth.ts
// Auth instance + plugin. The instance exposes IAuth for use in
// createApp({ auth }); the plugin mounts /auth/* HTTP routes.
//
// Both reference the same \`db\` import — auth uses db.asSystem()
// internally so its writes bypass gates and policies.

import { createLitestoneAuth, auth as authRoutes } from '@frontierjs/auth'
import { db }   from './db.ts'
import { env }  from './env.ts'
import { getLevel, standing } from './gate.ts'

export const auth = createLitestoneAuth(db, {
  encryptionKey:        env.ENCRYPTION_KEY,

  // standing() in gate.ts is the one place this app says what 'admin' MEANS,
  // and it is load-bearing.
  // gate.ts grades the gate on \`isAdmin\`, and schema.lite spends it three times —
  // \`@@gate(4.4.4.5)\` for who may delete a person, \`@@allow(update, … ||
  // auth().isAdmin)\` for whose row, \`@allow(write, auth().isAdmin)\` on role
  // and emailVerified. The User model ships a role STRING, which auth stores
  // and never interprets, so without this line \`isAdmin\` is never on the
  // session and all three are dead: an administrator grades USER(4), a delete
  // is a 403 nobody can clear, editing another person's row is a 404 because a
  // row policy that matches nothing hides it, and a write to role returns 200
  // with the field silently stripped.
  sessionFields:        standing,

  sessionTtl:           '30 days',
  passwordResetTtl:     '1 hour',
  emailVerificationTtl: '24 hours',

  // Neither sends anything yet: there is no mailer, so the link is printed to
  // this terminal instead, where you can click it. Both routes answer the same
  // whether or not the address has an account — they must never reveal who is
  // registered — so this log is the only place a reset is visible at all.
  // Wire app.mail.send() in here once the app has a mailer.
  onPasswordResetRequested: async ({ email, token }) => {
    // FRONTIER_APP_URL, not the API's origin: the link lands on
    // web/src/routes/reset/, and the API has no page to answer it. The token rides the fragment:
    // a fragment is never sent in a request, a Referer or an access log, and
    // an analytics tag that reads location.href does not forward it.
    const link = \`\${env.FRONTIER_APP_URL}/reset/#token=\${encodeURIComponent(token)}\`
    console.log(\`[auth] password reset for \${email} — no mailer, so here is the link:\\n  \${link}\`)
  },
  onEmailVerificationRequested: async ({ email, token }) => {
    const link = \`\${env.FRONTIER_APP_URL}/verify-email/#token=\${encodeURIComponent(token)}\`
    console.log(\`[auth] verify \${email} — no mailer, so here is the link:\\n  \${link}\`)
  },

  // Runs after a password change or reset, an email change, TOTP on or off,
  // an API key, a linked provider. The person who did NOT make the change
  // learns of it here or nowhere, so send it with app.mail.send() once the
  // app has a mailer. A throw is logged and refuses nothing. Say what changed
  // and never put a link in it that undoes it: a forged copy would be the phish.
  onCredentialChanged: async ({ event, email }) => {
    console.log(\`[auth] \${event} on the account of \${email} — no mailer, so nobody was told\`)
  },
})

export const authPlugin = authRoutes({
  auth,

  // Token in response body by default. Set true for httpOnly session cookie.
  cookieAuth: false,

  // The same ladder every @@gate is graded on, published as \`session.level\`
  // on account.me. Without it that level is null and the browser's can()
  // answers true for everyone: a nav that offers a manager's links by can()
  // shows them to a plain user. gate.ts is the one resolver; this is not a
  // second mapping.
  services: { level: getLevel },
})
`
}

export function makeJunctionConfig(appName, useWeb, useQueue = false) {
  // The one place the prefix is stated. Sierra's config imports this file, and
  // the dev proxy follows Sierra's, so the three cannot disagree. Only the web
  // half needs one: the dev proxy carries a single rule, and with no prefix the
  // services mount at /{service}, miss it, and fall through to Vite's SPA
  // handler -- 200 with an HTML body.
  const prefixLine = useWeb ? `\n    apiPrefix: '/api',` : ''
  // Anchored to THIS FILE: a relative queue path resolves against the working
  // directory, so the app would open a second, empty db/jobs.db from anywhere
  // but the app root.
  const hereImport = useQueue ? `
import { dirname, resolve } from 'node:path'
import { fileURLToPath }    from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

// Beside the main database. A deploy mounts only the directory DATABASE_URL
// points at, so a queue written beside the code is inside the container and
// every release starts with an empty one -- pending jobs and a pause included.
const dbUrl  = process.env.DATABASE_URL
const jobsDb = dbUrl && dbUrl !== ':memory:'
  ? resolve(here('../../'), dirname(dbUrl), 'jobs.db')
  : here('../../db/jobs.db')
` : ''
  const caravan = useQueue ? `
  // The job queue: a SQLite file of its own. Declared here, so app.ts passes
  // caravan() nothing.
  caravan: {
    db: jobsDb,
  },
` : ''
  return `// api/config/junction.config.js
// Read by createApp({ root }) from ../config beside api/src, and merged under
// opts.config. Configures the built-in middleware and the batteries.
${hereImport}
export default {
  app: {
    name:      '${appName}',${prefixLine}
    // dev/be for project 0 (packages/cli/core/ports.js). FRONTIER_PORT_BE --
    // the slot fli dev and fli deploy hand the API -- beats it, and a bare PORT
    // beats it only when no slot was handed.
    port:      8100,
  },

  middleware: {
    // A scaffolded app authenticates with a BEARER token, so it never needs a
    // credentialed request and \`*\` is an ordinary local-development
    // convenience. Turning on \`cookieAuth\` means a cookie, and a cookie means
    // naming the origins that may hold a session: junction refuses \`*\` beside
    // \`credentials: true\` at construction, because the browser refuses the
    // literal \`*\` next to Access-Control-Allow-Credentials and the middleware
    // would otherwise reflect whatever Origin arrived.
    cors:          { origins: ['*'], credentials: false },
    helmet:        true,
    requestLogger: true,
    correlationId: true,
  },

  // Junction's own plugins, and the middleware above: DECLARED here, installed
  // by Junction at start(). Nothing about either is written in api/src/app.ts.
  //
  // What decides the section is what the option takes — data is declared, code
  // is constructed. A plugin needing a function (health's own readiness checks,
  // a custom auth guard) is configured by hand in app.ts instead and is then
  // left OUT of this file, because declaring it in both places is two owners
  // for one route and start() refuses it by name.
  //
  // health serves /health and /metrics; frontier.config.js points the deploy's
  // health check at the same path and a deploy ROLLS BACK when it does not
  // answer, so the two move together. /metrics is not served in production
  // without a token, and a token gates /health as well, which the deploy's
  // health check does not send. manifest serves /manifest, which fli
  // api:routes reads: the HTTP surface is emergent, so running the app is the
  // only way to ask what it serves. It is devOnly, so a production build 404s
  // there.
  plugins: {
    health:   true,
    manifest: true,
  },
${caravan}}
`
}
