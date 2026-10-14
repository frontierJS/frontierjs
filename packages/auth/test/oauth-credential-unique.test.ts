// test/oauth-credential-unique.test.ts
//
// FJS-2658 — one (provider, subject) is one Credential row. The read in
// `oauthResolve` branch 1 and the write in branch 3 or 4 are separate awaits,
// so two callbacks for a subject nobody has seen both read "nobody" and both
// write. Branch 1 then answers whichever row it reaches first.
//
// The schema holds it: a partial unique over every credential type whose
// `value` names a subject. A password hash is not one.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness } from './harness.ts'
import { defineProvider } from '../oauth.ts'

const google = defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' })

let h: Harness

beforeAll(async () => {
  h = await makeAuth({ oauthProviders: { google } })
})
afterAll(() => h.cleanup())

const identity = (sub: string, email: string) =>
  ({ providerId: sub, email, emailVerified: true, name: 'Racer' } as any)

describe('Credential (type, value) for a subject-bearing type', () => {

  test('a second oauth credential for one (provider, subject) is refused', async () => {
    const a = await h.sys.user.create({ data: { email: 'uniq-a@shop.test' } })
    const b = await h.sys.user.create({ data: { email: 'uniq-b@shop.test' } })
    await h.sys.credential.create({ data: { userId: a.id, type: 'oauth:google', value: 'sub-dup' } })
    await expect(
      h.sys.credential.create({ data: { userId: b.id, type: 'oauth:google', value: 'sub-dup' } }),
    ).rejects.toThrow()
    expect(await h.sys.credential.count({ where: { type: 'oauth:google', value: 'sub-dup' } })).toBe(1)
  })

  test('the same subject at another provider is a different identity', async () => {
    const a = await h.sys.user.create({ data: { email: 'uniq-c@shop.test' } })
    await h.sys.credential.create({ data: { userId: a.id, type: 'oauth:google', value: 'sub-shared' } })
    await h.sys.credential.create({ data: { userId: a.id, type: 'oauth:github', value: 'sub-shared' } })
    expect(await h.sys.credential.count({ where: { value: 'sub-shared' } })).toBe(2)
  })

  test('two password rows with one value are still allowed', async () => {
    const a = await h.sys.user.create({ data: { email: 'uniq-d@shop.test' } })
    const b = await h.sys.user.create({ data: { email: 'uniq-e@shop.test' } })
    await h.sys.credential.create({ data: { userId: a.id, type: 'password', value: 'same-hash' } })
    await h.sys.credential.create({ data: { userId: b.id, type: 'password', value: 'same-hash' } })
    expect(await h.sys.credential.count({ where: { type: 'password', value: 'same-hash' } })).toBe(2)
  })
})

describe('two concurrent callbacks for one new subject', () => {

  // Branch 4: a verified account holds the address, so neither callback
  // creates a user and nothing but Credential can refuse the second write.
  test('onto a verified account: one credential, and both sign in', async () => {
    const user = await h.sys.user.create({ data: { email: 'race@shop.test', emailVerified: true } })
    const id   = identity('sub-race', 'race@shop.test')
    const [x, y] = await Promise.all([
      h.auth.oauthResolve('google', id),
      h.auth.oauthResolve('google', id),
    ])

    expect(await h.sys.credential.count({ where: { type: 'oauth:google', value: 'sub-race' } })).toBe(1)
    expect(x).toMatchObject({ outcome: 'signed-in', user: { userId: user.id } })
    expect(y).toMatchObject({ outcome: 'signed-in', user: { userId: user.id } })
  })

  // Branch 3: the user row's own unique email already refuses the second; it
  // must still end as one account and one credential.
  test('with no account: one user, one credential', async () => {
    const id = identity('sub-race-new', 'race-new@shop.test')
    await Promise.allSettled([
      h.auth.oauthResolve('google', id),
      h.auth.oauthResolve('google', id),
    ])

    expect(await h.sys.credential.count({ where: { type: 'oauth:google', value: 'sub-race-new' } })).toBe(1)
    expect(await h.sys.user.count({ where: { email: 'race-new@shop.test' } })).toBe(1)
  })
})
