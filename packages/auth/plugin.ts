// plugin.ts
// createAuthPlugin(auth, opts): Plugin
//
// The transport layer. Mounts /auth/* routes onto the Junction app.
// Calls IAuth — never touches the database directly.
// Email sending is handled by the onX callbacks in createLitestoneAuth opts.
//
// No error→status mapping here. auth.ts throws domain errors carrying a
// numeric `status` (see errors.ts) and Junction's error boundary reads it, so
// the mapping is global rather than per-route. This file used to wrap all 8
// handlers to translate them — which only covered these routes, and left an
// auth error raised from a SERVICE surfacing as a 500.

import type { IAuth, SessionContext, RateLimitHookOptions }   from '@frontierjs/junction'
import { parseTtl, Unauthorized, BadRequest, rateLimitHook } from '@frontierjs/junction'
import type { AuthPluginOptions }                             from './types.ts'

// Rate limiting is junction's `rateLimitHook`, not a copy of it.
//
// This file used to carry its own, on the stated grounds that the shared hook
// "operates on ServiceContext, which has ctx.params.ip" while these routes hold
// a TransportContext with `ctx.ip`. A ServiceContext has no `params` at all, so
// the premise was wrong and the real gap was one accessor — junction's
// `clientIp()` now answers for both shapes, and the hook reaches `auth`
// optionally because a sign-in route has no principal by definition. The copy
// had already drifted: it returned before checking the limit on a fresh bucket,
// so `max: 0` let one request through (FJS-017).

