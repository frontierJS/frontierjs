/**
 * A real Junction app for tests/client-seam.test.js — spawned as a bun
 * subprocess, because junction is Bun-only (Bun.serve is the transport) and
 * sierra's vitest runs under node.
 *
 * It is deliberately small and it is deliberately REAL. The defects this file
 * exists to grade (FJS-787, FJS-788, FJS-812) all survived a green suite whose
 * fixture was a hand-written junction client carrying the members the code under
 * test happened to call — including, in tests/session.test.js, a `hasCredential`
 * accessor with the `cookieAuth` term sierra never actually supplied.
 *
 * It states a `build`, so every response carries `x-fjs-build` and the client's
 * staleness comparison has something to compare against.
 *
 *   bun tests/fixtures/client-seam-server.ts [port]
 *
 * It prints READY <port> on stdout once it is listening.
 */

import { createApp } from '../../../junction/index.ts'

const port = Number(process.argv[2] ?? 7921)

/** Every request the client actually made, in order. Read back over /__hits. */
const hits: string[] = []

const app = createApp({
  config: {
    port,
    build:    'server-2',
    database: { url: '', log: false },
    services: { dir: '/nonexistent' },
  },
  logLevel: 'silent',
})

app.get('/ping', (ctx: any) => ctx.json({ ok: true }))

// What `client.auth.me()` resolves to — service('account').get('me').
app.get('/account/me', (ctx: any) => {
  hits.push('GET /account/me')
  return ctx.json({ userId: 'restored-person', email: 'p@x.test', level: 4 })
})

// What `client.auth.signOut()` calls, and the whole question of FJS-787's
// second half: in cookie mode this used never to be reached, while signOut
// still answered { revoked: true }.
app.post('/auth/logout', (ctx: any) => {
  hits.push('POST /auth/logout')
  return ctx.json({ ok: true })
})

app.get('/__hits', (ctx: any) => ctx.json(hits))
app.post('/__hits/reset', (ctx: any) => { hits.length = 0; return ctx.json({ ok: true }) })

await app.start()
console.log(`READY ${port}`)
