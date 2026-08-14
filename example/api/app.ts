// api/app.ts — the API realm.
//
//   bun run api        → http://localhost:8110
//
// Read db.ts first (the client and the gate), then gate.ts (how a session
// becomes a number). This file only assembles them.

import {
  createApp, channels, healthPlugin, manifestPlugin,
  type App,
} from '@frontierjs/junction'

import { createLitestoneAuth, createAuthPlugin } from '@frontierjs/auth'
import { createCaravan }        from '@frontierjs/caravan'
import { conduit }              from '@frontierjs/conduit'
import { notificationsPlugin }  from '@frontierjs/notifications'
import { mailerPlugin }         from '@frontierjs/junction'

import { db, DEV_KEY }   from './db.ts'
import { shopGateLevel } from './gate.ts'
import { seed, DEMO }    from './seed.ts'
import { setApp }         from './app-ref.ts'
import { sweepAbandoned } from './jobs/sweep-abandoned.ts'
import { startMailSink }  from './mail-sink.ts'
import { createConduitMailer, MAIL_TARGET } from './mailer.ts'

const PORT = 8110

// ─── Auth ─────────────────────────────────────────────────────────────────
//
// Real auth, not a Map of tokens: password hashing, sessions with expiry,
// password reset and email verification are all in the package. What is NOT
// wired here is the mail side — onPasswordResetRequested / onEmailVerification
// Requested are where a mailer would go, and phase 2 hangs @frontierjs/conduit
// off exactly those two callbacks.

const auth = createLitestoneAuth(db, {
  encryptionKey: process.env.ENCRYPTION_KEY ?? DEV_KEY,
  // What 'admin' means here, said once. api/gate.ts grades the role string onto
  // ADMINISTRATOR(5); auth's own User model bounds its columns with
  // @allow('write', auth().isAdmin) and a row policy that reads the same field.
  // Without this projection the two would disagree — the level would say admin
  // and the policy would not — and the disagreement is silent, because a policy
  // filters rather than refuses.
  sessionFields: (user: { role?: string }) => ({ isAdmin: user.role === 'admin' }),
})

await seed(auth)

// ─── App ──────────────────────────────────────────────────────────────────

const app = createApp({
  db,
  auth,
  config: { name: 'shop', port: PORT, apiPrefix: '/api' },
})

app.configure(healthPlugin())

// GET /api/manifest — what this app IS, read off live runtime state: services,
// their methods and hooks, channels, plugins, and every route the router will
// answer. `fli api:routes` reads the last of those, which is the only way to
// ask a Junction app what it serves: the surface is emergent, so it cannot be
// read off the source. devOnly by default, so a production build 404s here.
app.configure(manifestPlugin({ db }))

// Mounts POST /api/auth/register, /api/auth/login, /api/auth/logout,
// GET /api/auth/me and the password-reset + email-verify routes. Deliberately
// NOT services: login cannot be gated by login.
//
// The login limiter is real and stays on — but its production default is 10 per
// 15 minutes, and this app's own five drives sign in SEVEN times per full
// sweep. Two sweeps in a quarter hour then fail on the limiter rather than on
// anything they are testing, which is a false negative on a suite whose whole
// job is to be trusted. Raised here, in the app, rather than weakened in the
// package: an app decides what its own login volume looks like, and a demo
// shop on localhost is not a login-stuffing target.
app.configure(createAuthPlugin(auth, {
  loginRateLimit: { max: 100, window: '15 minutes' },
}))

// ─── Deferred work ────────────────────────────────────────────────────────
//
// Caravan is a SQLite queue in its own file — nothing about it touches
// db/shop.db, so a wiped queue loses no shop data and a wiped shop loses no
// jobs. `app.configure` claims `app.jobs`; `boot()` starts the workers and
// autoloads `api/jobs/*.job.ts`.
//
// `admin: true` mounts GET /jobs, GET /jobs/schedules, GET /jobs/{id} and the
// retry/cancel posts — under this app's apiPrefix like everything else, so the
// URLs are /api/jobs/… and one proxy entry in web/config/vite.config.js covers
// them. No secret here because this is a demo shop on localhost;
// `admin: { secret }` is the option that stops it being public.

const queue = createCaravan({
  db:      './db/jobs.db',
  jobsDir: './api/jobs',
  admin:   true,
  queues:  {
    default:    { concurrency: 2 },
    // One at a time: the courier's API is rate limited in the story, and a
    // single worker makes the queue's behaviour observable in a drive.
    fulfilment: { concurrency: 1 },
  },
})

app.configure(queue)

// A job file cannot say WHEN it runs (defineJob has no `cron` key), so the
// recurring one is declared here, in one call, with its handler imported from
// api/jobs/sweep-abandoned.ts. 03:00 daily, because a shop cancels abandoned
// checkouts at night and not while people are buying.
queue.schedule('sweep-abandoned', '0 3 * * *',
  (job: { data?: { days?: number } }) => sweepAbandoned(job.data?.days))