export function createAuthPlugin(
  auth: IAuth,
  opts: AuthPluginOptions = {}
): { name: string; register: (app: any) => void; shutdown: () => void } {

  const {
    prefix            = '/auth',
    cookieAuth        = false,
    loginRateLimit    = { max: 10, window: '15 minutes' },
    registerRateLimit = { max: 5,  window: '15 minutes' },
  } = opts

  // sessionTtl: prefer the explicit plugin opt, then read from the auth
  // instance (_sessionTtl is set by createLitestoneAuth), then fall back to default.
  // This ensures the cookie maxAge stays in sync with the DB session expiry
  // without requiring the caller to pass sessionTtl to both call sites.
  const sessionTtl   = opts.sessionTtl ?? (auth as IAuth & { _sessionTtl?: string })._sessionTtl ?? '30 days'
  const cookieMaxAge = Math.floor(parseTtl(sessionTtl) / 1000)

  const loginLimiter    = rateLimitHook(loginRateLimit)
  const registerLimiter = rateLimitHook(registerRateLimit)

  return {
    name: '@frontierjs/auth',

    // Both limiters own a sweep timer. They are unref'd so they never hold the
    // process open, but a test process that builds many apps would otherwise
    // leave one running per app against a live counter map.
    shutdown() {
      ;(loginLimiter    as unknown as { dispose?(): void }).dispose?.()
      ;(registerLimiter as unknown as { dispose?(): void }).dispose?.()
    },

    register(app: any) {

      // ── Tell the transport to read the cookie we are about to set ────
      //
      // Without this, `cookieAuth: true` set an httpOnly cookie that nothing
      // ever read back: Junction resolved `ctx.user` from `authorization` and
      // `x-api-key` only, so a cookie-only request to any protected route —
      // including this plugin's own GET /auth/me — was 401. The documented
      // mode handed you a session you could not use (FJS-002).
      //
      // Declared HERE rather than asked of the app, so cookie mode is one
      // switch. Requiring the app to also write `config.auth.cookie` would
      // mean the half-configured state reproduces exactly the bug above.
      //
      // Junction keeps the cookie off by default because a cookie travels
      // automatically and a Bearer token does not — the CSRF exposure is
      // opt-in. What makes it safe here is the `SameSite=Lax` set in respond()
      // below: the browser withholds the cookie from cross-site writes.
      if (cookieAuth) app.http?.setAuthCookie?.('session')

      // ── POST /auth/register ──────────────────────────────────────────
      // Plugin-level only — not on IAuth.
      // createUser + login in one step. Issues a session token.
      // Triggers email verification if the IAuth method is implemented.

      app.post(`${prefix}/register`, async (ctx: any) => {
        registerLimiter(ctx)

        const { email, password, name } = ctx.body ?? {}
        if (!email)    throw new BadRequest('email is required')
        if (!password) throw new BadRequest('password is required')

        await auth.createUser({ email, password, name })
        const result = await auth.login(email, password)

        // Trigger email verification if the IAuth implementation supports it.
        // The email is sent via the onEmailVerificationRequested callback
        // configured in createLitestoneAuth opts — not handled here.
        if (auth.requestEmailVerification) {
          await auth.requestEmailVerification(result.user.userId).catch(() => {
            // Non-fatal — user is created and logged in regardless
          })
        }

        return respond(ctx, result, cookieAuth, cookieMaxAge, 201)
      })

      // ── POST /auth/login ─────────────────────────────────────────────

      app.post(`${prefix}/login`, async (ctx: any) => {
        loginLimiter(ctx)

        const { email, password } = ctx.body ?? {}
        if (!email)    throw new BadRequest('email is required')
        if (!password) throw new BadRequest('password is required')

        const result = await auth.login(email, password)
        return respond(ctx, result, cookieAuth, cookieMaxAge)
      })

      // ── POST /auth/logout ────────────────────────────────────────────

      app.post(`${prefix}/logout`, async (ctx: any) => {
        const token = extractToken(ctx)
        if (token) await auth.logout(token)
        if (cookieAuth) clearCookie(ctx)
        return ctx.json({ ok: true })
      })

      // ── GET /auth/me ─────────────────────────────────────────────────

      app.get(`${prefix}/me`, async (ctx: any) => {
        if (!ctx.user) throw new Unauthorized('Authentication required')
        return ctx.json(ctx.user)
      })

      // ── POST /auth/password-reset/request ────────────────────────────
      // Always returns ok — never reveals whether the email is registered.

      app.post(`${prefix}/password-reset/request`, async (ctx: any) => {
        const { email } = ctx.body ?? {}
        if (!email) throw new BadRequest('email is required')

        if (auth.requestPasswordReset) {
          await auth.requestPasswordReset(email)
        }

        return ctx.json({ ok: true })
      })

      // ── POST /auth/password-reset/confirm ────────────────────────────

      app.post(`${prefix}/password-reset/confirm`, async (ctx: any) => {
        const { token, password } = ctx.body ?? {}
        if (!token)    throw new BadRequest('token is required')
        if (!password) throw new BadRequest('password is required')

        if (!auth.confirmPasswordReset) {
          throw new BadRequest('Password reset not supported by this auth provider')
        }

        await auth.confirmPasswordReset(token, password)
        return ctx.json({ ok: true })
      })

      // ── POST /auth/email/verify/request ──────────────────────────────
      // Requires authentication — user must be logged in to request
      // a new verification email.

      app.post(`${prefix}/email/verify/request`, async (ctx: any) => {
        if (!ctx.user) throw new Unauthorized('Authentication required')

        const user = ctx.user as SessionContext

        if (auth.requestEmailVerification) {
          await auth.requestEmailVerification(user.userId)
        }

        return ctx.json({ ok: true })
      })

      // ── GET /auth/email/verify?token= ────────────────────────────────

      app.get(`${prefix}/email/verify`, async (ctx: any) => {
        const token = ctx.query?.token as string | undefined
        if (!token) throw new BadRequest('token is required')

        if (!auth.verifyEmail) {
          throw new BadRequest('Email verification not supported by this auth provider')
        }

        const user = await auth.verifyEmail(token)
        return ctx.json({ ok: true, user })
      })

    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function respond(
  ctx:         any,
  data:        unknown,
  cookieAuth:  boolean,
  cookieMaxAge: number,
  status = 200
): Response {
  const payload = data as { token?: string } | null

  // Cookie mode puts the token in an httpOnly cookie INSTEAD of the body —
  // that is what AuthPluginOptions.cookieAuth documents, and the whole point
  // of httpOnly is that page JavaScript cannot read the token. Returning it
  // in the body as well handed it straight back, defeating the opt-in.
  //
  // Only strip it when the cookie was actually set: if a transport has no
  // setCookie, stripping would leave the caller with no token at all.
  if (cookieAuth && payload?.token && typeof ctx.setCookie === 'function') {
    ctx.setCookie('session', payload.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   cookieMaxAge,
    })
    const { token: _token, ...withoutToken } = payload
    return ctx.json(withoutToken, status)
  }

  return ctx.json(data, status)
}

function extractToken(ctx: any): string | null {
  const header = (ctx.headers?.authorization ?? '') as string
  if (header.startsWith('Bearer ')) return header.slice(7).trim()
  return ctx.cookies?.session ?? null
}

function clearCookie(ctx: any): void {
  ctx.setCookie?.('session', '', { maxAge: 0 })
}
