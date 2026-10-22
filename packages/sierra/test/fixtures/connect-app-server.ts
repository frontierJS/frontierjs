/**
 * Two servers for test/connect-app.test.js — a HOSTED Junction app, and the
 * page's own API forwarding to it, spawned as a bun subprocess because junction
 * is Bun-only and sierra's vitest runs under node.
 *
 * The forward is the shape a studio runs: the browser sends the page's own
 * credential to `/hosted/h1/*`, the forward checks it, and the hosted app is
 * reached with the OWNER's token, which never leaves this process. It records
 * both credentials, so the test can say which one each hop carried.
 *
 * The hosted app's `Customer` is not the one the test registers for the page,
 * which is what makes "read from that app's schema" an assertion rather than a
 * coincidence.
 *
 * The forward carries the socket too: `/hosted/h1/ws` is upgraded with the
 * page's credential and bridged to the hosted app's `/ws` with the owner's.
 *
 *   bun test/fixtures/connect-app-server.ts <hostedPort> <pagePort> [siteDir]
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient }   from '../../../litestone/src/index.js'
import { createApp }      from '../../../junction/src/core/app.ts'
import { channels }       from '../../../junction/index.ts'
import { createService }  from '../../../junction/src/core/service.ts'
import { generateSchemas } from '../../src/build/schema-plugin.js'
import { WS_PROTOCOL, WS_BEARER, bearerFromProtocols } from '../../../junction/src/core/ws-auth.ts'

const hostedPort = Number(process.argv[2] ?? 7926)
const pagePort   = Number(process.argv[3] ?? 7927)
// Optional: a directory holding the browser drive's `index.html` and `page.js`,
// served from the page's origin so `connectApp()` accepts the forward.
const siteDir    = process.argv[4]

const SCHEMA = `
model Customer {
  id     Int     @id
  email  String
  orders Order[]

  @@gate(4.4.4.6)
}

model Order {
  id         Int      @id
  total      Int
  customerId Int
  customer   Customer @relation(fields: [customerId], references: [id])

  @@gate(4.4.4.6)
}
`

const PAGE_TOKEN  = 'studio-token'
const OWNER_TOKEN = 'owner-token'

// ─── The hosted app ──────────────────────────────────────────────────────────

const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as any
const sys = db.asSystem()
await sys.customer.create({ data: { id: 1, email: 'ada@hosted.test' } })
await sys.order.create({ data: { id: 10, total: 42, customerId: 1 } })

const hosted = createApp({
  db,
  config: {
    port: hostedPort,
    apiPrefix: '/api',
  },
  auth: {
    verifySession: async (token: string) => token === OWNER_TOKEN
      ? { id: 'owner', userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x', isOwner: true }
      : null,
  },
  logLevel: 'silent',
} as any)
hosted.services.register(createService({ name: 'customers', model: 'Customer', channel: 'hosted' } as any))
hosted.services.register(createService({ name: 'orders',    model: 'Order',    channel: 'hosted' } as any))
// The hosted app's `/ws`: every connection joins the one channel the services
// announce on.
hosted.configure(channels((a: any) => {
  a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel('hosted').join(conn) })
}))
await hosted.start()

// What `connectApp({ schema })` is handed — made here, on the server, for the
// hosted app's own `.lite`.
const dir = mkdtempSync(join(tmpdir(), 'connect-app-'))
writeFileSync(join(dir, 'schema.lite'), SCHEMA)
const generated = await generateSchemas(join(dir, 'schema.lite'), (m: string) => console.error(m), resolve(import.meta.dir, '../..'))
const { device: _device, ...schemaPayload } = generated ?? {}

// ─── The page's own API ──────────────────────────────────────────────────────

const seen: { path: string, from: string | null, forwarded: string | null }[] = []
const PREFIX = '/hosted/h1'

// The socket through the forward. The browser offers the PAGE's credential on
// the handshake; the hop to the hosted app offers the OWNER's, and what the
// page sent never crosses. Frames sent before the upstream is open wait for it.
type Bridge = { upstream: WebSocket, queue: (string | Buffer)[] }

Bun.serve<Bridge>({
  port: pagePort,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ping')   return Response.json({ ok: true })
    if (url.pathname === `${PREFIX}/ws`) {
      const from = bearerFromProtocols(req.headers.get('sec-websocket-protocol') ?? undefined)
      seen.push({ path: url.pathname, from: from && `Bearer ${from}`, forwarded: from === PAGE_TOKEN ? `Bearer ${OWNER_TOKEN}` : null })
      if (from !== PAGE_TOKEN) return Response.json({ error: 'not signed in to the studio' }, { status: 401 })
      const upstream = new WebSocket(`ws://127.0.0.1:${hostedPort}/ws${url.search}`, [WS_PROTOCOL, WS_BEARER + OWNER_TOKEN])
      const queue: (string | Buffer)[] = []
      return srv.upgrade(req, { data: { upstream, queue }, headers: { 'sec-websocket-protocol': WS_PROTOCOL } })
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    }
    // Another client writing to the hosted app, so a row arrives that this page
    // did not ask for — what a live store is for.
    if (url.pathname === '/__hosted-create') {
      const res = await fetch(`http://127.0.0.1:${hostedPort}/api/customers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` },
        body: JSON.stringify({ id: Number(url.searchParams.get('id')), email: url.searchParams.get('email') }),
      })
      return Response.json({ status: res.status })
    }
    if (url.pathname === '/__seen') return Response.json(seen)
    if (url.pathname === '/__seen/reset') { seen.length = 0; return Response.json({ ok: true }) }
    if (url.pathname === `${PREFIX}/__schema`) return Response.json(schemaPayload)

    if (url.pathname.startsWith(`${PREFIX}/`)) {
      const from = req.headers.get('authorization')
      if (from !== `Bearer ${PAGE_TOKEN}`) {
        seen.push({ path: url.pathname, from, forwarded: null })
        return Response.json({ error: 'not signed in to the studio' }, { status: 401 })
      }
      const headers = new Headers(req.headers)
      headers.set('authorization', `Bearer ${OWNER_TOKEN}`)
      headers.delete('host')
      const target = `http://127.0.0.1:${hostedPort}${url.pathname.slice(PREFIX.length)}${url.search}`
      seen.push({ path: url.pathname, from, forwarded: headers.get('authorization') })
      return fetch(target, {
        method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      })
    }

    if (siteDir && req.method === 'GET' && ['/', '/page.js'].includes(url.pathname)) {
      return new Response(Bun.file(join(siteDir, url.pathname === '/' ? 'index.html' : 'page.js')))
    }

    return Response.json({ error: 'this page has no such route' }, { status: 404 })
  },
  websocket: {
    open(ws) {
      const { upstream, queue } = ws.data
      upstream.onopen    = () => { for (const f of queue.splice(0)) upstream.send(f) }
      upstream.onmessage = (e) => ws.send(e.data)
      upstream.onclose   = () => ws.close()
    },
    message(ws, frame) {
      const { upstream, queue } = ws.data
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame)
      else queue.push(frame)
    },
    close(ws) { ws.data.upstream.close() },
  },
})

console.log(`READY ${pagePort}`)