// Jobs reach the service layer through this, and only this. See api/app-ref.ts
// for why a Caravan handler cannot be handed the app directly.
setApp(app)

// ─── Outbound ─────────────────────────────────────────────────────────────
//
// Conduit is the other direction from Junction: everything this app sends to
// something outside itself goes through a declared TARGET, never a raw URL.
// There is one target here — the mail provider — and it is enough to make the
// point, because the alternative (junction's `createResendMailer`) holds a URL
// and an API key in a closure and calls fetch() directly.
//
// `auth.ref` is a credential REFERENCE. The default resolver reads
// `process.env[ref]` at SEND time, so the secret is not in the registry, not in
// `list()`, not in a hook, and not in this file. An unresolvable ref fails
// CLOSED: `send()` answers `auth_failed`, `retryable: false`, naming the target
// and the ref and never the value.
//
// The address points at api/mail-sink.ts — a dev mail catcher that speaks the
// provider's shape. Pointing this at api.resend.com is a change of `address`
// and `ref` here, and nothing else anywhere.

const MAIL_SINK = process.env.MAIL_SINK_URL ?? `http://localhost:${process.env.MAIL_SINK_PORT ?? 8111}`
// Bound only when this file is the entry. `junction surface` imports it to
// describe the app, and a describe that binds 8111 fights the dev server.
const sink = process.env.MAIL_SINK_URL || !import.meta.main ? null : startMailSink()

app.configure(conduit({
  targets: [{
    id:            MAIL_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       MAIL_SINK,
    auth:          { type: 'bearer', ref: 'SHOP_MAIL_KEY' },
    registered_at: Date.now(),
    last_seen_at:  null,
  }],
}))

// The one env var this app needs and does not default: the sink accepts
// 'dev-mail-key', so the default keeps the example runnable with no setup while
// staying a real credential lookup rather than a hardcoded header.
process.env.SHOP_MAIL_KEY ??= 'dev-mail-key'

// ─── Notifications ────────────────────────────────────────────────────────
//
// `app.notify(user, notification)`. The mailer must be configured FIRST — the
// plugin declares `requires: ['mailer']` when the email channel is on, and
// Junction checks that at startup against presence *and* configure order, so
// getting it wrong is a boot failure rather than a send failure an hour later.

app.configure(mailerPlugin(createConduitMailer(app, { from: 'shop@example.test' })))
app.configure(notificationsPlugin({ db, channels: { email: { mailer: 'default' } } }))

app.configure(channels((a: App) => {
  a.channels!.on('connection', (session, conn) => {
    for (const name of ['orders', 'products', 'customers']) a.channel!(name).join(conn)
    // The inApp driver publishes to `notifications:user:<id>`, so a signed-in
    // connection joins its own. An anonymous one has nothing to join — which is
    // also the only reason this is not `for every channel`.
    const userId = (session as { userId?: string; id?: string } | null)?.userId
                ?? (session as { id?: string } | null)?.id
    if (userId) a.channel!(`notifications:user:${userId}`).join(conn)
  })
}))

// ─── GET /api/session ─────────────────────────────────────────────────────
//
// Registered as '/session': app.get applies this app's apiPrefix, the same as
// it does to every service route and to the auth plugin's own.
//
// The browser needs the caller's gate level to decide which buttons to offer.
// It could compute one from `role`, but then the role→level mapping would exist
// in two places and could drift — so the server, which owns that translation
// (api/gate.ts), answers the question. The UI treats the answer as an
// affordance; every request is graded again on arrival regardless.

app.get('/session', async ctx => {
  const header  = ctx.headers?.authorization ?? ctx.headers?.Authorization ?? ''
  const token   = header.replace(/^Bearer /i, '')
  const session = token ? await auth.verifySession(token).catch(() => null) : null
  return ctx.json({
    level: shopGateLevel(session),
    email: session?.email ?? null,
    role:  session?.role  ?? null,
  })
})

// ─── Serve ────────────────────────────────────────────────────────────────
//
// The app is exported, and only listens when this file IS the entry. Something
// that wants to describe the app rather than serve it — `junction surface`,
// which writes the committed surface.snapshot.md — must be able to import it
// without taking the port the dev server is already on.

export { app }

if (import.meta.main) {
  await app.start()

  if (sink) console.log(`  [mail] dev sink on ${MAIL_SINK} — GET ${MAIL_SINK}/outbox`)

  console.log(`
  ─────────────────────────────────────────────────────────────
    API   http://localhost:${PORT}/api/orders
    UI    bun run dev        → http://localhost:8010

    Sign in as:
      user   ${DEMO.user.email}  / ${DEMO.user.password}     → level 4
      admin  ${DEMO.admin.email} / ${DEMO.admin.password}    → level 5

    curl http://localhost:${PORT}/api/orders                  # 200, public read
    curl -X POST http://localhost:${PORT}/api/orders \\
         -H 'content-type: application/json' -d '{}'          # 401, @@gate
  ─────────────────────────────────────────────────────────────
`)
}
