// api/test/login.test.ts
// The signed login: a member's chain makes a Haven member once and is that
// member every time after; the token it answers is a session on both
// transports; and a key in no chain, or a login the key did not sign —
// forged, tampered, replayed, stale — makes nothing. Each
// refusal sits beside a row count, since a 401 that still wrote a member would
// read the same from the response alone.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'
import { generateSigningKeys } from '@frontierjs/toolbelt/signature'

import { buildHavenApp } from '../src/app.ts'
import { createHavenAuth } from '../src/auth.ts'
import { CRIER } from '#shared/crier.ts'
import { POST_KEY, chainOf, member, signIn, signedLogin, postLogin } from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const KEY    = 'test-session-key'

let env: any, sys: any

// The list is read when the app is built, as `HAVEN_MODS` is: a test that
// changes it restarts the server.
let mods: string[] = []

async function start () {
  await env?.close?.()
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: KEY, port: 0, postKey: POST_KEY, mods }),
  })
  sys = env.system
  await sys.room.create({ data: { slug: 'square', name: 'The square' } })
}

beforeEach(async () => { mods = []; await start() })

afterEach(async () => { await env?.close?.() })

const members  = async () => (await sys.member.findMany({ where: { nick: { not: CRIER } }, select: { nick: true } })).map((m: any) => m.nick)
const sessions = async () => (await sys.session.findMany({ select: { id: true } })).length

async function whoami (token: string): Promise<{ status: number, rows: any }> {
  const res = await fetch(`http://localhost:${env.port}/members`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, rows: await res.json().catch(() => null) }
}

describe('a member walks in', () => {
  test('the first login makes the member, and its token reads as them over HTTP', async () => {
    const sam = await signIn(env.port, 'sam')
    expect(sam.nick).toBe('sam')
    expect(await members()).toEqual(['sam'])

    const seen = await whoami(sam.token)
    expect(seen.status).toBe(200)
    expect(JSON.stringify(seen.rows)).toContain('"nick":"sam"')
  })

  test('the same chain later is the same member, with a new session', async () => {
    const first = await signIn(env.port, 'sam')
    const { status, json } = await postLogin(env.port, await signedLogin(first.member.keys, chainOf(first.member)))
    expect(status).toBe(200)
    expect(json.member).toEqual({ id: first.id, nick: 'sam', role: null })
    expect(json.token).not.toBe(first.token)
    expect(await sessions()).toBe(2)
  })

  test('the token opens a socket as the member, and a dead one closes it', async () => {
    const sam = await signIn(env.port, 'sam')
    const ok  = new WebSocket(`ws://localhost:${env.port}/ws`, ['fjs', `fjs.bearer.${sam.token}`])
    const frames: any[] = []
    ok.onmessage = (e: any) => { try { frames.push(JSON.parse(String(e.data))) } catch {} }
    for (let i = 0; i < 200 && !frames.some(f => f.type === 'connection'); i++) await Bun.sleep(5)
    expect(frames.find(f => f.type === 'connection')).toBeTruthy()
    ok.close()

    const bad = new WebSocket(`ws://localhost:${env.port}/ws`, ['fjs', 'fjs.bearer.not-a-session'])
    const code = await new Promise<number>(r => { bad.onclose = (e: any) => r(e.code) })
    expect(code).toBe(4001)
  })

  test('a nick held here by another chain is refused, and the row makes nothing', async () => {
    await signIn(env.port, 'sam')
    const other = await member('sam')
    const { status, json } = await postLogin(env.port, await signedLogin(other.keys, chainOf(other)))
    expect(status).toBe(409)
    expect(json.message).toContain('held')
    expect(await members()).toEqual(['sam'])
  })

  test('the keyless voices cannot be walked in as, before their rows exist or after', async () => {
    for (const voice of ['crier', 'dice']) {
      const m = await member(voice)
      const { status, json } = await postLogin(env.port, await signedLogin(m.keys, chainOf(m)))
      expect(status).toBe(409)
      expect(json.message).toContain('held')
    }
  })

  test('a key in no chain is refused, naming how a machine joins', async () => {
    const keys = await generateSigningKeys()
    const { status, json } = await postLogin(env.port, await signedLogin(keys, { nick: 'sam' }))
    expect(status).toBe(401)
    expect(json.message).toContain('no Frontier chain')
    expect(await members()).toEqual([])
  })
})

