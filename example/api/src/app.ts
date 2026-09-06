// api/src/app.ts — the API realm, assembled.
//
//   bun run api        → http://localhost:8110
//
// Read core/db.ts first (the client and the gate), then core/gate.ts (how a
// session becomes a number). This file only assembles them.
//
// It EXPORTS a configured app and never starts one. `api/index.ts` is the entry
// that calls start(); keeping the two apart is what lets `junction surface` and
// `junction jobs` import this file to describe the app without taking the port
// the dev server is already on.

import {
  createApp, channels, healthPlugin, manifestPlugin, devtools,
  type App,
} from '@frontierjs/junction'

import { createLitestoneAuth, createAuthPlugin, defineProvider } from '@frontierjs/auth'
import { createCaravan }                        from '@frontierjs/caravan'
import { conduit }                              from '@frontierjs/conduit'
import { notificationsPlugin }                  from '@frontierjs/notifications'
import { mailerPlugin, outbox }                 from '@frontierjs/junction'

import { db, shops, DEFAULT_SHOP, DEV_KEY, STORAGE_ROOT } from './core/db.ts'
import { perShopAuth }                          from './core/auth.ts'
import { shopGateLevel, SYSTEM }                from './core/gate.ts'
import { joinChannels }                         from './core/channels.ts'
import { cartClaim, CART_HEADER }               from './domain/shop'
import { IDP_URL }                              from './providers/idp/sink.ts'
import { createConduitMailer, MAIL_TARGET }     from './providers/mail/mailer.ts'
import { PSP_TARGET, PSP_URL, WEBHOOK_PATH, verifyWebhook } from './providers/psp/index.ts'
import { stripeTarget, verifyStripeSignature, STRIPE_WEBHOOK_PATH } from './providers/stripe/index.ts'

// 8110 is dev/be/project-1 — derived, never chosen (packages/cli/core/ports.js).
// The env override is what lets a drive start an app of its own on the TEST row
// (7110) instead of needing one hand-started on the dev row, which is the
// difference between `verify:cart` and every drive with a preamble.
const PORT = Number(process.env.API_PORT ?? 8110)

// ─── Auth ─────────────────────────────────────────────────────────────────
//
// Real auth, not a Map of tokens: password hashing, sessions with expiry,
// password reset and email verification are all in the package.
//
// ─── The mail side, and why its absence was invisible ─────────────────────
//
// `requestPasswordReset` MINTS a token and sends nothing. Sending is
// `onPasswordResetRequested`, a callback the app supplies — auth cannot have an
// opinion about how an app sends mail — and this app did not supply one, for
// its whole life, with a comment here saying so.
//
// The failure that produces is silent by construction: the route answers **200**
// either way, deliberately, because it must never reveal whether an address is
// registered. So *reset works* and *reset mints a row nobody will ever see* are
// the same response, and no test could tell them apart without reading the
// outbox. `POST /api/auth/password-reset/request` → 200, outbox empty, measured.
//
// It is wired below, and the users screen is what forced it: creating an account
// makes a `User` and no `Credential`, so the new person can only get in through
// a link — and the link had nowhere to go.

// ─── Cookie sessions, and why they are a switch ───────────────────────────
//
// This app is Bearer everywhere else, and OAuth cannot be: its callback is a
// browser redirect, so a session can only come back as a cookie. Rather than
// move the whole app onto cookies — which would change what every other drive
// is testing — the mode is a switch the OAuth drive turns on for its own server.
//
// It is ALSO what narrows CORS, and the two belong together: the note on the
// `cors` block below names a cookie session as one of exactly two things that
// would make `*` wrong there, because the browser attaches a cookie unasked.
export const COOKIE_AUTH = process.env.SHOP_COOKIE_AUTH === '1'

/** The last link invitation, for the drive to read. Dev only — see the hook. */
export let lastLinkInvite: { email: string; token: string; provider: string } | null = null

