// test/auth-cookie.test.ts
//
// FJS-002 — the transport resolves a session from a cookie, when asked to.
//
// `extractToken()` read only `authorization: Bearer` and `x-api-key`, so
// @frontierjs/auth's documented `cookieAuth: true` mode set an httpOnly cookie
// that nothing ever read back: `ctx.user` stayed null and a cookie-only request
// to any protected route was 401. The mode handed you a session you could not
// use.
//
// The auth package has its own end-to-end test for that (`routes.test.ts`,
// "a cookie alone authenticates a request" — previously a KNOWN GAP asserting
// 401). These are the transport's own, because this is where the code lives and
// because two of the rules below are security decisions rather than plumbing:
//
//   - cookies are OFF unless a name is supplied. A Bearer token has to be
//     attached by script so a cross-site request cannot forge one; a cookie
//     travels automatically, which is what makes CSRF possible at all. An app
//     takes that exposure deliberately or not at all.
//   - an explicitly-attached credential beats an ambient one, so Bearer wins.

import { describe, it, expect } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import type { SessionVerifier, SessionContext } from '../src/auth/types.ts'

/**
 * The smallest provider that can say yes to exactly one token.
 *
 * A `SessionVerifier` rather than an `IAuth`, and no cast either way — this
 * used to be written `: IAuth { … } as IAuth`, casting past five methods it
 * does not implement and Junction never calls (`FJS-D10`).
 */
function oneTokenAuth(token: string, user: Partial<SessionContext>): SessionVerifier {
  return {
    async verifySession(t: string) {
      return t === token ? ({ id: 'u1', ...user } as SessionContext) : null
    },
  }
}

/** An app with a single route that reports who the transport thinks you are. */
function appWith(auth: SessionVerifier, cookieName: string | null) {
  const app = createApp({
    config: { ...defaultConfig, port: 0 },
    auth,
  })
  if (cookieName) app.http.setAuthCookie(cookieName)
  app.get('/whoami', (ctx: any) =>
    ctx.user ? ctx.json({ userId: ctx.user.id }) : ctx.json({ anon: true }, 401))
  return app
}

const hit = (app: any, headers: Record<string, string>) =>
  app.http.fetch(new Request('http://localhost/whoami', { headers }))