describe('a mod', () => {
  const roleOf = async (nick: string) => (await sys.member.findFirst({ where: { nick }, select: { role: true } })).role

  test('is a nick the server lists, read at every login both ways', async () => {
    mods = ['Sam ', 'ana']
    await start()
    const sam = await signIn(env.port, 'sam')
    expect(sam.role).toBe('mod')
    expect(await roleOf('sam')).toBe('mod')
    expect((await signIn(env.port, 'rex')).role).toBeNull()

    // The list is the standing: struck from it, the next login is a member's.
    // The database outlives the restart, as it does across a deploy.
    const again = await buildHavenApp({ db: env.db, sessionKey: KEY, port: 0, postKey: POST_KEY, mods: ['ana'] })
    await (again as any)._startForTest()
    ;(again as any).http.start(0)
    try {
      const { json } = await postLogin((again as any).http.port, await signedLogin(sam.member.keys, chainOf(sam.member)))
      expect(json.member.role).toBeNull()
      expect(await roleOf('sam')).toBeNull()
    } finally { await (again as any).http.stop() }
  })

  test('is appointed by the list and by nothing a member can send', async () => {
    const rex = await signIn(env.port, 'rex')
    const res = await fetch(`http://localhost:${env.port}/members/${rex.id}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${rex.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'mod' }),
    })
    // `@guarded` is not in the client's schema, so the key is refused as unknown
    // before the column's own refusal is reached; either way nothing is written.
    expect([400, 403]).toContain(res.status)
    expect(await roleOf('rex')).toBeNull()
  })
})

describe('a login the key did not sign', () => {
  test('signed by another key, naming this one, makes nothing', async () => {
    const victim = await generateSigningKeys()
    const forger = await member('mallory')
    const req = await signedLogin(forger.keys, chainOf(forger))
    const lie = { ...req, body: req.body.replace(forger.keys.publicKey, victim.publicKey) }
    const { status, json } = await postLogin(env.port, lie)
    expect(status).toBe(401)
    expect(json.message).toContain('does not match')
    expect(await members()).toEqual([])
  })

  test('a body changed after signing is refused', async () => {
    const sam = await member('sam')
    const req = await signedLogin(sam.keys, chainOf(sam))
    const { status } = await postLogin(env.port, { ...req, body: req.body.replace('"sam"', '"ana"') })
    expect(status).toBe(401)
    expect(await members()).toEqual([])
  })

  test('replayed, the second is refused and mints no second session', async () => {
    const sam = await member('sam')
    const req = await signedLogin(sam.keys, chainOf(sam))
    expect((await postLogin(env.port, req)).status).toBe(200)
    const again = await postLogin(env.port, req)
    expect(again.status).toBe(401)
    expect(again.json.message).toContain('nonce')
    expect(await sessions()).toBe(1)
  })

  test('outside the window, and unsigned, are refused by name', async () => {
    const sam   = await member('sam')
    const stale = await postLogin(env.port, await signedLogin(sam.keys, chainOf(sam), Math.floor(Date.now() / 1000) - 3600))
    expect(stale.status).toBe(401)
    expect(stale.json.message).toContain('out')

    const res = await fetch(`http://localhost:${env.port}/haven/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: sam.keys.publicKey, ...chainOf(sam) }),
    })
    expect(res.status).toBe(401)
    expect(await members()).toEqual([])
  })
})

describe('a session', () => {
  test('expired or revoked no longer reads as anyone', async () => {
    const auth = createHavenAuth(env.db, { key: KEY })
    const sam  = await signIn(env.port, 'sam')
    expect((await auth.verifySession(sam.token))?.id).toBe(String(sam.id))

    await auth.logout(sam.token)
    expect(await auth.verifySession(sam.token)).toBeNull()
    expect((await whoami(sam.token)).status).toBe(401)

    const { token } = await auth.mint(sam.id)
    await sys.session.updateMany({ where: { revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } })
    expect(await auth.verifySession(token)).toBeNull()
  })

  test('the token is stored only as its digest', async () => {
    const sam = await signIn(env.port, 'sam')
    const row = await sys.session.findFirst({ where: { memberId: sam.id } })
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.tokenHash).not.toBe(sam.token)
  })
})