const authOptions = {
  encryptionKey: process.env.ENCRYPTION_KEY ?? DEV_KEY,
  // What 'admin' means here, said once. api/gate.ts grades the role string onto
  // ADMINISTRATOR(5); auth's own User model bounds its columns with
  // @allow('write', auth().isAdmin) and a row policy that reads the same field.
  // Without this projection the two would disagree — the level would say admin
  // and the policy would not — and the disagreement is silent, because a policy
  // filters rather than refuses.
  // The one route an app's own User columns take onto the SessionContext, and
  // therefore onto `auth()` at the Data boundary. `isStaff` is the shop's own
  // column (`extend model User` in db/schema.lite) and is what separates a
  // member of staff from a shopper — both of whom grade USER(4), because a
  // level answers what KIND of caller and not WHICH person.
  sessionFields: (user: { role?: string, isStaff?: boolean }) => ({
    isAdmin: user.role === 'admin',
    isStaff: user.isStaff === true || user.role === 'admin',
  }),

  // ── Where a minted token becomes an email ──────────────────────────────
  //
  // A Delegate (`FJS-D06` §1): auth hands over the only copy of the token that
  // will ever be in plain text — the column is `@guarded` the moment it is
  // written — and this is the one chance to put it in front of a person.
  //
  // `app` is referenced lazily rather than captured: this object is built before
  // `createApp`, and the callback runs at request time when `app.mail` is long
  // since configured. A mailer that is absent is a warning and not a throw,
  // because `verify:oauth` and `verify:tenants` start their own apps without
  // one and a reset attempt there must not fail the run.
  onPasswordResetRequested: async (email: string, token: string) => {
    const link = `${process.env.SHOP_PUBLIC_URL ?? `http://localhost:${PORT}`}/reset?token=${encodeURIComponent(token)}`
    if (!app?.mail) {
      console.warn(`[shop] no mailer configured — password-reset link for ${email} was not sent`)
      return
    }
    await app.mail.send({
      to:      email,
      subject: 'Set your password',
      text:    `Somebody asked to set a password for this address at the shop.\n\n${link}\n\n`
             + `If that was not you, ignore this — nothing has changed.`,
    })
  },

  // ── Signing in with a provider ──────────────────────────────────────────
  //
  // `oidc` rather than a named preset because the provider is this repo's own
  // dev one on :8113 — and `oidc` ships `trustEmail: false`, which is right for
  // an issuer nobody has vouched for. It is turned ON here because the drive
  // needs the trusted path to exist somewhere, and this issuer is one we run.
  //
  // Both halves of the linking rule are exercised from that single switch: with
  // the claim trusted, a verified provider address links to a verified account
  // and refuses an unverified one.
  oauthProviders: {
    devidp: defineProvider('devidp', 'oidc', {
      clientId:     process.env.IDP_CLIENT_ID     ?? 'dev-idp-client',
      clientSecret: process.env.IDP_CLIENT_SECRET ?? 'dev-idp-secret',
      authorizeUrl: `${IDP_URL}/authorize`,
      tokenUrl:     `${IDP_URL}/token`,
      userinfoUrl:  `${IDP_URL}/userinfo`,
      trustEmail:   true,
    }),
  },
  oauthReturnToAllow: ['/orders', '/orders/'],
  // Nothing is mailed in dev; the drive reads the token from here, which is the
  // same thing the mail sink does for a password reset one door along.
  onOAuthLinkRequested: async ({ email, token, provider }: { email: string, token: string, provider: string }) => {
    lastLinkInvite = { email, token, provider }
  },
}

// One provider per SHOP. The options above are the same everywhere; the CLIENT
// is not, because a shop's people live in the shop's own file — see core/auth.ts
// for the two places the shop comes from and why it cannot be one.
const auth = perShopAuth(shops, DEFAULT_SHOP, authOptions, createLitestoneAuth(db, authOptions))

// ─── App ──────────────────────────────────────────────────────────────────

