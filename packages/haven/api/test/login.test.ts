// api/test/login.test.ts
// The signed login: a key makes a member once and is that member every time
// after; the token it answers is a session on both transports; and a login the
// key did not sign — forged, tampered, replayed, stale — makes nothing. Each
// refusal sits beside a row count, since a 401 that still wrote a member would
// read the same from the response alone.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'
import { generateSigningKeys } from '@frontierjs/toolbelt/signature'

import { buildHavenApp } from '../src/app.ts'
import { createHavenAuth } from '../src/auth.ts'
import { signIn, signedLogin, postLogin } from './sign-in.ts'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const KEY    = 'test-session-key'

let env: any, sys: any

beforeEach(async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: KEY, port: 0 }),
  })
  sys = env.system
  await sys.room.create({ data: { slug: 'square', name: 'The square' } })
})

afterEach(async () => { await env?.close?.() })

const members  = async () => (await sys.member.findMany({ select: { nick: true } })).map((m: any) => m.nick)
const sessions = async () => (await sys.session.findMany({ select: { id: true } })).length

async function whoami (token: string): Promise<{ status: number, rows: any }> {
  const res = await fetch(`http://localhost:${env.port}/members`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, rows: await res.json().catch(() => null) }
}

describe('a key walks in', () => {
  test('the first login makes the member, and its token reads as them over HTTP', async () => {
    const sam = await signIn(env.port, 'Sam')
    expect(sam.nick).toBe('sam')
    expect(await members()).toEqual(['sam'])

    const seen = await whoami(sam.token)
    expect(seen.status).toBe(200)
    expect(JSON.stringify(seen.rows)).toContain('"nick":"sam"')
  })

  test('the same key later is the same member, with a new session and no nick needed', async () => {
    const first = await signIn(env.port, 'sam')
    const { status, json } = await postLogin(env.port, await signedLogin(first.keys, {}))
    expect(status).toBe(200)
    expect(json.member).toEqual({ id: first.id, nick: 'sam' })
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

  test('a nick already walking under another key is refused, and the key makes nothing', async () => {
    await signIn(env.port, 'sam')
    const other = await generateSigningKeys()
    const { status, json } = await postLogin(env.port, await signedLogin(other, { nick: 'SAM' }))
    expect(status).toBe(409)
    expect(json.message).toContain('taken')
    expect(await members()).toEqual(['sam'])
  })

  test('a first login with no nick is told to name one', async () => {
    const keys = await generateSigningKeys()
    const { status } = await postLogin(env.port, await signedLogin(keys, {}))
    expect(status).toBe(400)
    expect(await members()).toEqual([])
  })
})

describe('a login the key did not sign', () => {
  test('signed by another key, naming this one, makes nothing', async () => {
    const victim = await generateSigningKeys()
    const forger = await generateSigningKeys()
    const req = await signedLogin(forger, { nick: 'mallory' })
    const lie = { ...req, body: req.body.replace(forger.publicKey, victim.publicKey) }
    const { status, json } = await postLogin(env.port, lie)
    expect(status).toBe(401)
    expect(json.message).toContain('does not match')
    expect(await members()).toEqual([])
  })

  test('a body changed after signing is refused', async () => {
    const keys = await generateSigningKeys()
    const req  = await signedLogin(keys, { nick: 'sam' })
    const { status } = await postLogin(env.port, { ...req, body: req.body.replace('"sam"', '"ana"') })
    expect(status).toBe(401)
    expect(await members()).toEqual([])
  })

  test('replayed, the second is refused and mints no second session', async () => {
    const keys = await generateSigningKeys()
    const req  = await signedLogin(keys, { nick: 'sam' })
    expect((await postLogin(env.port, req)).status).toBe(200)
    const again = await postLogin(env.port, req)
    expect(again.status).toBe(401)
    expect(again.json.message).toContain('nonce')
    expect(await sessions()).toBe(1)
  })

  test('outside the window, and unsigned, are refused by name', async () => {
    const keys  = await generateSigningKeys()
    const stale = await postLogin(env.port, await signedLogin(keys, { nick: 'sam' }, Math.floor(Date.now() / 1000) - 3600))
    expect(stale.status).toBe(401)
    expect(stale.json.message).toContain('out')

    const res = await fetch(`http://localhost:${env.port}/haven/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: keys.publicKey, nick: 'sam' }),
    })
    expect(res.status).toBe(401)
    expect(await members()).toEqual([])
  })
})

describe('a session', () => {
  test('expired or revoked no longer reads as anyone', async () => {
    const auth = createHavenAuth(env.db, { key: KEY })
    const sam  = await signIn(env.port, 'sam')
    expect((await auth.verifySession(sam.token))?.userId).toBe(String(sam.id))

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