describe('session from a cookie', () => {

  it('authenticates from the cookie once a name is set', async () => {
    const app = appWith(oneTokenAuth('tok-1', { id: 'alice' }), 'session')
    await app.start()
    const res = await hit(app, { cookie: 'session=tok-1' })
    expect(res.status).toBe(200)
    expect((await res.json()).userId).toBe('alice')
    await app.stop()
  })

  it('does NOT read cookies by default', async () => {
    // The security default. An app that never asked for cookie auth must not
    // acquire CSRF exposure because a dependency started setting a cookie.
    const app = appWith(oneTokenAuth('tok-1', {}), null)
    await app.start()
    expect((await hit(app, { cookie: 'session=tok-1' })).status).toBe(401)
    await app.stop()
  })

  it('reads the name it was given, not a name it guessed', async () => {
    const app = appWith(oneTokenAuth('tok-1', {}), 'sid')
    await app.start()
    expect((await hit(app, { cookie: 'sid=tok-1' })).status).toBe(200)
    expect((await hit(app, { cookie: 'session=tok-1' })).status).toBe(401)
    await app.stop()
  })

  it('a Bearer token wins over the cookie', async () => {
    // Explicit beats ambient, so acting as someone else for one call stays
    // possible from a browser that is also holding a session cookie.
    const auth: SessionVerifier = {
      async verifySession(t: string) {
        if (t === 'cookie-tok') return { id: 'from-cookie' } as SessionContext
        if (t === 'bearer-tok') return { id: 'from-bearer' } as SessionContext
        return null
      },
    }
    const app = appWith(auth, 'session')
    await app.start()
    const res = await hit(app, { cookie: 'session=cookie-tok', authorization: 'Bearer bearer-tok' })
    expect((await res.json()).userId).toBe('from-bearer')
    await app.stop()
  })

  it('an x-api-key also wins over the cookie', async () => {
    const auth: SessionVerifier = {
      async verifySession(t: string) {
        if (t === 'cookie-tok') return { id: 'from-cookie' } as SessionContext
        if (t === 'key-tok')    return { id: 'from-key' } as SessionContext
        return null
      },
    }
    const app = appWith(auth, 'session')
    await app.start()
    const res = await hit(app, { cookie: 'session=cookie-tok', 'x-api-key': 'key-tok' })
    expect((await res.json()).userId).toBe('from-key')
    await app.stop()
  })

  it('an emptied cookie is not a token — this is what logout leaves', async () => {
    // clearCookie() sets `session=` with Max-Age=0. Treating '' as a token
    // would fire a guaranteed-failing verifySession on every request after
    // sign-out.
    const app = appWith(oneTokenAuth('tok-1', {}), 'session')
    await app.start()
    expect((await hit(app, { cookie: 'session=' })).status).toBe(401)
    await app.stop()
  })

  it('an unknown cookie value is 401, not a crash', async () => {
    const app = appWith(oneTokenAuth('tok-1', {}), 'session')
    await app.start()
    expect((await hit(app, { cookie: 'session=nope' })).status).toBe(401)
    await app.stop()
  })

  it('survives a malformed cookie header', async () => {
    const app = appWith(oneTokenAuth('tok-1', {}), 'session')
    await app.start()
    expect((await hit(app, { cookie: '=;;x; session=tok-1' })).status).toBe(200)
    await app.stop()
  })

  it('picks the session cookie out of several', async () => {
    const app = appWith(oneTokenAuth('tok-1', {}), 'session')
    await app.start()
    const res = await hit(app, { cookie: 'theme=dark; session=tok-1; locale=en' })
    expect(res.status).toBe(200)
    await app.stop()
  })

  it('setAuthCookie(null) turns it back off', async () => {
    const app = appWith(oneTokenAuth('tok-1', {}), 'session')
    await app.start()
    expect((await hit(app, { cookie: 'session=tok-1' })).status).toBe(200)
    app.http.setAuthCookie(null)
    expect((await hit(app, { cookie: 'session=tok-1' })).status).toBe(401)
    await app.stop()
  })

  it('config.auth.cookie is the path for a hand-rolled IAuth', async () => {
    // The auth plugin declares cookie mode itself, so an app using it never
    // writes this. An app with its own IAuth that issues its own cookie has no
    // plugin to do it, and this is how it says so.
    const app = createApp({
      config: {
        ...defaultConfig, port: 0,
        auth: { cookie: 'my_session' },
      } as any,
      auth: oneTokenAuth('tok-1', { id: 'configured' }),
    })
    app.get('/whoami', (ctx: any) =>
      ctx.user ? ctx.json({ userId: ctx.user.id }) : ctx.json({ anon: true }, 401))
    await app.start()
    const res = await hit(app, { cookie: 'my_session=tok-1' })
    expect(res.status).toBe(200)
    expect((await res.json()).userId).toBe('configured')
    await app.stop()
  })
})

// ── __Host- when Secure (FJS-D1957) ──────────────────────────────────────