const app = createApp({
  // ── Where the services are, stated rather than probed ──────────────────
  //
  // `resolveServicesDir` probes `./services` then `./src/services` beside the
  // ENTRY file, and under a test runner the entry is the TEST FILE. So a drive
  // that imports this module to start the app in its own process — which is
  // what `verify:collect` has to do, because a conduit target is registered in
  // `boot()` and an unstarted app has none — got an app with four services and
  // no route for the rest. A missing directory is a silent no-op: the app
  // boots, `/health` answers, and every service route is a 404.
  //
  // An absolute URL rather than a relative path, because a relative one is
  // resolved against the process's working directory and the whole point is
  // that this file cannot know what started it.
  autoload: new URL('./services', import.meta.url).pathname,

  // ── Where the config is, for the same reason ───────────────────────────
  //
  // The default is `./api/config` resolved against the CWD, so this app read
  // its own config only when the command was typed at the app root. From
  // `api/` it looked for `api/api/config`, found nothing, and booted on
  // junction's defaults — with `caravan: { admin: true }` never applied, so
  // the /api/jobs* routes were absent from an app that plainly mounts them
  // (`FJS-431`'s shape, and the reason `scripts/ci-allowances.json` had to
  // name a second surface snapshot that disagreed with this one by six
  // routes). Anchored here, every `junction <tool> --app` runs from wherever
  // the artefact it writes lives.
  configPath: new URL('../config', import.meta.url).pathname,

  // The FLEET, not one database. `withTenantDb` resolves the shop this request
  // is for and puts that shop's caller-scoped client on `ctx.locals.db`, which
  // is what every service reads through `$.db`. `db` and `tenants` are
  // alternatives — one `ctx.locals.db` cannot be assigned by two hooks.
  tenants: shops,
  auth,
  // Who the shop is when it acts on its own behalf. Deferred work started by
  // nobody — the nightly sweep — runs as this, and it is graded by api/gate.ts
  // like every other principal. Work a person asked for runs as that person:
  // Caravan records who dispatched it and re-resolves them when it runs.
  system: SYSTEM,

  // Who the caller is FOR THIS REQUEST, beyond who they are. The basket is the
  // one thing here owned by a stranger, so the claim that scopes it has to be
  // resolved for a caller with no session at all — see api/cart-claim.ts.
  principal: cartClaim,

  // ── Each shop is a business, and a business has a name ──────────────────
  //
  // `tenancy { }` decides which ROWS a caller sees and stops there; the
  // customer-facing half of *this is my shop* is mostly not rows — the name on
  // the receipt and the address the confirmation comes from (`FJS-D126`).
  //
  // The source is the registry's own per-tenant meta blob, which has carried
  // arbitrary JSON since tenants existed and which nothing has ever read. A
  // control plane rather than a row, and the reason the ruling refused to
  // declare the source: basecamp's would be a row, an app deployed per customer
  // would use a file, and this one already had somewhere to put it.
  //
  // `tenantConfigKeys` is the half that makes it safe rather than the half that
  // makes it work — only these two paths apply, a resolver answering anything
  // else is refused by name, and `database` could not be listed here even by
  // mistake: junction refuses the reserved paths at boot, and a shop naming its
  // own database file is every other shop's orders.
  // Under `.config` rather than at the top of the blob: the registry's meta is
  // general-purpose and a shop may keep anything there, while junction refuses a
  // key `tenantConfigKeys` does not name — so reading the blob whole would make
  // one unrelated field break every request for that shop.
  tenantConfig:     (shop: string) => (shops.meta(shop).config ?? {}) as Record<string, unknown>,
  tenantConfigKeys: ['name', 'mail.from'],

  config: {
    name: 'shop', port: PORT, apiPrefix: '/api',

    // The FLOOR for every shop. A shop whose registry meta names neither reads
    // exactly these, which is what makes adopting per-shop config free for a
    // fleet of one.
    mail: { from: 'shop@example.test' },

    // The other half of the File column — db.ts writes the bytes under here
    // and this serves them. Rooted at the storage directory rather than at a
    // `/storage` route because `apiPrefix` moves every route the app
    // registers, auth's and caravan's included, and an image URL that moves
    // when the prefix does is a URL already written into a database row.
    // Static is matched on the raw path and is not prefixed, so the leading
    // `storage/` in `keyPattern` is what puts the segment in the URL.
    http: {
      static: { root: STORAGE_ROOT, maxAge: 3600 },

      // The basket token, declared once. A caller-varied header has two
      // readers and neither is optional: cross-origin the CORS preflight
      // drops a header nobody allowed, and over the socket the frame's
      // headers are merged only for names the app named — a frame that could
      // state its own header could state Authorization. Undeclared, the shop
      // works exactly until the WebSocket connects, and then every basket
      // read answers 404.
      callHeaders: [CART_HEADER],

      // ── CORS, because of the widget ────────────────────────────────────
      //
      // Nothing needed this until `widgets/` existed. The SPA is served by
      // Vite, which PROXIES /api, so every call is same-origin and no
      // preflight ever happens; a buy button embedded on somebody else's page
      // calls this API from an origin the shop has never heard of.
      //
      // `*` is the right answer here and it is worth saying why, because it
      // reads like a mistake. **CORS is not an access control.** It stops a
      // page from READING a response the BROWSER attached credentials to — and
      // this app attaches none: there is no `cookieAuth: true` above, a Bearer
      // token is put on a request by code that already holds it, and a basket
      // is reached by an unguessable token in a header. So a hostile page
      // allowed through here gains exactly what it already had with `curl`, and
      // the list that would keep it out is a list of every customer's domain,
      // which no widget vendor can hold.
      //
      // The two things that would make `*` wrong are both absent and both worth
      // watching for: a cookie session (the browser would attach it unasked),
      // and `credentials: true` beside it (junction defaults to false).
      //
      // `callHeaders` above is merged into the allow-list by `cors()` itself —
      // one declaration, two readers — because a header absent from the
      // preflight never arrives and `x-cart-token` is how the widget's basket
      // is reached at all.
      cors: { origins: ['*'] },
    },
  },
})

