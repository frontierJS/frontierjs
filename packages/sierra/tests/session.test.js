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

import { describe, test, expect, vi, afterEach } from 'vitest'

async function freshSession() {
  // The module holds `session`, `ready` and the boot state, so each test needs
  // its own instance. A cache-busting query string is not an option — Vite
  // refuses a dynamic import it cannot resolve statically.
  vi.resetModules()
  return import('../src/junction/session.js')
}

/** The smallest thing initSession() can drive: a client with an auth surface. */
function fakeClient({ token = null, cookieAuth = false, me = null, fail = null } = {}) {
  const calls = []
  return {
    token,
    // The real client's own accessor, restated because this stub is not one:
    // `token` alone is the Bearer answer, and in cookie mode the credential is
    // a cookie no script can read (FJS-474).
    get hasCredential() { return cookieAuth || !!this.token },
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

describe('an OAuth refusal on the URL', () => {

  // The callback is a browser redirect, so there is no promise to reject and no
  // response to read — a query parameter on a page load is the ONLY channel a
  // refusal has. Until something lifts it off, the app boots as if nothing
  // happened and a person who clicked Deny sees the sign-in page again with no
  // explanation.

  function atUrl(href) {
    const url = new URL(href)
    const state = { href: url.href }
    vi.stubGlobal('location', { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash })
    vi.stubGlobal('history', {
      state: null,
      replaceState(_s, _t, next) { state.href = new URL(next, url.origin).href },
    })
    return state
  }

  afterEach(() => vi.unstubAllGlobals())

  test('is lifted onto the session', async () => {
    atUrl('https://shop.test/sign-in?oauth_error=denied')
    const s = await freshSession()

    s.initSession(fakeClient())
    await s.ready

    expect(s.session.oauthError).toBe('denied')
  })

  test('is removed from the URL, so a refresh does not replay it', async () => {
    // Left in place it survives a reload and every share of the link, so a
    // message about one attempt reappears for ever — including for whoever it
    // is pasted to.
    const nav = atUrl('https://shop.test/sign-in?oauth_error=state&next=/orders')
    const s = await freshSession()

    s.initSession(fakeClient())

    expect(nav.href).not.toContain('oauth_error')
    // and nothing else on the URL is disturbed
    expect(nav.href).toContain('next=%2Forders')
  })

  test('is absent when there is nothing to report', async () => {
    atUrl('https://shop.test/')
    const s = await freshSession()

    s.initSession(fakeClient())
    await s.ready

    expect(s.session.oauthError).toBeNull()
  })

  test('does not stop the ordinary restore from running', async () => {
    // A failed attempt with one provider says nothing about the session the
    // browser may already be holding.
    atUrl('https://shop.test/?oauth_error=denied')
    const s = await freshSession()
    const client = fakeClient({ cookieAuth: true, me: { userId: 'u1', email: 'a@b.c' } })

    s.initSession(client)
    await s.ready

    expect(s.session.oauthError).toBe('denied')
    expect(s.session.user?.userId).toBe('u1')
  })

  // ── the sentence ─────────────────────────────────────────────────────────
  //
  // The codes are coarse because the route refuses to say whether a state
  // existed or an exchange failed — that is an oracle for anyone who can reach
  // the URL. What is left is five tokens no person can read, so the table is
  // here rather than in each app: this module exists because `example` and
  // `basecamp` each wrote their own session.js, and five untranslated codes is
  // where the next divergence starts.

  test('arrives with words beside it', async () => {
    atUrl('https://shop.test/sign-in?oauth_error=denied')
    const s = await freshSession()

    s.initSession(fakeClient())
    await s.ready

    expect(s.session.oauthMessage).toBe(s.OAUTH_ERRORS.denied)
    // A sentence, not the token — the thing a screen renders.
    expect(s.session.oauthMessage).not.toBe('denied')
  })

  test('every emitted code has one', async () => {
    const s = await freshSession()
    // The five the plugin's oauthFailure() can emit. A sixth added there with
    // no entry here falls to the generic sentence, which is the right failure
    // and still worth knowing about.
    for (const code of ['denied', 'state', 'exchange', 'unavailable', 'link_required']) {
      expect(s.OAUTH_ERRORS[code]).toBeTruthy()
      expect(s.oauthErrorMessage(code)).toBe(s.OAUTH_ERRORS[code])
    }
  })

  test('a code this build has never heard of still says something', async () => {
    // The API deploys separately from the app, so a code added on one side
    // reaches a browser running the other. Nothing at all on screen is the
    // failure this whole channel exists to fix, so the fallback is a sentence
    // rather than null.
    const s = await freshSession()
    expect(s.oauthErrorMessage('teleported')).toBeTruthy()
    expect(s.oauthErrorMessage(null)).toBeNull()
    expect(s.oauthErrorMessage('')).toBeNull()
  })

  // `link_required` is the flow WORKING: an account already holds the address
  // and a confirmation link has gone out. An app that renders all five codes in
  // one red alert tells that person their sign-in failed, when the next step is
  // in their inbox. The code is kept beside the sentence so a screen can branch
  // on it — which is the only reason both fields exist.
  test('link_required reads as an instruction, and keeps its code to branch on', async () => {
    atUrl('https://shop.test/sign-in?oauth_error=link_required')
    const s = await freshSession()

    s.initSession(fakeClient())
    await s.ready

    expect(s.session.oauthError).toBe('link_required')
    expect(s.session.oauthMessage).toMatch(/inbox|email/i)
  })
})

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

  test('in cookie mode it asks even though there is no token', async () => {
    // The case FJS-474 was: a credential that cannot be read is not a credential
    // that is absent, and reading `token` alone rendered every cookie-mode app
    // signed out on each cold load with a valid session in the jar.
    const s = await freshSession()
    const client = fakeClient({ cookieAuth: true, me: { userId: 'u1', email: 'a@b.c' } })

    s.initSession(client)
    await s.ready

    expect(client.calls).toEqual(['me'])
    expect(s.session.user?.userId).toBe('u1')
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

  test('a token the server no longer honors leaves no session, and ready still resolves', async () => {
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