describe('a Secure session cookie is __Host-session', () => {

  // Another App under the same parent domain can set `session` with a
  // `Domain` attribute and the browser sends it here. A `__Host-` cookie is
  // the one name such a cookie cannot take, and only that name is read, so a
  // planted `session` signs in nobody even when the person has no session.

  function secureApp(secure: boolean) {
    const app = createApp({ config: { ...defaultConfig, port: 0 }, auth: oneTokenAuth('tok-1', { id: 'alice' }) })
    app.http.setAuthCookie('session', { secure })
    app.get('/whoami', (ctx: any) =>
      ctx.user ? ctx.json({ userId: ctx.user.id }) : ctx.json({ anon: true }, 401))
    app.get('/login', (ctx: any) => { ctx.setCookie('session', 'tok-1', { httpOnly: true, sameSite: 'lax' }); return ctx.json({}) })
    app.get('/logout', (ctx: any) => { ctx.setCookie('session', '', { maxAge: 0 }); return ctx.json({}) })
    return app
  }
  const setCookieOf = async (app: any, path: string) =>
    (await app.http.fetch(new Request(`http://localhost${path}`))).headers.get('set-cookie') ?? ''

  it('writes __Host-session, Secure with Path=/, under secure', async () => {
    const app = secureApp(true)
    await app.start()
    expect(app.http.authCookie).toBe('__Host-session')
    const set = await setCookieOf(app, '/login')
    expect(set).toStartWith('__Host-session=tok-1; Path=/')
    expect(set).toContain('; Secure')
    await app.stop()
  })

  it('writes session, not Secure, without it', async () => {
    const app = secureApp(false)
    await app.start()
    expect(app.http.authCookie).toBe('session')
    const set = await setCookieOf(app, '/login')
    expect(set).toStartWith('session=tok-1; Path=/')
    expect(set).not.toContain('Secure')
    await app.stop()
  })

  it('a clear that names no Secure still clears __Host-session', async () => {
    // A browser refuses a __Host- Set-Cookie without Secure, so a clear
    // written as the plain name would leave the session in the jar.
    const app = secureApp(true)
    await app.start()
    const set = await setCookieOf(app, '/logout')
    expect(set).toStartWith('__Host-session=; Path=/; Max-Age=0')
    expect(set).toContain('; Secure')
    await app.stop()
  })

  it('reads only __Host-session under secure', async () => {
    const app = secureApp(true)
    await app.start()
    expect((await hit(app, { cookie: '__Host-session=tok-1' })).status).toBe(200)
    expect((await hit(app, { cookie: 'session=tok-1' })).status).toBe(401)
    const both = await hit(app, { cookie: 'session=planted; __Host-session=tok-1' })
    expect((await both.json()).userId).toBe('alice')
    await app.stop()
  })

  it('reads only session without it', async () => {
    const app = secureApp(false)
    await app.start()
    expect((await hit(app, { cookie: 'session=tok-1' })).status).toBe(200)
    expect((await hit(app, { cookie: '__Host-session=tok-1' })).status).toBe(401)
    await app.stop()
  })

  it('a Secure write the transport was not told of is refused, not written', async () => {
    // The browser would hold __Host-session and the reader would look for
    // session: every sign-in would answer as signed out.
    const app = secureApp(false)
    app.get('/secure-login', (ctx: any) => { ctx.setCookie('session', 'tok-1', { secure: true }); return ctx.json({}) })
    await app.start()
    const res = await app.http.fetch(new Request('http://localhost/secure-login'))
    expect(res.status).toBe(500)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('tok-1')
    await app.stop()
  })

  it('a path other than / is refused under secure', async () => {
    const app = secureApp(true)
    app.get('/scoped', (ctx: any) => { ctx.setCookie('session', 'tok-1', { path: '/app' }); return ctx.json({}) })
    await app.start()
    expect((await app.http.fetch(new Request('http://localhost/scoped'))).status).toBe(500)
    await app.stop()
  })

  it('another cookie keeps its own name and attributes', async () => {
    const app = secureApp(true)
    app.get('/theme', (ctx: any) => { ctx.setCookie('theme', 'dark', { secure: true }); return ctx.json({}) })
    await app.start()
    expect(await setCookieOf(app, '/theme')).toStartWith('theme=dark; Path=/')
    await app.stop()
  })
})

// ── The WebSocket upgrade ────────────────────────────────────────────────

describe('session from a cookie, over the WebSocket upgrade', () => {

  // The upgrade is an ordinary browser request and carries the cookie, so
  // cookie mode has to work here too. If it did not, a cookie-authenticated app
  // would connect as ANONYMOUS and every channel scoped to the user would stay
  // silent — with no error anywhere, because an unauthenticated socket is a
  // legitimate state. That is the failure this test exists for.

  // Port 0, read back after start(). A fixed port here was `FJS-900`: several
  // files in this package bound the same one and bun runs them in ONE process,
  // so an app answered while a previous file's app on that port was still
  // shutting down. Never hard-code a port in this package's tests.
  let PORT = 0

  function connect(headers: Record<string, string>) {
    const ws = new WebSocket(`ws://localhost:${PORT}/sock`, { headers } as any)
    const frames: any[] = []
    ws.onmessage = (e: any) => {
      try { frames.push(JSON.parse(String(e.data))) } catch { frames.push(String(e.data)) }
    }
    const first = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame')), 4000)
      const iv = setInterval(() => {
        if (frames.length) { clearInterval(iv); clearTimeout(timer); resolve(frames[0]) }
      }, 10)
      ws.onerror = () => { clearInterval(iv); clearTimeout(timer); reject(new Error('ws error')) }
    })
    return { ws, first }
  }

  it('the socket knows who you are from the cookie', async () => {
    const app = createApp({
      config: { ...defaultConfig, port: 0 },
      auth: oneTokenAuth('tok-ws', { id: 'wsuser' }),
    })
    app.http.setAuthCookie('session')
    app.ws('/sock', {
      open(ctx: any) { ctx.send(JSON.stringify({ userId: ctx.user?.id ?? null })) },
    })
    await app.start()
    PORT = (app as unknown as { http: { port: number } }).http.port

    try {
      const authed = connect({ cookie: 'session=tok-ws' })
      expect((await authed.first).userId).toBe('wsuser')
      authed.ws.close()

      const anon = connect({ cookie: 'session=wrong' })
      expect((await anon.first).userId).toBeNull()
      anon.ws.close()
    } finally {
      await app.stop()
    }
  }, 15_000)
})
