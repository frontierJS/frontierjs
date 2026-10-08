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
 *   bun test/fixtures/connect-app-server.ts <hostedPort> <pagePort>
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient }   from '../../../litestone/src/index.js'
import { createApp }      from '../../../junction/src/core/app.ts'
import { createService }  from '../../../junction/src/core/service.ts'
import { generateSchemas } from '../../src/build/schema-plugin.js'

const hostedPort = Number(process.argv[2] ?? 7926)
const pagePort   = Number(process.argv[3] ?? 7927)

const SCHEMA = `
model Customer {
  id     Int     @id
  email  String
  orders Order[]

  @@gate("4.4.4.6")
}

model Order {
  id         Int      @id
  total      Int
  customerId Int
  customer   Customer @relation(fields: [customerId], references: [id])

  @@gate("4.4.4.6")
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
    services: { dir: '/nonexistent' },
  },
  auth: {
    verifySession: async (token: string) => token === OWNER_TOKEN
      ? { userId: 'owner', userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x', isOwner: true }
      : null,
  },
  logLevel: 'silent',
} as any)
hosted.services.register(createService({ name: 'customers', model: 'Customer' } as any))
hosted.services.register(createService({ name: 'orders',    model: 'Order' } as any))
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

Bun.serve({
  port: pagePort,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/ping')   return Response.json({ ok: true })
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

    return Response.json({ error: 'this page has no such route' }, { status: 404 })
  },
})

console.log(`READY ${pagePort}`)
