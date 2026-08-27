// api/src/app.ts
// Basecamp application bootstrap — the construction site.
//
// It BUILDS an app and never starts one; api/index.ts is the entry that calls
// start(). `junction surface` and `junction jobs` import this file to describe
// the app, and a describe that binds a port fights the dev server (`FJS-D128`).

import {
  createApp,
  createDatabase,
  createLogger,
  channels,
  healthPlugin,
  devtools,
  authenticate,
  mailerPlugin,
  membershipClaim,
  registerErrorMapper,
  Forbidden,
} from '@frontierjs/junction'

import { conduit }           from '@frontierjs/conduit'
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
import { createCaravan }     from '@frontierjs/caravan'

import { env }                       from './core/env.ts'
import { buildProviders }            from './providers/index.ts'
import { apply }                                 from '@frontierjs/litestone'
import { createLitestoneAuth, createAuthPlugin } from '@frontierjs/auth'
import { createBasecampDb }              from './core/db.ts'
import { createSecretResolver }          from './core/credentials.ts'
import { createConduitMailer, mailProvider, MAIL_TARGET } from './core/mailer.ts'
import { basecampAuditLog, basecampAuditPreImage, requireOutpostSignature, resolveWorkspaceId } from './core/hooks.ts'
import { grantsFor } from './core/capabilities.ts'
import { basecampSessionFields, refuseSuspendedLogin, refuseSuspended } from './core/session-auth.ts'
import { apiKeyGuard, apiKeyUsage }       from './services/api-keys/scopes.ts'
import { slugify }                        from './core/resource.ts'
import { roleForLevel }                   from './core/gate.ts'
import { restoreSchedules }          from './services/jobs/job-schedule.ts'
import { workspaceChannelName }      from './channels.ts'

import type { BasecampApp } from './basecamp.types.ts'

// Recorded nowhere, and stated once because two hooks take it: both halves of
// the audit trail must skip the same calls or a pre-image is read for an event
// that is never written. All three are an outpost on a timer — fifty machines
// reporting their disks every minute buries every action a person took.
const AUDIT_EXCEPT = ['servers.heartbeat', 'volumes.report', 'cleanup.report']

// The same three, under the name that says why they are a set: each is called
// by an Outpost rather than by a person, each is exempted from sessionScope for
// that reason, and each therefore needs a signature instead. Two lists, one
// membership — they are separate constants because they answer different
// questions (what the trail skips, what the signature guards) and a method
// could legitimately be in one and not the other.
const OUTPOST_ENDPOINTS = ['servers.heartbeat', 'volumes.report', 'cleanup.report']

/**
 * Build the app.
 *
 * `db` and `dbPath` exist for ONE caller and it is not production: the Testing
 * realm. `@frontierjs/testing` mounts this app over the environment's own
 * Litestone client so that a service test travels the whole request path —
 * principal → SessionContext → sessionGateLevel → toDataPrincipal → the scoped
 * client — instead of stopping at the Data boundary. Handing it a second client
 * on the same file would work and would be wrong: `arrange` writes and
 * `announced()` would then be looking at different connections.
 *
 * Both default to what production does, so the entry point calls this with no
 * arguments and nothing about it changes.
 */
