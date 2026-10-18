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
import { mcp as mcpPlugin } from '../../mcp/src/plugin.ts'
import { auth } from '../plugin.ts'
import { makeAuth, rejectsWith, type Harness, TEST_KEY } from './harness.ts'
import { AuthConfigError } from '../errors.ts'

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
    config: { port: 0 },
    logLevel: 'silent',
  } as never)
  app.configure(auth({ auth: h.auth, ...rateLimits, services: { level: levelOf } }))
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
    const before = (await h.sys.auditTrail.findMany({})).length

    await act(admin.token, `/${u.userId}`, 'revokeSession', { sessionId })
    await act(admin.token, `/${u.userId}`, 'revokeApiKey', { keyId })
    await act(admin.token, '', 'invite', { email: `trail-${Date.now()}@example.com` })

    const rows = (await h.sys.auditTrail.findMany({})).slice(before)
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
    const before = (await h.sys.auditTrail.findMany({})).length

    const res = await request(app).delete(`/people/${u.userId}`).auth(admin.token)
    expect(res.status).toBe(200)

    expect(await h.sys.user.findFirst({ where: { id: u.userId } })).toBeNull()
    expect(await h.sys.credential.findMany({ where: { userId: u.userId } })).toHaveLength(0)
    expect(await h.sys.session.findMany({ where: { userId: u.userId } })).toHaveLength(0)
    const row = (await h.sys.auditTrail.findMany({})).slice(before).find((r: any) => r.operation === 'user.removed')
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

// FJS-2643, FJS-D1116. `sessionFor` reads the row as the system with no
// tenant in play, so the operator's tenant is the only thing holding an admin
// of one tenant off every other's people. Two apps, one for each shape a
// tenancy takes: a column the app adds to User (`accountId`), and a membership row,
// where one person is in several tenants holding a different role in each
// (FJS-3016). Each refusal re-reads what it could have changed, and is paired
// with the same call succeeding inside the operator's own tenant.

const MACHINERY_NOT_TENANTED = ['User', 'Credential', 'Session', 'Verification', 'LoginChallenge', 'OauthFlow', 'AuditTrail']
  .map(m => `extend model ${m} { @@tenant(none) }`).join('\n')

async function tenantedApp(schema: string, gate: (u: any) => number, principal?: unknown) {
  const { GatePlugin } = await import('@frontierjs/litestone')
  const th = await makeAuth(
    { encryptionKey: TEST_KEY, sessionFields: (u: any) => ({ role: u.role, isAdmin: u.role === 'admin' || u.role === 'sysadmin' }) },
    undefined,
    { schema: `\n${schema}\n${MACHINERY_NOT_TENANTED}\n`, plugins: [new GatePlugin({ getLevel: gate })] },
  )
  const tapp: any = createApp({
    db: th.db, auth: th.auth as any,
    config: { port: 0 },
    logLevel: 'silent',
    ...(principal ? { principal } : {}),
  } as never)
  tapp.configure(auth({ auth: th.auth, ...rateLimits, services: { standingLevel: gate } }))
  const warn = console.warn
  console.warn = () => {}
  await tapp.start()
  console.warn = warn
  return { th, tapp, at: `http://localhost:${tapp.http.port}` }
}

const call = (at: string, as: string, path: string, method: string, headers: Record<string, string> = {}) =>
  fetch(`${at}/people${path}`, {
    method: method === 'get' ? 'GET' : method === 'remove' ? 'DELETE' : 'POST',
    headers: {
      authorization: `Bearer ${as}`, ...headers,
      ...(method === 'get' || method === 'remove' ? {} : { 'content-type': 'application/json', 'x-service-method': method }),
    },
    ...(method === 'get' || method === 'remove' ? {} : { body: '{}' }),
  })

