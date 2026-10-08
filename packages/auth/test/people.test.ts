// test/people.test.ts
//
// `people` — an operator reading and ending OTHER people's sessions and API
// keys, and inviting somebody, over a REAL Junction app graded by its own
// `level`.
//
// Every refusal is PAIRED with the same call succeeding for a caller who may,
// and every refusal re-reads what it could have changed: a service that
// refused everybody satisfies each refusal row, and one that answered 403
// having already signed the person out is the failure this exists to catch.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, request } from '@frontierjs/junction'
import { mcpPlugin } from '../../mcp/src/plugin.ts'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

const PW = 'pw-people-1'

const levelOf = (s: { role?: string }) => s.role === 'sysadmin' ? 7 : s.role === 'admin' ? 5 : 4

let h: Harness
let app: any
let base: string
let seq = 0

const rateLimits = {
  loginRateLimit:    { max: 10_000, window: '15 minutes' },
  registerRateLimit: { max: 10_000, window: '15 minutes' },
}

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY, sessionFields: (u: any) => ({ role: u.role, isAdmin: u.role === 'admin' || u.role === 'sysadmin' }) })
  app = createApp({
    db: h.db, auth: h.auth as any,
    config: { port: 0, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  } as never)
  app.configure(createAuthPlugin(h.auth, { ...rateLimits, services: { level: levelOf } }))
  app.configure(mcpPlugin({ name: 'people' }))
  const warn = console.warn
  console.warn = () => {}
  await app.start()
  console.warn = warn
  base = `http://localhost:${app.http.port}`
})
afterAll(async () => { await app.stop?.(); h.cleanup() })

async function person(role = 'user') {
  const email = `ppl-${Date.now()}-${seq++}@example.com`
  const { userId } = await h.auth.createUser({ email, password: PW, role })
  const { token } = await h.auth.login(email, PW) as any
  return { email, userId, token }
}