export async function buildBasecampApp(
  opts: { db?: unknown; dbPath?: string } = {},
): Promise<BasecampApp> {

  // ── Logger ──────────────────────────────────────────────────────────
  const logger = createLogger({
    level:  env.NODE_ENV === 'development' ? 'debug' : 'info',
    format: env.NODE_ENV === 'development' ? 'pretty' : 'json',
    ns:     'basecamp',
  })

  // ── Database ─────────────────────────────────────────────────────────
  // Two handles on ONE SQLite file, each for what it is good at:
  //
  //   dbClient — Junction's raw client. Runs the migrations and hands the raw
  //              bun:sqlite handle to Conduit's store, the health check and
  //              `app.sqlite`, all of which want a Database, not an ORM.
  //   db       — the Litestone client. THE Data boundary: every service,
  //              job and bootstrap path reads and writes through it. It is
  //              what createApp is given, so `app.db` IS this — typed by the
  //              `AppDb` augmentation in basecamp.types.ts rather than by a
  //              second claimed name for the same object (`FJS-532`).
  //
  // Migrations run first, so the Litestone client opens a database whose
  // tables already exist.
  //
  // Applied by LITESTONE's runner, not junction's `dbClient.migrate(dir)`.
  // Two reasons, both learned the hard way (FJS-193):
  //
  //   · Migrations live per DATABASE — `db/migrations/main/` — because the
  //     schema declares `database main`. junction's runner globs one level and
  //     is blind to the subdirectory.
  //   · It answers "nothing to do" for a directory it cannot read, so a boot
  //     against a fresh database created no tables and said nothing; the app
  //     then answered `no such table: workspace` on the first request.
  //     Litestone's `apply` separates *no files* from *no files MATCHED*.
  //
  // SQL only here: a JS migration is handed a Litestone client, and the client
  // is built below — against the database these migrations create.
  const migrationsDir = new URL('../../db/migrations/main', import.meta.url).pathname
  // One path for this app's databases, not one per subsystem: the queue's file
  // is derived from it, so a test that redirects the main database and leaves
  // the queue behind would write jobs into the developer's own.
  const dbPath        = opts.dbPath ?? env.DATABASE_URL
  const dbClient      = createDatabase({ path: dbPath, log: env.DB_LOG })
  const migrated      = await apply(dbClient.db, migrationsDir)
  if (migrated.unmatched)
    throw new Error(`[basecamp] ${migrated.message} — db/migrations/main`)

  const rawDb = dbClient.db
  // eslint-disable-next-line -- the injected client is the env's, already typed there
  const db    = (opts.db as Awaited<ReturnType<typeof createBasecampDb>>) ?? await createBasecampDb()

  // ── Auth ─────────────────────────────────────────────────────────────
  // @frontierjs/auth over the Litestone client. It reaches db.user,
  // db.credential, db.session, db.verification and db.oauthFlow through
  // asSystem(), so those names are load-bearing.
  //
  // Four of the five are the package's own models, imported by db/schema.lite
  // and adjusted with `extend model` — this app adds the relation back to its
  // User, @@log(audit) and @@tenant(none), and owns none of the columns. `User`
  // is the one it does own and declares.
  //
  // `sessionFields` is how this app's OWN User columns reach the session.
  // auth owns the model and knows nothing about `isSystemAdmin`, `status` or
  // `kind`; without this seam the only way to read one per request is to fetch
  // the user again after auth already has. See core/session-auth.ts.
  const auth = refuseSuspendedLogin(createLitestoneAuth(db, {
    encryptionKey: env.ENCRYPTION_KEY,
    sessionTtl:    '7 days',
    sessionFields: basecampSessionFields,
  }), db)

  // ── Config ───────────────────────────────────────────────────────────
  // Load config but clear database.url — we own the DB, not the framework.
  const { loadConfig, defaultConfig } = await import('@frontierjs/junction')
  // Resolved off THIS FILE rather than the CWD, because a deploy starts the app
  // from the image root and a drive starts it from the package. One `..`: this
  // file is api/src/app.ts, so the surface's config/ is one level up.
  //
  // The catch is why this has to be right rather than merely close. An absent
  // directory resolves to defaultConfig in silence — which is FJS-430, where
  // this app read a config/ that did not exist for its whole life and ran with
  // CORS '*' for everyone while looking configured.
  const loadedConfig = await loadConfig(
    new URL('../config', import.meta.url).pathname
  ).catch(() => defaultConfig)

  const corsOrigins = env.CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean)

  const config = {
    ...loadedConfig,
    ...(corsOrigins?.length
      ? { http: { ...loadedConfig.http, cors: { ...loadedConfig.http?.cors, origins: corsOrigins } } }
      : {}),
    // env wins over the config file for host/port. env.ts declared PORT and
    // HOST and nothing read them, so the app silently took junction's default
    // (3000) and collided with anything already there.
    host:     env.HOST,
    port:     env.PORT,
    database: { url: '', log: false },   // prevent createApp from opening a second DB
  }

  // ── Framework app ─────────────────────────────────────────────────────
  // Passing `db` here is what installs withLitestoneDb() as an around-hook, so
  // every service gets a client on ctx.locals.db already scoped to the caller.
  // Omitting it leaves services running against an unscoped client — an option
  // with exactly one correct answer.
  // `autoload` stated rather than defaulted, and the reason is the TEST RUNNER.
  // The default probes beside the entry file (`Bun.main`), which is this app in
  // production and the test file under `bun test` — so an app mounted by
  // @frontierjs/testing found no services at all. An absolute path is the same
  // answer from either. Nothing to do with the layout: `api/src/services` is
  // where the probe looks anyway (`FJS-458`).
  const servicesDir = new URL('./services', import.meta.url).pathname
  // `principal:` is what makes this app's tenancy work, and it is the whole of
  // what used to be `withWorkspaceStanding` + `applyStanding` (`FJS-D113`).
  //
  // A workspace is the tenant and a person belongs to several, holding a
  // different role in each — so neither the claim nor the level can sit on the
  // session. Both are resolved per request off the WorkspaceMember row for the
  // workspace this request names, and junction merges them onto a fresh
  // principal and re-scopes the client before any hook or method runs.
  //
  // `membershipClaim` cannot emit a claim it did not verify, which is the whole
  // reason to use it rather than a hand-written resolver: under declared row
  // tenancy, emitting `workspaceId` for a caller with no membership scopes them
  // INTO that workspace and every read answers 200.
  const app = createApp({
    config, auth, db, logger, autoload: servicesDir,
    principal: membershipClaim({
      tenantFrom:  resolveWorkspaceId,
      model:       'workspaceMember',
      subject:     'userId',
      tenant:      'workspaceId',
      standing:    'role',
      standingAs:  'memberRole',
      // The grid, read off the same row as the standing and therefore costing
      // no second query. It cannot live on the session: a capability is always
      // per tenant (`FJS-D149`) and the same person holds a different set in
      // each workspace, which is the fact the whole membership row exists for.
      capabilities: 'capabilities',
      // The workspace's own row travels with the membership: its status is one
      // join away from a row already being read, and a second query per request
      // for it is the thing this option exists to avoid.
      include:     ['workspace'],
      // `tenantFrom` is the only thing that knows where a workspace is named,
      // so it says so — a request that named none is refused with the two ways
      // to name one rather than with the fact that it did not.
      namedBy:     'the X-Workspace-Id header or ?workspace_id=',
    }),
  }) as BasecampApp

  // ── One error, translated ─────────────────────────────────────────────
  // A gated transition refuses in litestone's own vocabulary: "Transition
  // 'drain' on Server.status requires level 5, user has level 4". That is the
  // right sentence for the package that owns the scale and the wrong one for
  // an operator, who has a ROLE and has never seen a level. The gate is still
  // this app's rule — declared in this app's schema — so the way back to the
  // word a person recognises is this app's too.
  //
  // A mapper rather than a hook, and app-wide rather than per service: every
  // gated move in the seed goes through it, including the ones nothing has
  // written a screen for yet. It runs AHEAD of the numeric-status read, which
  // is why it can replace a 403 the error class already carries correctly.
  //
  // Matched on `name`, not `instanceof`: the class crosses a package boundary
  // (litestone throws it, junction catches it) and this app resolves its own
  // copy of neither.
  registerErrorMapper((err: unknown) => {
    const e = err as { name?: string; transition?: string; required?: number }
    if (e?.name !== 'TransitionGateError') return null

    const role = roleForLevel(e.required ?? 0)
    // No role reaches it — 7 is standing, 8 is the machine tier. Litestone's
    // own sentence is then the honest one: there is no role to ask for.
    if (!role) return null

    return new Forbidden(`Requires ${role} role in this workspace to ${e.transition ?? 'make this change'}`)
  })

  // Attach the Basecamp-specific subsystems. Every one of them is a claim —
  // the guarded namespace claim, which throws on a collision instead of
  // silently last-write-wins. Nothing here assigns over a name Junction owns:
  // `app.db` IS the Litestone client createApp was given and is claimed by
  // nobody, and the raw handle takes a name of its own rather than replacing it.
  app.claim('sqlite', rawDb)
  app.claim('providers', await buildProviders(
    ((config as Record<string, unknown>).providers ?? {}) as Record<string, Record<string, unknown>>
  ))

  // ── Conduit — outbound transport ──────────────────────────────────────
  // Plugin augments app with app.conduit, wires /metrics, and registers
  // the management service. It is a Junction service, so it lands at
  // GET|DELETE /conduit-targets — verified, not the /api/conduit/targets this
  // comment used to claim, which never existed.
  // The mail provider is the one target declared at boot rather than registered
  // by a machine checking in — an outpost target arrives with a heartbeat, a
  // provider is configuration. Declared as a list of none where this app has no
  // provider, so `app.mail` is absent rather than present and failing.
  const mail = mailProvider()

  app.configure(conduit({
    targets: mail ? [{
      id:            MAIL_TARGET,
      kind:          'provider',
      protocol:      'http',
      address:       mail.address,
      auth:          { type: 'bearer', ref: mail.ref },
      registered_at: Date.now(),
      last_seen_at:  null,
    }] : [],
    store:       createSQLiteStore(rawDb),
    timeout_ms:  10_000,
    retry_limit: 3,
    // Conduit's default resolver reads process.env, which cannot see a
    // credential a person typed into a form five seconds ago. Notification
    // channels put theirs in a Secret (@encrypted), so the ref is `secret:<id>`
    // and the material never leaves the send path — see core/credentials.ts.
    credentials: createSecretResolver(db),
    // Conduit refuses to register management routes without an explicit access
    // decision — GET|DELETE /conduit-targets is an operational endpoint.
    // NB: `authenticate`, not `authenticate()` — it IS the hook, not a factory.
    // Conduit's own error message suggests the calling form, which throws.
    management: { hooks: { before: { all: [authenticate] } } },
    // Observers: they receive and cannot act. `management.hooks` above is the
    // other word and means the other thing — a pipeline that can refuse.
    observers: {
      onRequest:  (req)       => logger.debug('conduit →', { target: req.target, method: req.method }),
      onResponse: (_req, res) => { if (res.error) logger.warn('conduit error', { kind: res.error.kind }) },
      onError:    (req, err)  => logger.error('conduit failed', { target: req.target, kind: err.kind }),
    },
  }))

  // ── Caravan — durable job queue ───────────────────────────────────────
  // Plugin augments app with app.jobs and wires /metrics job stats.
  // `jobsDir`, `pollInterval` and the queue concurrencies are declared in
  // api/config/junction.config.js — caravan reads that block and an explicit
  // option here would win over it, so a key belongs in exactly one of the two.
  // The database path is not a declaration: it is derived from the resolved one
  // above, so a test that redirects the main database takes the queue with it
  // rather than writing jobs into the developer's own.
  const queue = createCaravan({
    db: dbPath.replace('.db', '-jobs.db'),
  })
  app.configure(queue)

  // ── Mail ──────────────────────────────────────────────────────────────
  // AFTER conduit: the mailer sends through app.conduit, and junction checks
  // plugin order at startup rather than at the first send. Absent where no
  // provider is configured — `app.mail` being undefined is what every caller
  // reads to say so out loud instead of reporting a delivery that never left.
  if (mail) app.configure(mailerPlugin(createConduitMailer(app, { from: env.MAIL_FROM })))

  // ── Standard middleware ────────────────────────────────────────────────
  // CORS is not configured here. It is DECLARED in api/config/junction.config.js
  // and junction installs it from the config block at startup — configuring it
  // by hand as well is a second `OPTIONS /*` and a hard refusal at boot.
  //
  // This app did call it by hand, off `config.cors`: a top-level key no config
  // shape defines, so the read could never produce a value and every boot took
  // the `['*']` fallback while looking configured.
  //
  // CORS_ORIGINS is how a deployment names its own origins — the origin an app
  // is served from is a fact about the deployment, not about the app — and it
  // is applied onto the config above rather than at a second install site.

  // ── Health + metrics ──────────────────────────────────────────────────
  // GET /health  → liveness + readiness (503 if DB unreachable)
  // GET /metrics → conduit + caravan stats merged in via registerMetricsSource
  app.configure(healthPlugin({
    checks: {
      db: () => !!rawDb.query('SELECT 1').get(),
    },
  }))

  // ── Devtools console ──────────────────────────────────────────────────
  // AFTER health and the queue: the console reads what plugins contributed, so
  // configuring it first would open on an app that has not claimed its sections
  // yet. Nothing is registered on this app's own router — it runs its own
  // server on its own port.
  if (env.DEVTOOLS) app.configure(devtools({ port: env.DEVTOOLS_PORT }))

  // ── Channels — real-time WebSocket push ───────────────────────────────
  //
  // A connection joins every workspace its user belongs to.
  //
  // This used to read `session.workspace_id` and join that one channel. Two
  // things were wrong with it, and together they meant **no client ever
  // received a single channel event**:
  //
  //   1. The field is `workspaceId` (SessionContext, junction/src/auth/types.ts).
  //      `workspace_id` is undefined, so the `if` never fired — the same stale
  //      snake_case idiom that made every service read ctx.params.user.user_id.
  //   2. Even spelled correctly it would be empty: @frontierjs/auth issues the
  //      session and knows nothing about workspaces, so nothing populates it.
  //
  // Membership is the real answer, and it is a query rather than a claim on the
  // token — which also handles the case a single-workspace join could never
  // handle: a person in two workspaces who switches between them mid-session
  // without reconnecting.
  app.configure(channels((a) => {
    a.channels?.on('connection', async (session: unknown, conn) => {
      const s = session as { userId?: string } | null
      if (!s?.userId) return

      a.channel?.('authenticated').join(conn)

      // asSystem(): resolving who may hear what is not a request the caller
      // makes, and WorkspaceMember is not readable through the caller's own
      // scope at connect time — there is no workspace header on an upgrade.
      const memberships = await db.asSystem().workspaceMember.findMany({
        where:  { userId: s.userId },
        select: { workspaceId: true },
      })

      for (const m of memberships) a.channel?.(workspaceChannelName(m.workspaceId)).join(conn)
    })
  }))

  // ── Services ──────────────────────────────────────────────────────────
  // Not registered here: Junction autoloads `**/*.service.ts` from the
  // directory beside the entry file (api/src/services/), calls each
  // create*Service(app) factory and registers the result. Registering them by
  // hand as well ran every factory twice — the second copy was dropped with
  // "[Loader] Skipping duplicate service", but its side effects had already
  // happened. Autoload runs during start(), before compile-hook-pipelines, so
  // the app-level hooks below still reach every service.

  // ── Global hooks ──────────────────────────────────────────────────────
  app.hooks({
    around: {
      all: [
        async (ctx, next) => {
          const t = Date.now()
          await next()
          logger.debug(`${ctx.service}.${ctx.method}`, { ms: Date.now() - t })
        },
      ],
    },
    before: {
      // App level, not per service: a key that is scoped on fifteen services
      // and unscoped on the sixteenth is not scoped. A session passes through
      // untouched — this only has an opinion about authMethod 'apiKey'.
      //
      // refuseSuspended is the second door on the same rule: login refuses a
      // suspended account, this refuses a token issued before the suspension —
      // including an API key, which is a Credential and survives having every
      // Session row deleted. It costs no query, because `status` is on the
      // session already (sessionFields above).
      all: [
        apiKeyGuard(app), refuseSuspended(),
        // The three endpoints a machine calls. They are exempted from
        // sessionScope because an outpost holds no session — this is the
        // credential that replaces one, and it is registered app-level so a new
        // outpost-facing method cannot be added to a service and quietly
        // inherit the exemption without it (`FJS-349`).
        requireOutpostSignature(app, { only: OUTPOST_ENDPOINTS }),
        // The other half of the trail. A diff needs the row as it stands, and
        // an `after` hook cannot have it — so the pre-image is read here, under
        // the same exception list the `after` half takes.
        basecampAuditPreImage(app, { except: AUDIT_EXCEPT }),
      ],
    },
    after: {
      // `all`, not the three CRUD verbs: a custom method is a mutation too, and
      // drain / cancel / deploy / trigger are most of what an operator does.
      // The hook itself decides what counts (find/get and dispatch:false are
      // out) and takes the exceptions by name.
      all: [
        // Both exceptions are an outpost on a timer. Fifty machines reporting
        // their disks every minute buries every action a person took, and an
        // audit trail nobody can read is an audit trail nobody reads.
        // Deliberately NOT `ctx.dispatch = false` — that would also silence the
        // channel, and both screens are fed by exactly that publish.
        basecampAuditLog(app, { except: AUDIT_EXCEPT }),
        // Only fires when apiKeyGuard stamped a key id, so a session request
        // pays nothing for it.
        apiKeyUsage(app),
      ],
    },
    error: {
      all: [(ctx) => {
        logger.error(`${ctx.service}.${ctx.method} failed`, ctx.error ?? undefined)
      }],
    },
  })

  // ── Schedules held in the database ────────────────────────────────────
  // A job file registers its own handler — caravan autoloads `api/src/jobs`.
  // What no file can declare is a schedule that came from a ROW: cron
  // registration is in-process, so every scheduled Job stopped firing at the
  // first restart with the row still reading `scheduled` (`FJS-327`).
  //
  // Not awaited: this runs while the app is being built, and the queue's own
  // database opens on first use. A failure must not take the API down — an
  // unschedulable fleet is worse served by an app that will not boot.
  restoreSchedules(app)
    .then(n => logger.info('schedules restored', { count: n }))
    .catch(err => logger.error('could not restore schedules', { error: (err as Error).message }))

  // ── Custom routes — wrapped in configure() ────────────────────────────
  // Must be inside configure() so they register during start() Phase 1,
  // after CORS has patched the router. Direct app.post() calls made outside
  // a configure() block go onto the un-patched router and never receive
  // CORS headers on preflight requests.

  // @frontierjs/auth mounts /auth/{login,logout,register,…} plus the `account`
  // and `sessions` services — GET /account/me is what /auth/me was. The
  // hand-rolled versions of these are gone — they read password_hash off the
  // user table, a column that moved to Credential when the schema adopted
  // auth's fragments.
  //
  // No /api prefix anywhere: services mount at /{service} (junction's default
  // apiPrefix is ''), so prefixing only these two made the app's own paths
  // disagree with each other and with the browser client, whose needsSetup()
  // asks for `${apiPrefix}/setup/probe` and swallows the 404.
  // `apiKeys: false` because this app already has an `api-keys` service, and
  // its keys are a WORKSPACE's rather than a person's — a different noun that
  // happens to share a word. The plugin refuses the collision by name rather
  // than one of the two silently replacing the other.
  //
  // No `level`: a level here is per workspace (core/gate.ts), so there is no
  // single number `account.me` could answer with. `applyStanding` resolves it
  // per request instead.
  app.configure(createAuthPlugin(auth, { prefix: '/auth', services: { apiKeys: false } }))

  app.configure(function setupRoutes(a) {
    const sys = db.asSystem()

    // The workspace the UI should select after login. Not part of auth's
    // /auth/login response, so it is its own call.
    a.get('/auth/workspace', async (ctx) => {
      if (!ctx.user) return ctx.json({ message: 'Not authenticated' }, 401)
      const member = await sys.workspaceMember.findFirst({
        where:   { userId: (ctx.user as { userId: string }).userId },
        orderBy: { createdAt: 'asc' },
      })
      return ctx.json({ workspace_id: member?.workspaceId ?? null })
    })

    // GET /setup/probe — first-run detection for the setup wizard
    a.get('/setup/probe', async (ctx) => {
      const [workspaces, users] = await Promise.all([
        sys.workspace.count(),
        sys.user.count({ where: { status: 'active' } }),
      ])
      return ctx.json({ workspaces, users, needs_setup: workspaces === 0 || users === 0 })
    })

    // POST /setup — first-run bootstrap: account + user + workspace + membership.
    a.post('/setup', async (ctx) => {
      const { workspace_name, name, email, password } =
        (ctx.body ?? {}) as { workspace_name?: string; name?: string; email?: string; password?: string }

      if (!workspace_name?.trim()) return ctx.json({ message: 'workspace_name required' }, 400)
      if (!name?.trim())           return ctx.json({ message: 'name required' }, 400)
      if (!email?.trim())          return ctx.json({ message: 'email required' }, 400)
      if (!password || password.length < 8)
        return ctx.json({ message: 'password must be at least 8 characters' }, 400)

      if (await sys.user.count({ where: { status: 'active' } }) > 0)
        return ctx.json({ message: 'Basecamp already set up — use /auth/login' }, 409)

      const wsName = workspace_name.trim()
      const slug   = slugify(wsName)

      // One transaction: a half-built account is worse than none. The previous
      // version opened with three unconditional DELETEs to clean up after
      // itself — that is what running this without a transaction costs.
      const { account, workspace } = await sys.$transaction(async (tx: any) => {
        const account = await tx.account.create({
          data: { type: 'organization', status: 'active', slug, displayName: wsName },
        })
        // auth owns User: it hashes the password into a Credential row. Doing
        // it here by hand is what made the old setup route and the old login
        // route disagree about where the hash lived.
        const session = await auth.createUser({ email: email.trim(), name: name.trim(), password })
        // The first user is the system administrator, and this is the only
        // place one is created rather than granted. It has to be: the hub is
        // the screen that grants the flag, requireSystemAdmin refuses anyone
        // without it, and an app whose only route in is /setup would otherwise
        // ship with a tier nobody could ever reach. Every subsequent one is
        // granted from /hub/users/ by someone who already holds it.
        const user    = await tx.user.update({
          where: { id: session.userId },
          data:  { accountId: account.id, status: 'active', displayName: name.trim(),
                   emailVerified: true, isSystemAdmin: true },
        })
        const workspace = await tx.workspace.create({
          data: { accountId: account.id, name: wsName, slug, type: 'team', ownerId: user.id },
        })
        await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, userId: user.id, role: 'owner',
                  capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() },
        })
        return { account, workspace }
      })

      const login = await auth.login(email.trim(), password)

      return ctx.json({
        token:        login.token,
        user:         login.user,
        workspace_id: workspace.id,
        workspace:    { id: workspace.id, name: wsName, slug },
        account_id:   account.id,
      }, 201)
    })

    // DELETE /setup — dev-only reset
    a.delete('/setup', async (ctx) => {
      if (env.NODE_ENV === 'production')
        return ctx.json({ message: 'Reset not available in production' }, 403)

      // Order matters: children before parents, since FKs are ON.
      // Indexed by name: the accessors are known, the LOOP is what makes this
      // dynamic, so the cast is here rather than a per-accessor branch.
      const byName = sys as unknown as Record<string, { deleteMany(args: object): Promise<unknown> }>
      for (const model of ['workspaceMember', 'session', 'credential', 'verification', 'workspace', 'user', 'account'])
        await byName[model].deleteMany({})

      logger.warn('setup data wiped via DELETE /setup (dev only)')
      return ctx.json({ ok: true, message: 'Setup data cleared — reload to run setup again' })
    })
  })

  app.configure(function staticRoutes(a) {
    a.get('/', () => Bun.file(new URL('../../web/index.html', import.meta.url).pathname))
  })

  // ── Graceful shutdown ─────────────────────────────────────────────────
  app.configure({
    name: 'basecamp-cleanup',
    shutdown: async () => {
      dbClient.close()
    },
  })

  return app
}