app.configure(healthPlugin())

// ── The devtools console ──────────────────────────────────────────────────
//
//   DEVTOOLS=1 bun run api        →  http://localhost:8503
//
// The live call feed, /metrics with every plugin's contributed section,
// readiness, and the job queue — depth per queue, the stall age, every
// handler's schedule, and retry / cancel / run-now. Caravan's own `admin:`
// routes are mounted here too, but the console does not use them: it reads
// `app.jobs` directly, so it works whether or not an app published that
// surface.
//
// Opt-in rather than on in development, because 8503 is a GLOBAL tooling port
// (packages/cli/core/ports.js § the tooling block) — one console at a time, so
// running this beside basecamp's is a collision rather than two consoles.
// DEVTOOLS_PORT moves it for the case where somebody wants both.
//
// Safe to leave wired: the plugin refuses to bind under NODE_ENV=production
// with no auth gate rather than serving request params and a retry button to
// whoever finds the port. The startup banner says which it did.
if (process.env.DEVTOOLS === '1')
  app.configure(devtools({ port: Number(process.env.DEVTOOLS_PORT ?? 8503) }))

// GET /api/manifest — what this app IS, read off live runtime state: services,
// their methods and hooks, channels, plugins, and every route the router will
// answer. `fli api:routes` reads the last of those, which is the only way to
// ask a Junction app what it serves: the surface is emergent, so it cannot be
// read off the source. devOnly by default, so a production build 404s here.
app.configure(manifestPlugin({ db }))

// Mounts POST /api/auth/register, /api/auth/login, /api/auth/logout and the
// password-reset + email-verify routes — deliberately NOT services, because
// login cannot be gated by login — plus the three services for what the caller
// does to their own credentials afterwards: /api/account, /api/sessions,
// /api/api-keys.
//
// `level` is what makes GET /api/account/me answer this app's own grading. It
// is opt-in for a reason: the ladder is `api/gate.ts`, the same function
// GatePlugin grades every request with, and a default answer here would be a
// second mapping that disagrees with the real one near a gate boundary.
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
  services:       { level: shopGateLevel },
  cookieAuth:     COOKIE_AUTH,

  // ── Support mode ────────────────────────────────────────────────────────
  //
  // Absent, the routes refuse — so this is the whole of what turns it on, and
  // it is one shop's answer rather than the framework's. An admin may act as a
  // shopper to see what they see; nobody may act as another admin, because the
  // ceiling is the SUBJECT's standing and standing in for an admin grants
  // admin, which is the god mode this exists to replace.
  //
  // The subject is read through `asSystem()`: `User` reads at USER(4) and its
  // row policy is *your own row or staff*, so grading a subject with the
  // operator's own client would answer about the operator.
  canStartSupport: async (operator: { isAdmin?: boolean }, subjectId: string) => {
    if (operator?.isAdmin !== true) return false
    const subject = await db.asSystem().user.findUnique({ where: { id: subjectId } })
    return subject != null && subject.role !== 'admin'
  },
  // Only when the session can come back. The plugin refuses the pair outright
  // otherwise — a flow that completes and signs nobody in is the failure it
  // exists to prevent.
  ...(COOKIE_AUTH ? {
    oauth: {
      publicUrl:     process.env.SHOP_PUBLIC_URL ?? `http://localhost:${PORT}`,
      errorRedirect: '/sign-in',
    },
  } : {}),
}))

