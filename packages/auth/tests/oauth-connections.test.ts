// tests/oauth-connections.test.ts
//
// What is attached to this account, and detaching one.
//
// A SERVICE and not a route, and the line is `FJS-D20`'s: `/auth/oauth/*`
// establishes a session and nothing here does — a caller managing what can sign
// them in is already signed in.
//
// The test that matters is the refusal. Unlinking to zero is a PERMANENT
// lockout with no way back, because `confirmPasswordReset` updates a password
// credential and does not create one — so an account with none cannot gain one
// by asking for a reset. It looks like an ordinary button.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, type Harness } from './harness.ts'
import { defineProvider, LastCredentialError, NotFoundError } from '../index.ts'

const google = defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' })
const okta   = defineProvider('okta',   'oidc',   {
  clientId: 'c', clientSecret: 's',
  authorizeUrl: 'https://o.test/a', tokenUrl: 'https://o.test/t', userinfoUrl: 'https://o.test/u',
})

let h: Harness
beforeAll(async () => { h = await makeAuth({ oauthProviders: { google, okta } }) })
afterAll(() => h.cleanup())

async function userWith(email: string, kinds: string[]) {
  const user = await h.sys.user.create({ data: { email, emailVerified: true } })
  for (const type of kinds) {
    await h.sys.credential.create({
      data: { userId: user.id, type, value: `${type}-value-${email}` },
    })
  }
  return user
}

// ─── listing ────────────────────────────────────────────────────────────────

describe('listConnections', () => {

  test('answers the OAuth identities and not the password', async () => {
    const u = await userWith('list@shop.test', ['password', 'oauth:google', 'oauth:okta'])
    const rows = await h.auth.listConnections(u.id)

    expect(rows.map(r => r.provider).sort()).toEqual(['google', 'okta'])
  })

  test('never answers the provider subject', async () => {
    // Not a secret, but an identifier at a third party that nothing on a
    // settings screen needs and every log it lands in keeps.
    const u = await userWith('quiet@shop.test', ['oauth:google'])
    const [row] = await h.auth.listConnections(u.id)

    expect(row).not.toHaveProperty('value')
    expect(JSON.stringify(row)).not.toContain('oauth:google-value')
  })

  test('an account with none answers an empty list, not an error', async () => {
    const u = await userWith('none@shop.test', ['password'])
    expect(await h.auth.listConnections(u.id)).toEqual([])
  })
})

// ─── detaching ──────────────────────────────────────────────────────────────

describe('removeConnection', () => {

  test('detaches one when there is another way in', async () => {
    const u = await userWith('two@shop.test', ['password', 'oauth:google'])
    const [conn] = await h.auth.listConnections(u.id)

    await h.auth.removeConnection(u.id, conn.id)

    expect(await h.auth.listConnections(u.id)).toEqual([])
    // the password is untouched
    expect((await h.sys.credential.findMany({ where: { userId: u.id } })).length).toBe(1)
  })

  test('REFUSES the last way in', async () => {
    const u = await userWith('only@shop.test', ['oauth:google'])
    const [conn] = await h.auth.listConnections(u.id)

    await rejectsWith(() => h.auth.removeConnection(u.id, conn.id), LastCredentialError)
    expect((await h.auth.listConnections(u.id)).length).toBe(1)
  })

  test('two providers and no password: the first goes, the second is refused', async () => {
    const u = await userWith('pair@shop.test', ['oauth:google', 'oauth:okta'])
    const before = await h.auth.listConnections(u.id)

    await h.auth.removeConnection(u.id, before[0].id)
    const after = await h.auth.listConnections(u.id)
    expect(after.length).toBe(1)

    await rejectsWith(() => h.auth.removeConnection(u.id, after[0].id), LastCredentialError)
  })

  test('an API KEY does not count as a way in', async () => {
    // It authenticates a machine holding a secret this person may not have, and
    // it cannot be used to sign in and re-link.
    const u = await userWith('keyed@shop.test', ['oauth:google', 'apiKey'])
    const [conn] = await h.auth.listConnections(u.id)

    await rejectsWith(() => h.auth.removeConnection(u.id, conn.id), LastCredentialError)
  })

  test("somebody else's connection is NOT FOUND, not forbidden", async () => {
    // The two answers differ, and the second confirms the row exists.
    const mine   = await userWith('mine@shop.test',   ['password', 'oauth:google'])
    const theirs = await userWith('theirs@shop.test', ['password', 'oauth:google'])
    const [conn] = await h.auth.listConnections(theirs.id)

    await rejectsWith(() => h.auth.removeConnection(mine.id, conn.id), NotFoundError)
    // and it is still attached to whoever owns it
    expect((await h.auth.listConnections(theirs.id)).length).toBe(1)
  })

  test('a password credential cannot be removed through this door', async () => {
    // It is not a connection. Unlinking is for providers; the password has its
    // own operations and its own service.
    const u = await userWith('pw@shop.test', ['password', 'oauth:google'])
    const pw = (await h.sys.credential.findMany({ where: { userId: u.id } }))
      .find((c: any) => c.type === 'password')

    await rejectsWith(() => h.auth.removeConnection(u.id, String(pw.id)), NotFoundError)
  })

  test('an id that is not there is NOT FOUND', async () => {
    const u = await userWith('ghost@shop.test', ['password', 'oauth:google'])
    await rejectsWith(() => h.auth.removeConnection(u.id, '999999'), NotFoundError)
  })
})