const get  = (as: string | null, userId: string) => {
  const r = fetch(`${base}/people/${userId}`, { headers: as ? { authorization: `Bearer ${as}` } : {} })
  return r
}
const act = (as: string | null, path: string, method: string, data: unknown = {}) =>
  fetch(`${base}/people${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-method': method, ...(as ? { authorization: `Bearer ${as}` } : {}) },
    body: JSON.stringify(data),
  })

describe('an administrator reads another person', () => {
  test('their sessions and keys come back, and an ordinary user is refused the same call', async () => {
    const admin = await person('admin')
    const u = await person()
    await h.auth.createApiKey(u.userId, { name: 'laptop' })

    const ok = await get(admin.token, u.userId)
    expect(ok.status).toBe(200)
    const body = await ok.json() as any
    expect(body.sessions).toHaveLength(1)
    expect(body.apiKeys.map((k: any) => k.name)).toEqual(['laptop'])
    expect(JSON.stringify(body)).not.toContain(u.token)

    expect((await get(u.token, admin.userId)).status).toBe(403)
    expect((await get(null, u.userId)).status).toBe(401)
  })

  test('their own account is not read from here, and a stranger id is a 404', async () => {
    const admin = await person('admin')
    expect((await get(admin.token, admin.userId)).status).toBe(403)
    expect((await get(admin.token, 'nobody')).status).toBe(404)
  })
})

describe('an administrator ends another person\'s access', () => {
  test('one session goes, the others stay', async () => {
    const admin = await person('admin')
    const u = await person()
    const second = (await h.auth.login(u.email, PW) as any).token
    const [a, b] = ((await h.auth.listSessions!(u.userId)) as any[]).map(s => s.id)

    const res = await act(admin.token, `/${u.userId}`, 'revokeSession', { sessionId: a })
    expect(res.status).toBe(200)
    const left = ((await h.auth.listSessions!(u.userId)) as any[]).map(s => s.id)
    expect(left).toEqual([b])
    expect(second.length).toBeGreaterThan(0)
  })

  test('signOut ends every session of theirs and none of the operator\'s', async () => {
    const admin = await person('admin')
    const u = await person()
    await h.auth.login(u.email, PW)

    const res = await act(admin.token, `/${u.userId}`, 'signOut')
    expect(res.status).toBe(200)
    expect((await res.json() as any).revoked).toBe(2)
    expect((await h.auth.listSessions!(u.userId)) as any[]).toHaveLength(0)
    expect((await h.auth.listSessions!(admin.userId)) as any[]).toHaveLength(1)
    expect((await request(app).get('/account/me').auth(u.token)).status).toBe(401)
  })

  test('a key is revoked and no longer authenticates', async () => {
    const admin = await person('admin')
    const u = await person()
    const { id, key } = await h.auth.createApiKey(u.userId, { name: 'ci' })
    expect((await request(app).get('/account/me').auth(key)).status).toBe(200)

    const res = await act(admin.token, `/${u.userId}`, 'revokeApiKey', { keyId: id })
    expect(res.status).toBe(200)
    expect((await request(app).get('/account/me').auth(key)).status).toBe(401)
  })

  test('a key id from a different person revokes nothing', async () => {
    const admin = await person('admin')
    const u = await person()
    const other = await person()
    const { id, key } = await h.auth.createApiKey(other.userId, { name: 'theirs' })

    const res = await act(admin.token, `/${u.userId}`, 'revokeApiKey', { keyId: id })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await request(app).get('/account/me').auth(key)).status).toBe(200)
  })

  test('the audit trail names the operator as actor, for a session, a key and an invitation', async () => {
    const admin = await person('admin')
    const u = await person()
    const [{ id: sessionId }] = (await h.auth.listSessions!(u.userId)) as any[]
    const { id: keyId } = await h.auth.createApiKey(u.userId, { name: 'trail' })
    const before = (await h.sys.auditLogs.findMany({})).length

    await act(admin.token, `/${u.userId}`, 'revokeSession', { sessionId })
    await act(admin.token, `/${u.userId}`, 'revokeApiKey', { keyId })
    await act(admin.token, '', 'invite', { email: `trail-${Date.now()}@example.com` })

    const rows = (await h.sys.auditLogs.findMany({})).slice(before)
    for (const op of ['session.revoked', 'apikey.revoked', 'invitation.created']) {
      const row = rows.find((r: any) => r.operation === op)
      expect(row?.actorId).toBe(admin.userId)
    }
  })

  test('an ordinary user is refused, and the person is still signed in', async () => {
    const u = await person()
    const v = await person()
    const res = await act(u.token, `/${v.userId}`, 'signOut')
    expect(res.status).toBe(403)
    expect((await h.auth.listSessions!(v.userId)) as any[]).toHaveLength(1)
  })

  test('an administrator cannot sign out a peer, a sysadmin can', async () => {
    const admin = await person('admin')
    const peer = await person('admin')
    const sys = await person('sysadmin')

    const refused = await act(admin.token, `/${peer.userId}`, 'signOut')
    expect(refused.status).toBe(403)
    expect((await h.auth.listSessions!(peer.userId)) as any[]).toHaveLength(1)

    const ok = await act(sys.token, `/${peer.userId}`, 'signOut')
    expect(ok.status).toBe(200)
    expect((await h.auth.listSessions!(peer.userId)) as any[]).toHaveLength(0)
  })
})

describe('an administrator removes somebody', () => {
  test('the account, its password and its sessions go; the audit trail names the operator', async () => {
    const admin = await person('admin')
    const u = await person()
    await h.auth.createApiKey(u.userId, { name: 'gone' })
    const before = (await h.sys.auditLogs.findMany({})).length

    const res = await request(app).delete(`/people/${u.userId}`).auth(admin.token)
    expect(res.status).toBe(200)

    expect(await h.sys.user.findFirst({ where: { id: u.userId } })).toBeNull()
    expect(await h.sys.credential.findMany({ where: { userId: u.userId } })).toHaveLength(0)
    expect(await h.sys.session.findMany({ where: { userId: u.userId } })).toHaveLength(0)
    const row = (await h.sys.auditLogs.findMany({})).slice(before).find((r: any) => r.operation === 'user.removed')
    expect(row?.actorId).toBe(admin.userId)
  })

  test('an ordinary user, and the operator themselves, are refused; the person stays', async () => {
    const admin = await person('admin')
    const u = await person()
    const v = await person()
    expect((await request(app).delete(`/people/${v.userId}`).auth(u.token)).status).toBe(403)
    expect((await request(app).delete(`/people/${admin.userId}`).auth(admin.token)).status).toBe(403)
    expect(await h.sys.user.findFirst({ where: { id: v.userId } })).not.toBeNull()
    expect(await h.sys.user.findFirst({ where: { id: admin.userId } })).not.toBeNull()
  })
})

describe('an administrator invites somebody', () => {
  test('the account has no way in until the token sets a password', async () => {
    const admin = await person('admin')
    const email = `invited-${Date.now()}@example.com`

    const res = await act(admin.token, '', 'invite', { email, name: 'Ada' })
    expect(res.status).toBe(200)
    const { userId, token, expiresAt } = await res.json() as any
    expect(token.length).toBeGreaterThan(10)
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())

    const row = await h.sys.user.findFirst({ where: { id: userId } })
    expect(row.role).toBe('user')
    expect(row.name).toBe('Ada')
    await expect(h.auth.login(email, PW)).rejects.toBeDefined()

    await h.auth.confirmPasswordReset!(token, PW)
    expect('token' in (await h.auth.login(email, PW) as any)).toBe(true)
  })

  test('a taken address is refused and the existing person is untouched', async () => {
    const admin = await person('admin')
    const u = await person()
    const res = await act(admin.token, '', 'invite', { email: u.email })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await h.auth.login(u.email, PW) as any).token).toBeTruthy()
  })

  test('not an address, and not an ordinary user', async () => {
    const admin = await person('admin')
    const u = await person()
    expect((await act(admin.token, '', 'invite', { email: 'nope' })).status).toBe(400)
    expect((await act(u.token, '', 'invite', { email: `x-${Date.now()}@example.com` })).status).toBe(403)
  })
})

describe('over /mcp', () => {
  async function mcp(token: string, name: string, args: Record<string, unknown>) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    return await res.json() as any
  }

  test('an agent reads, and is refused every write', async () => {
    const admin = await person('admin')
    const u = await person()
    const { key } = await h.auth.createApiKey(admin.userId, { name: 'agent' })

    const read = await mcp(key, 'people_get', { id: u.userId })
    expect(read.result?.isError).not.toBe(true)

    const out = await mcp(key, 'people_signOut', { id: u.userId })
    expect(out.result?.isError).toBe(true)
    expect(JSON.stringify(out)).toContain('agent')
    expect((await h.auth.listSessions!(u.userId)) as any[]).toHaveLength(1)

    const inv = await mcp(key, 'people_invite', { email: `agent-${Date.now()}@example.com` })
    expect(inv.result?.isError).toBe(true)

    const rm = await mcp(key, 'people_remove', { id: u.userId })
    expect(rm.result?.isError).toBe(true)
    expect(await h.sys.user.findFirst({ where: { id: u.userId } })).not.toBeNull()
  })
})