// ─── Deferred work ────────────────────────────────────────────────────────
//
// Caravan is a SQLite queue in its own file — nothing about it touches
// db/shop.db, so a wiped queue loses no shop data and a wiped shop loses no
// jobs. `app.configure` claims `app.jobs`; `boot()` starts the workers and
// autoloads `api/jobs/*.job.ts` — including the recurring one, which declares
// its own `cron` and therefore needs no line here.
//
// The queue's own settings — its database, its job directory, `admin: true` and
// the per-queue concurrencies — are DECLARED in api/config/junction.config.js.
// Caravan reads that block and an explicit option here would win over it, so a
// key belongs in exactly one of the two places.

const queue = createCaravan()

app.configure(queue)

// ─── The outbox ───────────────────────────────────────────────────────────
//
// `ctx.enqueue(job, payload)` writes its row inside the calling method's own
// transaction, and this relay hands it to the queue afterwards. Without it a
// crash between "the order is paid" committing and the announcement being
// queued loses the announcement with nothing recording that it was owed —
// which is the one thing `ctx.afterCommit(fn)` cannot buy (`FJS-D35`).
//
// AFTER the queue, because that is where the rows go: outbox() declares
// requires: ['caravan'] and startup refuses the other order by name.
//
// The interval is the recovery sweep, not the latency of an ordinary effect —
// a committed call kicks the relay immediately. It is how long a row a crash
// left behind waits, and one second keeps the drive's assertions quick.
app.configure(outbox({ intervalMs: 1_000 }))

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
// The address points at api/src/providers/mail/sink.ts — a dev mail catcher that speaks the
// provider's shape. Pointing this at api.resend.com is a change of `address`
// and `ref` here, and nothing else anywhere.

export const MAIL_SINK = process.env.MAIL_SINK_URL ?? `http://localhost:${process.env.MAIL_SINK_PORT ?? 8111}`

app.configure(conduit({
  targets: [{
    id:            MAIL_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       MAIL_SINK,
    auth:          { type: 'bearer', ref: 'SHOP_MAIL_KEY' },
    registered_at: Date.now(),
    last_seen_at:  null,
  }, {
    // The payment provider. `hmac` rather than `bearer`, which is the whole
    // difference between the two targets and is worth the line: a bearer token
    // is a value anybody holding it can present, and an HMAC binds the request
    // — method, path, a timestamp, a nonce and a hash of the body — so a
    // captured call cannot be replayed as a different one. The provider
    // VERIFIES it (api/src/providers/psp/sink.ts), which is what stops this being a
    // scheme that looks enforced and enforces nothing (FJS-349).
    //
    // Both sides run `@frontierjs/toolbelt/signature` and neither has an
    // implementation of its own.
    id:            PSP_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       PSP_URL,
    auth:          { type: 'hmac', ref: 'SHOP_PSP_KEY' },
    registered_at: Date.now(),
    last_seen_at:  null,
  },
  // Stripe. A REAL vendor beside this project's own conventions, and the two
  // disagree in every way a connector can: `form` bodies against JSON, a bearer
  // key against an HMAC, and a webhook signature scheme of Stripe's own rather
  // than `@frontierjs/toolbelt/signature`'s. That disagreement is the point —
  // one connector cannot show whether the boundary is generic (`FJS-D153`).
  //
  // The descriptor is built by the connector rather than spelled out here, which
  // is the shape it will keep when it becomes `@frontierjs/conduit-stripe`.
  stripeTarget()],
}))

