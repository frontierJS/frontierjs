// test/authorization-code.test.ts
//
// `/authorize`'s code (`FJS-D1949`): a `Credential` row of type `authCode`
// bound to a PKCE challenge, a client, a redirect and a resource. Every
// refusal is the one `InvalidGrantError`; the `authcode.refused` row's
// `reason` is what tells them apart, and the row is gone after any of them.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { makeAuth, rejectsWith, TEST_KEY, type Harness } from './harness.ts'
import { pkceChallenge } from '../crypto.ts'
import { InvalidGrantError, InvalidTokenError } from '../errors.ts'

const CLIENT   = 'https://claude.ai/oauth/claude-code-client-metadata'
const REDIRECT = 'http://localhost:51234/callback'
const RESOURCE = 'https://app.example/mcp'

let t = new Date('2026-11-05T12:00:00Z').getTime()
const clock = { now: () => new Date(t) }

let h: Harness
let seq = 0

const settle = () => new Promise(r => setImmediate(r))

async function trail(run: () => Promise<unknown>): Promise<any[]> {
  await settle()
  const before = (await h.sys.auditTrail.findMany({})).length
  try { await run() } catch { /* a refusal is the case under test */ }
  await settle()
  return (await h.sys.auditTrail.findMany({})).slice(before)
}

async function issued(over: Partial<{ clientId: string, redirectUri: string, resource: string }> = {}) {
  const user     = await h.auth.createUser({ email: `code-${seq++}@example.com`, password: 'pw-1' })
  const verifier = randomBytes(32).toString('base64url')
  const binding  = { clientId: CLIENT, redirectUri: REDIRECT, resource: RESOURCE, ...over }
  const { code, expiresAt } = await h.auth.issueAuthorizationCode!({
    userId: String(user.id), challenge: pkceChallenge(verifier), ...binding,
  })
  return { userId: String(user.id), code, verifier, expiresAt, redeem: { code, verifier, ...binding } }
}

const codes = (userId: string) => h.sys.credential.count({ where: { userId, type: 'authCode' } })

beforeAll(async () => { h = await makeAuth({ encryptionKey: TEST_KEY }, clock) })
afterAll(() => h.cleanup())

describe('issue and redeem', () => {
  test('round trip answers who, for which client and resource, and spends the row', async () => {
    const c = await issued()
    expect(new Date(c.expiresAt).getTime() - t).toBe(5 * 60 * 1000)
    expect(await codes(c.userId)).toBe(1)
    expect(await h.auth.redeemAuthorizationCode!(c.redeem)).toEqual({ userId: c.userId, clientId: CLIENT, resource: RESOURCE })
    expect(await codes(c.userId)).toBe(0)
  })

  test('the row names its client and redirect, and keeps the resource as its label', async () => {
    const c   = await issued()
    const row = await h.sys.credential.findFirst({ where: { userId: c.userId, type: 'authCode' } })
    expect(row).toMatchObject({ clientId: CLIENT, redirectUri: REDIRECT, label: RESOURCE })
    expect(row.value).not.toContain(c.code)
  })

  test('a plain challenge is refused at issue', async () => {
    await rejectsWith(() => h.auth.issueAuthorizationCode!({
      userId: 'u', clientId: CLIENT, redirectUri: REDIRECT, resource: RESOURCE, challenge: 'too-short',
    }), InvalidTokenError)
  })

  test('the issue is in the trail, naming the client and the resource', async () => {
    let c: any
    const rows = await trail(async () => { c = await issued() })
    const row  = rows.find(r => r.operation === 'authcode.issued')
    expect(row?.actorId).toBe(c.userId)
    expect(row?.meta).toEqual({ clientId: CLIENT, resource: RESOURCE })
  })
})

describe('refusals', () => {
  const refused = async (run: () => Promise<unknown>) => {
    let err: unknown
    const rows = await trail(async () => { try { await run() } catch (e) { err = e; throw e } })
    expect(err).toBeInstanceOf(InvalidGrantError)
    expect((err as InvalidGrantError).status).toBe(400)
    return rows.find(r => r.operation === 'authcode.refused')?.meta?.reason
  }

  test('a wrong verifier is refused and leaves the row for the right one', async () => {
    const c = await issued()
    expect(await refused(() => h.auth.redeemAuthorizationCode!({ ...c.redeem, verifier: randomBytes(32).toString('base64url') }))).toBe('unknown-code')
    expect(await codes(c.userId)).toBe(1)
  })

  for (const [key, value, reason] of [
    ['clientId',    'https://evil.example/client',      'client-mismatch'],
    ['redirectUri', 'http://localhost:51234/elsewhere', 'redirect-mismatch'],
    ['resource',    'https://other.example/mcp',        'resource-mismatch'],
  ] as const) {
    test(`a mismatched ${key} is refused, and the code is spent`, async () => {
      const c = await issued()
      expect(await refused(() => h.auth.redeemAuthorizationCode!({ ...c.redeem, [key]: value }))).toBe(reason)
      expect(await codes(c.userId)).toBe(0)
      expect(await refused(() => h.auth.redeemAuthorizationCode!(c.redeem))).toBe('unknown-code')
    })
  }

  test('a replay is refused', async () => {
    const c = await issued()
    await h.auth.redeemAuthorizationCode!(c.redeem)
    expect(await refused(() => h.auth.redeemAuthorizationCode!(c.redeem))).toBe('unknown-code')
  })

  test('an expired code is refused, and spent', async () => {
    const c = await issued()
    t += 5 * 60 * 1000 + 1
    expect(await refused(() => h.auth.redeemAuthorizationCode!(c.redeem))).toBe('expired')
    expect(await codes(c.userId)).toBe(0)
  })
})

describe('a handoff and a code are not each other', () => {
  test('a handoff code does not redeem as an authorization code', async () => {
    const user     = await h.auth.createUser({ email: `handoff-${seq++}@example.com`, password: 'pw-1' })
    const verifier = randomBytes(32).toString('base64url')
    const { code } = await h.auth.issueHandoff!(String(user.id), { challenge: pkceChallenge(verifier), audience: RESOURCE })
    await rejectsWith(() => h.auth.redeemAuthorizationCode!({ code, verifier, clientId: CLIENT, redirectUri: REDIRECT, resource: RESOURCE }), InvalidGrantError)
    expect(await h.auth.redeemHandoff!(code, verifier)).toMatchObject({ userId: String(user.id), audience: RESOURCE })
  })

  test('an authorization code does not redeem as a handoff', async () => {
    const c = await issued()
    expect(await h.auth.redeemHandoff!(c.code, c.verifier)).toBeNull()
    expect(await h.auth.redeemAuthorizationCode!(c.redeem)).toMatchObject({ userId: c.userId })
  })
})
