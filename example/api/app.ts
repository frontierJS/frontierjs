// api/app.ts — the API realm.
//
//   bun run api        → http://localhost:3600
//
// Read db.ts first (the client and the gate), then gate.ts (how a session
// becomes a number). This file only assembles them.

import {
  createApp, channels, healthPlugin,
  type App,
} from '@frontierjs/junction'

import { createLitestoneAuth, createAuthPlugin } from '@frontierjs/auth'

import { db, DEV_KEY }  from './db.ts'
import { shopGateLevel } from './gate.ts'
import { seed, DEMO }    from './seed.ts'

const PORT = 3600

// ─── Auth ─────────────────────────────────────────────────────────────────
//
// Real auth, not a Map of tokens: password hashing, sessions with expiry,
// password reset and email verification are all in the package. What is NOT
// wired here is the mail side — onPasswordResetRequested / onEmailVerification
// Requested are where a mailer would go, and phase 2 hangs @frontierjs/conduit
// off exactly those two callbacks.

const auth = createLitestoneAuth(db, {
  encryptionKey: process.env.ENCRYPTION_KEY ?? DEV_KEY,
})

await seed(auth)

// ─── App ──────────────────────────────────────────────────────────────────

const app = createApp({
  db,
  auth,
  config: { name: 'shop', port: PORT, apiPrefix: '/api' },
})

app.configure(healthPlugin())

// Mounts POST /auth/register, /auth/login, /auth/logout, GET /auth/me and the
// password-reset + email-verify routes. Deliberately NOT services: login cannot
// be gated by login.
app.configure(createAuthPlugin(auth))

app.configure(channels((a: App) => {
  a.channels!.on('connection', (_session, conn) => {
    for (const name of ['orders', 'products', 'customers']) a.channel!(name).join(conn)
  })
}))

// ─── GET /session ─────────────────────────────────────────────────────────
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

await app.start()

console.log(`
  ─────────────────────────────────────────────────────────────
    API   http://localhost:${PORT}/api/orders
    UI    bun run dev        → http://localhost:5274

    Sign in as:
      user   ${DEMO.user.email}  / ${DEMO.user.password}     → level 4
      admin  ${DEMO.admin.email} / ${DEMO.admin.password}    → level 5

    curl http://localhost:${PORT}/api/orders                  # 200, public read
    curl -X POST http://localhost:${PORT}/api/orders \\
         -H 'content-type: application/json' -d '{}'          # 401, @@gate
  ─────────────────────────────────────────────────────────────
`)