describe('an operator in an account acts inside it (FJS-2643)', () => {
  const accountGate = (u: any) => !u ? 0 : u.role === 'sysadmin' ? 7 : u.isAdmin ? 5 : 4
  let t: Awaited<ReturnType<typeof tenantedApp>>
  beforeAll(async () => {
    t = await tenantedApp(`
tenancy { strategy row  column accountId  claim accountId }
extend model User { accountId String? @allow('write', auth().isAdmin) }`, accountGate)
  })
  afterAll(async () => { await t.tapp.stop?.(); t.th.cleanup() })

  async function member(accountId: string | null, role = 'user') {
    const email = `acct-${Date.now()}-${seq++}@example.com`
    const { userId } = await t.th.auth.createUser({ email, password: PW, role, ...(accountId ? { tenant: accountId } : {}) })
    const { token } = await t.th.auth.login(email, PW) as any
    return { email, userId, token }
  }

  test('another account’s person is a miss to read, sign out or remove, and stays signed in', async () => {
    const theirAdmin = await member('tidy', 'admin')
    const mine = await member('sparkle')
    const ownAdmin = await member('sparkle', 'admin')

    expect((await call(t.at, theirAdmin.token, `/${mine.userId}`, 'get')).status).toBe(404)
    expect((await call(t.at, theirAdmin.token, `/${mine.userId}`, 'signOut')).status).toBe(404)
    expect((await call(t.at, theirAdmin.token, `/${mine.userId}`, 'remove')).status).toBe(404)
    expect((await request(t.tapp).get('/account/me').auth(mine.token)).status).toBe(200)
    expect(await t.th.sys.user.findFirst({ where: { id: mine.userId } })).not.toBeNull()

    // The same calls from inside the account succeed.
    expect((await call(t.at, ownAdmin.token, `/${mine.userId}`, 'get')).status).toBe(200)
    expect((await call(t.at, ownAdmin.token, `/${mine.userId}`, 'signOut')).status).toBe(200)
    expect((await request(t.tapp).get('/account/me').auth(mine.token)).status).toBe(401)
    expect((await call(t.at, ownAdmin.token, `/${mine.userId}`, 'remove')).status).toBe(200)
    expect(await t.th.sys.user.findFirst({ where: { id: mine.userId } })).toBeNull()
  })

  test('an invitation lands in the operator’s account', async () => {
    const admin = await member('sparkle', 'admin')
    const email = `invited-acct-${Date.now()}@example.com`
    const res = await fetch(`${t.at}/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-method': 'invite', authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ email }),
    })
    expect(res.status).toBe(200)
    const { userId } = await res.json() as any
    expect((await t.th.sys.user.findFirst({ where: { id: userId } })).accountId).toBe('sparkle')
  })

  // FJS-1949. A seed and `fli auth:create-user --tenant` place a person in
  // one call, in the column this app's tenancy names (FJS-D1117).
  test('createUser places the person in the tenant, on the row and the session', async () => {
    const email = `placed-${Date.now()}-${seq++}@example.com`
    const made = await t.th.auth.createUser({ email, password: PW, tenant: 'sparkle' })
    expect((await t.th.sys.user.findFirst({ where: { id: made.userId } })).accountId).toBe('sparkle')
    expect(made.accountId).toBe('sparkle')
    const { token } = await t.th.auth.login(email, PW) as any
    expect((await t.th.auth.verifySession(token))?.accountId).toBe('sparkle')
  })

  test('an operator with no account is above every account', async () => {
    const admin = await member(null, 'admin')
    const mine = await member('sparkle')
    expect((await call(t.at, admin.token, `/${mine.userId}`, 'get')).status).toBe(200)
  })
})

describe('an operator in a workspace acts inside it, where a person may be in several (FJS-3016)', () => {
  const ROLE: Record<string, number> = { developer: 4, admin: 5 }
  const workspaceGate = (u: any) => !u ? 0 : u.role === 'sysadmin' ? 7 : ROLE[u.memberRole] ?? 1
  let t: Awaited<ReturnType<typeof tenantedApp>>
  beforeAll(async () => {
    const { membershipClaim, header } = await import('@frontierjs/junction')
    t = await tenantedApp(`
tenancy { strategy row  column workspaceId  claim workspaceId }
model Member {
  id          Int    @id @default(autoincrement())
  workspaceId String
  userId      String
  role        String
  @@gate(8)
}`, workspaceGate, membershipClaim({
      tenantFrom: header('x-ws'), model: 'member', subject: 'userId',
      tenant: 'workspaceId', standing: 'role', standingAs: 'memberRole',
    }))
  })
  afterAll(async () => { await t.tapp.stop?.(); t.th.cleanup() })

  async function person(memberships: Record<string, string>, role = 'user') {
    const email = `ws-${Date.now()}-${seq++}@example.com`
    const { userId } = await t.th.auth.createUser({ email, password: PW, role })
    for (const [workspaceId, r] of Object.entries(memberships)) {
      await t.th.sys.member.create({ data: { workspaceId, userId, role: r } })
    }
    const { token } = await t.th.auth.login(email, PW) as any
    return { email, userId, token }
  }
  const inA = { 'x-ws': 'A' }

  test('createUser refuses a tenant, since the column is on Member, and writes nothing', async () => {
    const email = `ws-placed-${Date.now()}-${seq++}@example.com`
    await rejectsWith(() => t.th.auth.createUser({ email, password: PW, tenant: 'A' }), AuthConfigError)
    expect(await t.th.sys.user.findFirst({ where: { email } })).toBeNull()
  })

  test('a person only in another workspace is a miss to read, sign out or remove, and stays signed in', async () => {
    const adminA = await person({ A: 'admin' })
    const onlyB  = await person({ B: 'developer' })
    const devA   = await person({ A: 'developer' })

    for (const method of ['get', 'signOut', 'remove']) {
      expect((await call(t.at, adminA.token, `/${onlyB.userId}`, method, inA)).status).toBe(404)
    }
    expect((await t.th.auth.listSessions!(onlyB.userId)) as any[]).toHaveLength(1)
    expect(await t.th.sys.user.findFirst({ where: { id: onlyB.userId } })).not.toBeNull()

    // The same calls on a person in the operator's workspace succeed.
    expect((await call(t.at, adminA.token, `/${devA.userId}`, 'get', inA)).status).toBe(200)
    expect((await call(t.at, adminA.token, `/${devA.userId}`, 'signOut', inA)).status).toBe(200)
    expect((await t.th.auth.listSessions!(devA.userId)) as any[]).toHaveLength(0)
  })

  test('the person is graded at their role in this workspace, so a peer admin is refused', async () => {
    const adminA = await person({ A: 'admin' })
    const peer   = await person({ A: 'admin' })
    const res = await call(t.at, adminA.token, `/${peer.userId}`, 'signOut', inA)
    expect(res.status).toBe(403)
    expect((await t.th.auth.listSessions!(peer.userId)) as any[]).toHaveLength(1)
  })

  test('a person also in another workspace is not deleted below SYSADMIN, and a person only here is', async () => {
    const adminA = await person({ A: 'admin' })
    const both   = await person({ A: 'developer', B: 'developer' })
    const onlyA  = await person({ A: 'developer' })

    const refused = await call(t.at, adminA.token, `/${both.userId}`, 'remove', inA)
    expect(refused.status).toBe(403)
    expect(await t.th.sys.user.findFirst({ where: { id: both.userId } })).not.toBeNull()

    expect((await call(t.at, adminA.token, `/${onlyA.userId}`, 'remove', inA)).status).toBe(200)
    expect(await t.th.sys.user.findFirst({ where: { id: onlyA.userId } })).toBeNull()

    const sys = await person({}, 'sysadmin')
    expect((await call(t.at, sys.token, `/${both.userId}`, 'remove')).status).toBe(200)
    expect(await t.th.sys.user.findFirst({ where: { id: both.userId } })).toBeNull()
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

// FJS-D1117. This package declares no tenant column, so with no row tenancy
// naming one on User a tenant has nowhere to go — refused, not dropped.
describe('createUser with no tenant column', () => {
  test('refuses a tenant and writes nothing', async () => {
    const email = `unplaceable-${Date.now()}-${seq++}@example.com`
    await rejectsWith(() => h.auth.createUser({ email, password: PW, tenant: 'sparkle' }), AuthConfigError)
    expect(await h.sys.user.findFirst({ where: { email } })).toBeNull()
  })

  test('puts no tenant claim on the session', async () => {
    const email = `unplaced-${Date.now()}-${seq++}@example.com`
    const made = await h.auth.createUser({ email, password: PW })
    expect(made.accountId).toBeUndefined()
  })
})