// The env vars this app needs and does not otherwise default. Each sink
// accepts its dev value, so the example runs with no setup while every read is
// still a real credential lookup rather than a literal in a header.
//
// The two PSP secrets are separate on purpose: one is what the shop signs
// with, one is what the provider signs with. Sharing them would mean that
// leaking the key used to spend money also lets anybody forge an event saying
// money arrived.
process.env.SHOP_MAIL_KEY            ??= 'dev-mail-key'
process.env.SHOP_PSP_KEY             ??= 'dev-psp-key'
process.env.SHOP_PSP_WEBHOOK_SECRET  ??= 'dev-psp-webhook-secret'

// Stripe, and the same split for the same reason — `sk_…` is what the shop
// spends with, `whsec_…` is what Stripe signs events with, and they are issued
// separately at Stripe because one compromise must not be both directions.
//
// The defaults are the DEV SINK's, so the example runs with no Stripe account.
// Real keys go in `.env` (gitignored), and `STRIPE_URL` is the switch that
// matters: without it the connector still talks to api/src/providers/stripe/sink.ts
// on :8114 and the real key is never used.
//
//   STRIPE_URL=https://api.stripe.com
//   STRIPE_SECRET_KEY=sk_test_…
//   STRIPE_WEBHOOK_SECRET=whsec_…
//
// `whsec_…` is NOT on the API-keys screen — it belongs to an endpoint, and
// `stripe listen --forward-to localhost:8110/api/webhooks/stripe` prints the one
// for a local forward. The PUBLISHABLE key (`pk_…`) has no home here: it is a
// browser credential for Stripe.js, and this app collects no card details.
process.env.STRIPE_SECRET_KEY        ??= 'sk_test_dev'
process.env.STRIPE_WEBHOOK_SECRET    ??= 'whsec_dev'

// ─── Notifications ────────────────────────────────────────────────────────
//
// `app.notify(user, notification)`. The mailer must be configured FIRST — the
// plugin declares `requires: ['mailer']` when the email channel is on, and
// Junction checks that at startup against presence *and* configure order, so
// getting it wrong is a boot failure rather than a send failure an hour later.

app.configure(mailerPlugin(createConduitMailer(app, { from: 'shop@example.test' })))
// `notifications:` is DECLARED and not probed, for the same reason `autoload`
// above is: the probe is relative to the entry, and two drives import this
// module directly, which makes the drive file the entry. Probed, they would
// find no notifications, and an unnamed definition throws on first send.
app.configure(notificationsPlugin({
  db,
  notifications: new URL('./notifications', import.meta.url).pathname,
  transports:    { email: { mailer: 'default' } },
}))

// Which channels a connection joins is `core/channels.ts`. It is a decision
// and not a list: a channel nobody joined broadcasts into nothing, and a
// channel a connection joined hands it every row published there with no
// policy applied. Both halves are silent, so they are owned in one place.
app.configure(channels((a: App) => {
  a.channels!.on('connection', (session, conn) => joinChannels(a, session, conn))
}))

