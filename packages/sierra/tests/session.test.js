/**
 * tests/session.test.js
 *
 * The UI-realm half of the auth surface — `session`, `ready`, `signIn`,
 * `signOut`.
 *
 * Every assertion here is about a thing an app used to have to write for
 * itself, and each one is a shape that was got wrong at least once in this
 * repo (`FJS-D20`):
 *
 *   · `ready` resolves whether or not there is a session, or a guard awaiting
 *     it hangs forever on an anonymous visit.
 *   · A refusal is on `session.error` AND thrown — a form catches, a shell
 *     renders, and neither should have to write the other's half.
 *   · The level is the SERVER's and is absent unless the app publishes one;
 *     inventing a number here would be the browser grading itself.
 *
 * The module holds the session, so each test resets the module registry and
 * imports its own instance rather than sharing one.
 */

import { describe, test, expect, vi } from 'vitest'

async function freshSession() {
  // The module holds `session`, `ready` and the boot state, so each test needs
  // its own instance. A cache-busting query string is not an option — Vite
  // refuses a dynamic import it cannot resolve statically.
  vi.resetModules()
  return import('../src/junction/session.js')
}

/** The smallest thing initSession() can drive: a client with an auth surface. */
function fakeClient({ token = null, me = null, fail = null } = {}) {
  const calls = []
  return {
    token,
    calls,
    auth: {
      async me() {
        calls.push('me')
        if (fail) throw fail
        return me
      },
      async signIn(email, password) {
        calls.push(`signIn:${email}:${password}`)
        if (fail) throw fail
        this._c.token = 'tok'
        return { token: 'tok', user: me }
      },
      async signUp(data) {
        calls.push(`signUp:${data.email}`)
        return { token: 'tok', user: me }
      },
      async signOut() {
        calls.push('signOut')
        return { revoked: true }
      },
      _c: null,
    },
  }
}

describe('the boot restore', () => {

  test('with no token it asks nothing and still resolves ready', async () => {
    const s = await freshSession()
    const client = fakeClient()

    s.initSession(client)
    await s.ready

    // Asking anyway would 401 on every cold visit to a public page — traffic
    // that is behaving correctly.
    expect(client.calls).toEqual([])
    expect(s.session.checked).toBe(true)
    expect(s.session.user).toBeNull()
  })

  test('with a token it loads the session before ready resolves', async () => {
    const s = await freshSession()
    const client = fakeClient({ token: 't', me: { userId: 'u1', email: 'a@b.c' } })

    s.initSession(client)
    await s.ready

    expect(client.calls).toEqual(['me'])
    expect(s.session.user.email).toBe('a@b.c')
    expect(s.session.checked).toBe(true)
  })

  test('a token the server no longer honours leaves no session, and ready still resolves', async () => {
    const s = await freshSession()
    const client = fakeClient({ token: 'stale', fail: Object.assign(new Error('Unauthorized'), { code: 401 }) })

    s.initSession(client)
    await s.ready

    // A guard awaiting ready must not hang because the restore failed.
    expect(s.session.checked).toBe(true)
    expect(s.session.user).toBeNull()
    // 401 is the ordinary answer to an expired token — not something to show.
    expect(s.session.error).toBeNull()
  })

  test('an error that is not a 401 is reported rather than swallowed', async () => {
    const s = await freshSession()
    const client = fakeClient({ token: 't', fail: new Error('API not reachable') })

    s.initSession(client)
    await s.ready

    expect(s.session.error).toBe('API not reachable')
  })
})

describe('signing in', () => {

  test('resolves with the session already loaded', async () => {
    const s = await freshSession()
    const client = fakeClient({ me: { userId: 'u1', email: 'a@b.c' } })
    client.auth._c = client
    s.initSession(client)
    await s.ready

    await s.signIn('a@b.c', 'pw')

    expect(client.calls).toEqual(['signIn:a@b.c:pw', 'me'])
    expect(s.session.user.email).toBe('a@b.c')
  })

  test('a refusal lands on session.error AND throws', async () => {
    const s = await freshSession()
    const client = fakeClient({ fail: Object.assign(new Error('Invalid credentials'), { code: 401 }) })
    s.initSession(client)
    await s.ready

    await expect(s.signIn('a@b.c', 'nope')).rejects.toThrow('Invalid credentials')
    // Both, because there are two shapes of caller: a form awaits and catches,
    // a shell renders {#if session.error} and never touches the promise.
    expect(s.session.error).toBe('Invalid credentials')
  })
})

describe('signing out', () => {

  test('tells the server, then clears here', async () => {
    const s = await freshSession()
    const client = fakeClient({ token: 't', me: { userId: 'u1', email: 'a@b.c' } })
    s.initSession(client)
    await s.ready
    expect(s.session.user).not.toBeNull()

    await s.signOut()

    expect(client.calls).toEqual(['me', 'signOut'])
    expect(s.session.user).toBeNull()
  })
})

describe('the level', () => {

  test('is UNKNOWN for a signed-in caller whose app publishes none', async () => {
    const s = await freshSession()
    const client = fakeClient({ token: 't', me: { userId: 'u1' } })
    s.initSession(client)
    await s.ready

    // null rather than 0, because unknown is permissive to canAtLevel: an app
    // that never asked to be graded here must not have every gated control
    // hidden from a caller who is signed in.
    expect(s.session.level).toBeNull()
  })

  test('is the number the server graded', async () => {
    const s = await freshSession()
    const client = fakeClient({ token: 't', me: { userId: 'u1', level: 5 } })
    s.initSession(client)
    await s.ready

    expect(s.session.level).toBe(5)
  })

  test('a caller with no session is STRANGER(0) — before any answer, and after signing out', async () => {
    const s = await freshSession()
    const client = fakeClient()
    s.initSession(client)
    await s.ready

    // The one level a browser can state for itself: every gate above 0 refuses
    // a request carrying no principal, whatever the app's resolver says.
    // Leaving it unknown would make a signed-out page offer every gated
    // control it has — which is what the example app's drive caught.
    expect(s.session.level).toBe(0)

    const s2 = await freshSession()
    const c2 = fakeClient({ token: 't', me: { userId: 'u1', level: 5 } })
    s2.initSession(c2)
    await s2.ready
    await s2.signOut()
    expect(s2.session.level).toBe(0)
  })
})
