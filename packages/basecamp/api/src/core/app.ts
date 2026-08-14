// src/core/app.ts
// Basecamp application bootstrap.

import {
  createApp,
  createDatabase,
  createLogger,
  cors,
  channels,
  healthPlugin,
  authenticate,
} from '@frontierjs/junction'

import { conduit }           from '@frontierjs/conduit'
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
import { createCaravan }     from '@frontierjs/caravan'

import { env }                       from './env.ts'
import { buildInfra }                from '../infra/index.ts'
import { createLitestoneAuth, createAuthPlugin } from '@frontierjs/auth'
import { createBasecampDb }              from './db.ts'
import { createSecretResolver }          from './credentials.ts'
import { basecampAuditLog, withWorkspaceStanding } from './hooks.ts'
import { basecampSessionFields, refuseSuspendedLogin, refuseSuspended } from './session-auth.ts'
import { apiKeyGuard, apiKeyUsage }       from '../services/api-keys/scopes.ts'
import { slugify }                        from './resource.ts'
import { createDeploymentEngine }    from '../engine/deployment.engine.ts'
import { createJobEngine }           from '../engine/job.engine.ts'
import { createFleetEngine }         from '../engine/fleet.engine.ts'

import type { BasecampApp } from '../basecamp.types.ts'

export async function buildBasecampApp(): Promise<BasecampApp> {

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
  //              bun:sqlite handle to Conduit's store and the health check,
  //              both of which want a Database, not an ORM.
  //   db       — the Litestone client. THE Data boundary: every service,
  //              engine and bootstrap path reads and writes through it.
  //
  // Migrations run first, so the Litestone client opens a database whose
  // tables already exist.
  const migrationsDir = new URL('../../../db/migrations', import.meta.url).pathname
  const dbClient      = createDatabase({ path: env.DATABASE_URL, log: env.DB_LOG })
  await dbClient.migrate(migrationsDir)

  const rawDb = dbClient.db
  const db    = await createBasecampDb()

  // ── Auth ─────────────────────────────────────────────────────────────
  // @frontierjs/auth over the Litestone client. It owns User / Credential /
  // Session / Verification — the same four models db/schema.lite declares,
  // which is why the model names there are load-bearing.
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
  const loadedConfig = await loadConfig(
    new URL('../../config', import.meta.url).pathname
  ).catch(() => defaultConfig)

  const config = {
    ...loadedConfig,
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
  const app = createApp({ config, auth, db }) as BasecampApp

  // Attach DB and Basecamp-specific subsystems.
  // app.provide() is the guarded namespace claim — it throws on a collision
  // instead of silently last-write-wins.
  app.provide('data', db)
  app.db     = dbClient
  app.logger = logger
  app.infra  = await buildInfra(
    ((config as Record<string, unknown>).infra ?? {}) as Record<string, Record<string, unknown>>
  )

  // ── Conduit — outbound transport ──────────────────────────────────────
  // Plugin augments app with app.conduit, wires /metrics, and registers
  // the management service. It is a Junction service, so it lands at
  // GET|DELETE /conduit-targets — verified, not the /api/conduit/targets this
  // comment used to claim, which never existed.
  app.configure(conduit({
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
    hooks: {
      onRequest:  (req)       => logger.debug('conduit →', { target: req.target, method: req.method }),
      onResponse: (_req, res) => { if (res.error) logger.warn('conduit error', { kind: res.error.kind }) },
      onError:    (req, err)  => logger.error('conduit failed', { target: req.target, kind: err.kind }),
    },
  }))

  // ── Caravan — durable job queue ───────────────────────────────────────
  // Plugin augments app with app.jobs and wires /metrics job stats.
  const queue = createCaravan({
    db:          env.DATABASE_URL.replace('.db', '-jobs.db'),
    pollInterval: 1_000,
    queues: {
      default:     { concurrency: 2 },
      deployments: { concurrency: 3 },
      jobs:        { concurrency: 5 },
      sync:        { concurrency: 2 },
      // Recipes and disk sweeps. Held low on purpose: both run a command on a
      // real machine through its outpost, and twenty at once is twenty machines
      // busy at the same moment rather than a fleet that stays serving.
      fleet:       { concurrency: 2 },
    },
  })
  app.configure(queue)

  // ── Standard middleware ────────────────────────────────────────────────
  app.configure(cors({
    origins: (config as Record<string, unknown>).cors as string[] ?? ['*'],
    credentials: true,
  }))

  // ── Health + metrics ──────────────────────────────────────────────────
  // GET /health  → liveness + readiness (503 if DB unreachable)
  // GET /metrics → conduit + caravan stats merged in via _metricsProviders
  app.configure(healthPlugin({
    checks: {
      db: () => !!rawDb.query('SELECT 1').get(),
    },
  }))

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

      for (const m of memberships) a.channel?.(`workspace:${m.workspaceId}`).join(conn)
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
        // FIRST, and an around hook rather than a before one: it decides what
        // the caller's Litestone client is, and every before hook after it —
        // and every method — reads through that client. Junction installs its
        // own scoping around hook at createApp({ db }), before this file runs,
        // so this composes INSIDE it and replaces the client it made with one
        // whose principal carries the workspace role. See core/hooks.ts.
        withWorkspaceStanding(app),
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
      all: [apiKeyGuard(app), refuseSuspended()],
    },
    after: {
      // `all`, not the three CRUD verbs: a custom action is a mutation too, and
      // drain / cancel / deploy / trigger are most of what an operator does.
      // The hook itself decides what counts (find/get and dispatch:false are
      // out) and takes the exceptions by name.
      all: [
        // Both exceptions are an outpost on a timer. Fifty machines reporting
        // their disks every minute buries every action a person took, and an
        // audit trail nobody can read is an audit trail nobody reads.
        // Deliberately NOT `ctx.dispatch = false` — that would also silence the
        // channel, and both screens are fed by exactly that publish.
        basecampAuditLog(app, { except: ['servers.heartbeat', 'volumes.report', 'cleanup.report'] }),
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

  // ── Engines ───────────────────────────────────────────────────────────
  createDeploymentEngine(app).register()
  createJobEngine(app).register()
  createFleetEngine(app).register()

  // ── Custom routes — wrapped in configure() ────────────────────────────
  // Must be inside configure() so they register during start() Phase 1,
  // after CORS has patched the router. Direct app.post() calls made outside
  // a configure() block go onto the un-patched router and never receive
  // CORS headers on preflight requests.

  // @frontierjs/auth mounts /auth/{login,logout,register,me,...}. The
  // hand-rolled versions of these are gone — they read password_hash off the
  // user table, a column that moved to Credential when the schema adopted
  // auth's fragments.
  //
  // No /api prefix anywhere: services mount at /{service} (junction's default
  // apiPrefix is ''), so prefixing only these two made the app's own paths
  // disagree with each other and with the browser client, whose needsSetup()
  // asks for `${apiPrefix}/setup/probe` and swallows the 404.
  app.configure(createAuthPlugin(auth, { prefix: '/auth' }))

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
          data: { workspaceId: workspace.id, userId: user.id, role: 'owner', acceptedAt: new Date().toISOString() },
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
      for (const model of ['workspaceMember', 'session', 'credential', 'verification', 'workspace', 'user', 'account'])
        await sys[model].deleteMany({})

      logger.warn('setup data wiped via DELETE /setup (dev only)')
      return ctx.json({ ok: true, message: 'Setup data cleared — reload to run setup again' })
    })
  })

  app.configure(function staticRoutes(a) {
    a.get('/', () => Bun.file(new URL('../../../web/index.html', import.meta.url).pathname))
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