// ─── The provider talking back ────────────────────────────────────────────
//
// POST /api/webhooks/payments — the one route in this app that is not a
// service, and the reasons are the whole of what a webhook is.
//
//   no principal   a provider has no session and must not be able to name one.
//                  Everything else here is authenticated by the caller; this
//                  is authenticated by the BYTES, and the identity it
//                  establishes is "the provider", not "a user"
//   raw bytes      the signature covers a hash of what was sent. A service
//                  method is handed `ctx.data` after autoValidate has coerced
//                  it, and re-serializing that to check a hash means both ends
//                  have to agree about key order forever
//   its own status a service answers 4xx from the gate and the validator; a
//                  provider reads 2xx as "stop retrying" and everything else
//                  as "send it again", so what this answers is a decision and
//                  not a side effect of a pipeline
//
// What it does NOT do is any of the work. Verify, then hand the event to
// `payments.record`, which is an ordinary service method with a transaction, a
// ledger and the state machine behind it — so the effect is testable without a
// signature and the signature is testable without the effect.
//
// `app.post` puts this under `apiPrefix`, like every route the app registers.
// A path that must not move goes on `app.http.router` directly; this one is
// happy to move, because the provider is TOLD the URL and `verifyWebhook`
// verifies whatever path the request arrived at.
app.post(WEBHOOK_PATH, async (ctx) => {
  const check = await verifyWebhook({
    method:  ctx.method,
    path:    ctx.path,
    // The raw search string off the request URL, not `ctx.query` — that one is
    // parsed, and a signature is over what was sent (`FJS-678`).
    query:   new URL(ctx.$raw.url).search,
    headers: ctx.headers,
    rawBody: ctx.rawBody,
  })

  if (!check.ok) {
    // Logged with the reason, answered without it. A forger learns that it
    // failed; whoever is on call learns that the provider's clock is 40
    // seconds out, which is the same 401 and a completely different morning.
    console.warn(`[psp] refused a webhook — ${check.reason}`)
    return ctx.json({ error: 'invalid signature' }, 401)
  }

  // As the shop, on its own behalf. Both payment tables are SYSTEM-write by
  // declaration, and `record` reaches them through `asSystem()`; what this
  // principal buys is the audit actor and the order's own gate, which the
  // bypass would drop.
  const result = await app.service('payments')
    .call('record', null, (ctx.body ?? {}) as Record<string, unknown>, { auth: { user: SYSTEM } })

  return ctx.json(result as Record<string, unknown>, 200)
})

// ─── Stripe's events ──────────────────────────────────────────────────────
//
// The same shape as the route above and a different dialect. Stripe signs
// `"<timestamp>.<raw body>"` under `Stripe-Signature`; this project signs a
// canonical string over method, path, timestamp, nonce and a body hash. Neither
// is wrong and neither generalises, which is why a connector owns its vendor's
// (`FJS-D153`).
//
// `ctx.rawBody` and not `ctx.body`: the signature is over BYTES, and
// re-serializing the parsed object produces different ones for the same
// document — key order, whitespace, number formatting — so every legitimate
// event would be refused.
//
// What this deliberately does NOT do is drive the order state machine. The shop
// already has a provider doing that, and pointing two at one machine is a
// decision about which one is authoritative rather than a detail of wiring. The
// line where that would go is the `payments.record` call in the route above.
app.post(STRIPE_WEBHOOK_PATH, async (ctx) => {
  const check = verifyStripeSignature({
    rawBody: ctx.rawBody ?? '',
    header:  ctx.headers['stripe-signature'],
    secret:  process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dev',
    now:     Math.floor(Date.now() / 1000),
  })

  if (!check.ok) {
    // Logged with the reason, answered without it — a forger learns that it
    // failed, whoever is on call learns that Stripe's clock is 40s out.
    console.warn(`[stripe] refused a webhook — ${check.reason}`)
    return ctx.json({ error: 'invalid signature' }, 401)
  }

  const event = (ctx.body ?? {}) as { id?: string; type?: string }
  // Stripe retries until it gets a 2xx, so anything that is not a signature
  // failure answers 200 — including an event type this app does not handle.
  return ctx.json({ received: true, id: event.id, type: event.type }, 200)
})

// GET /api/session was here — a hand-written route that resolved the Bearer
// token itself and answered `{ level, email, role }`. It is GET /api/account/me
// now, with `services: { level: shopGateLevel }` above supplying exactly the
// half the framework could not answer for itself. The route had to re-resolve
// the token because it ran outside the service pipeline; the service is handed
// `ctx.auth.user` like everything else.

// ─── Serve ────────────────────────────────────────────────────────────────
//
// Exported unstarted. `api/index.ts` is what a runner is pointed at, and the
// only thing that binds a port or a listener.

// One default export and no named `app`: `junction surface` refuses a module
// exporting more than one candidate rather than guessing which is the app.
export default app
export { PORT }
