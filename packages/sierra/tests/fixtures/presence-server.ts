/**
 * A real Junction app with presence turned on, for tests/presence.test.js —
 * spawned as a bun subprocess, because junction is Bun-only and sierra's vitest
 * runs under node.
 *
 * It is deliberately REAL. `@frontierjs/sierra/presence` spoke to a junction
 * client that has never existed — `client.send()`, `client.connectionId`, and
 * five channel-suffixed event names junction does not emit — and the module's
 * own test invented every one of them, so the suite was a conversation with
 * itself and the published subpath threw on its first line for its whole life
 * (`FJS-811`).
 *
 * Membership is the APP's: `channels()` joins every connection to ROOM and to
 * nothing else, so a second channel name is the negative control for anything
 * that claims a roster.
 *
 *   bun tests/fixtures/presence-server.ts [port]
 *
 * It prints READY <port> on stdout once it is listening.
 */

import { createApp, channels, defaultConfig } from '../../../junction/index.ts'

const port = Number(process.argv[2] ?? 7924)

const USERS: Record<string, { userId: string; userType: string; authMethod: 'session' }> = {
  'tok-alice': { userId: 'alice', userType: 'user', authMethod: 'session' },
  'tok-bob':   { userId: 'bob',   userType: 'user', authMethod: 'session' },
}

const app: any = createApp({
  config: {
    port,
    database: { url: '', log: false },
    services: { dir: '/nonexistent' },
    http: { ...defaultConfig.http, drainTimeout: 250 },
  },
  logLevel: 'silent',
  auth: {
    async verifySession(t: string) { return USERS[t] ?? null },
    async login()      { return { token: '', user: null as never } },
    async logout()     {},
    async createUser() { return {} as never },
    async deleteUser() {},
    async createApiKey(id: string) { return { key: `k-${id}`, id: `k-${id}` } },
    async revokeApiKey() {},
    async verifyApiKey() { return null },
  },
})

app.get('/ping', (ctx: any) => ctx.json({ ok: true }))

// `presenceFlushMs: 0` sends a frame per event rather than one per window — a
// supported mode, and the one a test can wait on without sleeping through a
// batch window it did not choose.
app.configure(channels((a: any) => {
  a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel('room:a').join(conn) })
}, { presence: true, presenceFlushMs: 0 }))

await app.start()
console.log(`READY ${port}`)
