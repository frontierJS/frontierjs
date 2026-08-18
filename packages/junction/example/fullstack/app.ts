// example/fullstack/app.ts
//
// The whole road, end to end, in one runnable process:
//
//   db/schema.lite  →  Litestone client  →  autoloaded service  →  HTTP + WS
//                                                              →  browser Resource
//
//   bun run example/fullstack/app.ts
//   open http://localhost:3400
//
// Read the three files in this order — each is short, and each one is short
// BECAUSE of the one before it:
//
//   db/schema.lite                the seed: table, gate, field rules
//   services/posts.service.ts     the service: createBaseService({})
//   public/index.html             the Resource: client.resource('posts')
//
// This file is the only place with any wiring in it, and most of that wiring
// is the demo scaffolding (seed data, a fake login, bundling the browser
// client) rather than the framework.

import { readFileSync } from 'node:fs'
import { join }         from 'node:path'

import {
  createApp, channels, healthPlugin, sessionGateLevel,
  type App, type IAuth,
} from '../../index.ts'

// The WORKSPACE Litestone (1.0.6), not the published 1.0.3 that junction's
// package.json pins for its own internals. See README — this example exists
// partly to keep that seam honest.
import { createClient, autoMigrate, GatePlugin } from '../../../litestone/src/index.js'

// The schema's own types, generated from the file below and committed beside it:
//
//   bun ../../../litestone/src/tools/cli.js types --schema db/schema.lite \
//     --audience client --augment junction --out db/schema.d.ts
//
// Type-only, so nothing is imported at runtime — and the augmentation the same
// file carries is what types `client.service('posts')` in the browser with no
// word of its own there.
//
// One file for both ends only because nothing in this schema is `@guarded` or
// `@secret`. Where something is, the two audiences differ and an app generates
// twice — the system row for the API, the client row for the browser, which is
// what `fli new` writes into a scaffolded app's `db:types`.
import type { LitestoneClient as Db } from './db/schema.js'

const HERE = import.meta.dir
const PORT = 3400

// ─── 1. Data ──────────────────────────────────────────────────────────────
// The .lite file is read, not restated. autoMigrate() syncs the SQLite file to
// it and is idempotent, so a restart is free.

const db = await createClient<Db>({
  db:     ':memory:',
  schema: readFileSync(join(HERE, 'db/schema.lite'), 'utf8'),

  // @@gate grades the caller through this. Litestone owns the 0–7 scale;
  // sessionGateLevel is Junction's mapping of ITS user shape onto it, because
  // Litestone's default grades a different shape and reads a Junction session
  // as VISITOR(1) — see README, "the seam".
  plugins: [new GatePlugin({ getLevel: sessionGateLevel })],
})

autoMigrate(db)

// asSystem() bypasses the gate — the one legitimate use is seeding. `db` is the
// generated client, so `post` is the model's own accessor and the rows below are
// checked against PostCreate rather than asserted past a hand-written shape.
if (await db.asSystem().post.count() === 0) {
  await db.asSystem().post.createMany({
    data: [
      { title: 'Hello Junction',  body: 'Created by the seed.', published: true },
      { title: 'The second post', body: null,                   published: false },
    ],
  })
}

// ─── 2. Auth ──────────────────────────────────────────────────────────────
// Deliberately the dumbest thing that can work: the point is that @@gate("0.4.4.5")
// makes reads public and writes authenticated with no service-level declaration.
// Real apps use @frontierjs/auth.

const sessions = new Map<string, { userId: string }>()

const auth = {
  async verifySession(token: string) {
    const s = sessions.get(token)
    if (!s) return null

    return {
      userId: s.userId, userType: 'user', role: 'user', authMethod: 'session' as const,

      // The only standing this demo declares. sessionGateLevel() grades an
      // authenticated session as USER (4) on its own, which covers read and
      // create; @@gate("0.4.4.5") wants 5 to DELETE, and this is what lifts
      // the session to ADMINISTRATOR so the page's delete button works.
      //
      // Nothing else is needed. This used to also carry verifiedAt and
      // activatedAt purely to satisfy Litestone's default resolver, which
      // grades a shape Junction does not produce — see the README.
      isAdmin: true,
    }
  },
} as unknown as IAuth

// ─── 3. API ───────────────────────────────────────────────────────────────
// createApp({ db }) installs per-request Litestone scoping, so the gate and any
// row policies see the calling user. services/ next to this file is autoloaded.

const app = createApp({
  db,
  auth,
  config: { name: 'fullstack', port: PORT, apiPrefix: '/api' },
})

app.configure(healthPlugin())

// Every connection joins the 'posts' channel.
app.configure(channels((a: App) => {
  // Block body, not a concise one: Channel.join() returns the channel for
  // chaining, and the connection handler is typed to return void.
  a.channels!.on('connection', (_session, conn) => { a.channel!('posts').join(conn) })
}))

// Nothing here. Broadcasting is declared on the service itself — see
// services/posts.service.ts, `channel: 'posts'`. This used to be:
//
//   const live = publish(() => app.channel!('posts'))
//   app.hooks({ after: { create: [live], patch: [live], remove: [live] } })
//
// with the per-method list mandatory, because `after: { all }` would have
// broadcast every read to every connected browser.

// ─── 4. Demo login ────────────────────────────────────────────────────────

app.post('/login', async ctx => {
  const token = crypto.randomUUID()
  sessions.set(token, { userId: 'demo@example.com' })
  return ctx.json({ token })
})

// ─── 5. The browser Resource ──────────────────────────────────────────────
// The Junction browser client is TypeScript, so it is bundled on boot and
// served at /client.js. In a real app Sierra's build does this for you and you
// import '@frontierjs/junction/client' directly.

const bundle = await Bun.build({
  entrypoints: [join(HERE, '../../src/client/index.ts')],
  target:      'browser',
  format:      'esm',
  minify:      false,
})

if (!bundle.success) {
  console.error('client bundle failed:', bundle.logs)
  process.exit(1)
}

const clientJs = await bundle.outputs[0]!.text()

app.get('/client.js', async ctx =>
  new Response(clientJs, { headers: { 'content-type': 'text/javascript' } }))

// ctx.file() for a single file. (serveStatic() is the directory-tree version
// and takes a raw Request, which lives at ctx.$raw.$req — two levels of $,
// worth knowing before you go looking for ctx.req.)
app.get('/', async ctx => ctx.file(join(HERE, 'public/index.html')))

await app.start()

console.log(`
  ─────────────────────────────────────────────
    open  http://localhost:${PORT}

    curl  http://localhost:${PORT}/api/posts
    curl -X POST http://localhost:${PORT}/api/posts \\
         -H 'content-type: application/json' \\
         -d '{"title":"From curl"}'          # 401 — @@gate says writes need a user
  ─────────────────────────────────────────────
`)
