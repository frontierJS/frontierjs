// cases.mjs — junction's REPORTED tier: what a request costs over a raw handler.
// `bun bench/cases.mjs` runs one round; scripts/bench-round.mjs is the loop.
//
// Each request goes through `app.http.fetch`, the function Bun.serve calls, and
// its FLOOR is a hand-written fetch handler answering the same request with the
// same statement on the same database handle — what an app without junction
// would write. No socket is opened on either side: loopback costs both the same
// and would only dilute the ratio, and its noise is the machine's, not ours.
// Both sides read the body, so serializing the answer is counted.
//
// The run side includes litestone's client, since a request pays for it; its
// own cost over bun:sqlite is litestone's bench/cases.mjs.
//
// The base ref runs THIS file, not its own (scripts/bench-ab.mjs), so an edit
// here that needs a new app API reads as the base failing, and the runner
// says so rather than comparing nothing.

import { createClient }  from '../../litestone/src/index.js'
import { createApp, createService, defaultConfig } from '../index.ts'
import { main }          from '../../../scripts/bench-round.mjs'

const ROWS = 1_000
const BASE = 'http://localhost'

async function served() {
  const db = await createClient({
    schema: 'model Item { id Int @id; name String; qty Int }',
    db: ':memory:',
  })
  await db.asSystem().item.createMany({ data: Array.from({ length: ROWS }, (_, i) => ({ name: `i${i}`, qty: i % 50 })) })
  const app = createApp({
    db,
    config: {
      port: 0, services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 50 },
    },
  })
  app.services.register(createService({ name: 'items', model: 'Item' }))
  app.get('/ping', ctx => ctx.json({ ok: true }))
  await app.start()
  const sql = db.$rawDbs.main
  return { app, sql, close: async () => { await app.stop(); db.$close() } }
}

// A refused request answers sooner than a served one, so a case whose route
// broke would read as faster. Every answer must be a success.
async function call(handler, req) {
  const res = await handler(req)
  if (!res.ok) throw new Error(`${req.method} ${new URL(req.url).pathname} answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.text()
}

export const cases = [
  {
    name: 'route-raw', ceiling: 15, ops: 8_000,
    open: served,
    run:   ({ app }) => call(r => app.http.fetch(r), new Request(`${BASE}/ping`)),
    floor: ()        => call(() => Response.json({ ok: true }), new Request(`${BASE}/ping`)),
  },
  {
    name: 'get-1', ceiling: 30, ops: 3_000,
    async open() {
      const s = await served()
      const one = s.sql.query('SELECT id, name, qty FROM item WHERE id = ?')
      s.handler = req => {
        const id  = Number(new URL(req.url).pathname.split('/')[2])
        const row = one.get(id)
        return row ? Response.json(row) : new Response(null, { status: 404 })
      }
      return s
    },
    run:   ({ app }, i)     => call(r => app.http.fetch(r), new Request(`${BASE}/items/${(i % ROWS) + 1}`)),
    floor: ({ handler }, i) => call(handler, new Request(`${BASE}/items/${(i % ROWS) + 1}`)),
  },
  {
    name: 'find-100', ceiling: 10, ops: 800,
    async open() {
      const s = await served()
      const page = s.sql.query('SELECT id, name, qty FROM item WHERE qty >= ? LIMIT ?')
      s.handler = req => {
        const q = new URL(req.url).searchParams
        return Response.json({ data: page.all(Number(q.get('qty')), Number(q.get('limit'))) })
      }
      return s
    },
    run:   ({ app })     => call(r => app.http.fetch(r), new Request(`${BASE}/items?qty[gte]=25&$limit=100`)),
    floor: ({ handler }) => call(handler, new Request(`${BASE}/items?qty=25&limit=100`)),
  },
  {
    name: 'create-1', ceiling: 35, ops: 2_000,
    async open() {
      const s = await served()
      const insert = s.sql.query('INSERT INTO item (name, qty) VALUES (?, ?) RETURNING id, name, qty')
      s.handler = async req => {
        const { name, qty } = await req.json()
        return Response.json(insert.get(name, qty), { status: 201 })
      }
      return s
    },
    run:   ({ app })     => call(r => app.http.fetch(r), post()),
    floor: ({ handler }) => call(handler, post()),
  },
]

function post() {
  return new Request(`${BASE}/items`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', qty: 1 }),
  })
}

if (import.meta.main) await main(cases)
