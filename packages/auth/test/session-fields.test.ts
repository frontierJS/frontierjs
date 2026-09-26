// test/session-fields.test.ts
//
// `sessionFields` is called with the user row in hand and must answer
// synchronously. An async one spread to nothing — a promise has no own
// enumerable keys — and took every standing it returned with it, so an
// administrator graded USER(4) with nothing said (`FJS-1251`). Paired: the
// same fields returned synchronously reach the session.

import { describe, test, expect } from 'bun:test'
import { makeAuth, signedIn } from './harness.ts'

describe('sessionFields', () => {
  test('a synchronous answer reaches the session', async () => {
    const h = await makeAuth({ sessionFields: () => ({ isAdmin: true, siteId: 7 }) })
    await h.auth.createUser({ email: 'sync@example.com', password: 'pw-correct-1', name: 'Sync' })
    const { user } = signedIn(await h.auth.login('sync@example.com', 'pw-correct-1'))
    expect((user as any).isAdmin).toBe(true)
    expect((user as any).siteId).toBe(7)
    h.cleanup()
  })

  test('a promise is refused by name, naming where a value on another row belongs', async () => {
    const h = await makeAuth({ sessionFields: (async () => ({ isAdmin: true })) as any })
    // createUser issues the first session through the same builder as login,
    // so it is the first thing refused.
    let err = ''
    try { await h.auth.createUser({ email: 'async@example.com', password: 'pw-correct-1', name: 'Async' }) }
    catch (e) { err = (e as Error).message }
    expect(err).toContain('sessionFields returned a promise')
    expect(err).toContain('claim <name> from <Model>')
    h.cleanup()
  })
})
