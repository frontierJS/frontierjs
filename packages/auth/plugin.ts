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

import type { IAuth, SessionContext, App, Plugin, TransportContext } from '@frontierjs/junction'
import { parseTtl, Unauthorized, BadRequest, rateLimitHook }        from '@frontierjs/junction'
import type { AuthPluginOptions }                                   from './types.ts'
import { createAuthServices }                                       from './services.ts'
import { OAUTH_STATE_COOKIE }                                      from './oauth.ts'
import type { AuthOAuth }                                          from './oauth.ts'

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
): Plugin {

  const {
    prefix            = '/auth',
    cookieAuth        = false,
    loginRateLimit    = { max: 10, window: '15 minutes' },
    registerRateLimit = { max: 5,  window: '15 minutes' },
    services          = {},
    oauth,
  } = opts

  // sessionTtl: prefer the explicit plugin opt, then read from the auth
  // instance (_sessionTtl is set by createLitestoneAuth), then fall back to default.
  // This ensures the cookie maxAge stays in sync with the DB session expiry
  // without requiring the caller to pass sessionTtl to both call sites.
  const sessionTtl   = opts.sessionTtl ?? (auth as IAuth & { _sessionTtl?: string })._sessionTtl ?? '30 days'
  const cookieMaxAge = Math.floor(parseTtl(sessionTtl) / 1000)

  const loginLimiter    = rateLimitHook(loginRateLimit)
  const registerLimiter = rateLimitHook(registerRateLimit)
  // Starting a flow writes a row, unauthenticated, once per click.
  const oauthLimiter    = rateLimitHook(oauth?.rateLimit ?? { max: 20, window: '15 minutes' })

  // The auth instance's OAuth half, feature-detected rather than required: a
  // third-party IAuth provider has none, and `oauth:` configured against one is
  // a mistake worth naming at boot rather than a 500 on first click.
  const oauthAuth       = auth as Partial<AuthOAuth>
  const oauthPath       = `${prefix}/oauth`

  return {
    name: '@frontierjs/auth',

    // Both limiters own a sweep timer. They are unref'd so they never hold the
    // process open, but a test process that builds many apps would otherwise
    // leave one running per app against a live counter map.
    shutdown() {
      ;(loginLimiter    as unknown as { dispose?(): void }).dispose?.()
      ;(registerLimiter as unknown as { dispose?(): void }).dispose?.()
      ;(oauthLimiter    as unknown as { dispose?(): void }).dispose?.()
    },

    // ── The service half ────────────────────────────────────────────
    //
    // In boot() rather than register(), because that is the first phase where
    // the app's OWN services all exist: autoload runs before boot-plugins, so
    // a collision can be seen from here whichever order the two were written
    // in. The registry is a Map — without this check one of the two silently
    // replaces the other and the app serves whichever registered last.
    boot(app: App) {
      // ── Is the URL we hand the provider the URL that is mounted? ──────
      //
      // Asked in boot() and not at registration, because that is the first
      // phase where `junction.config.js` has been read (`FJS-431`) — and
      // `apiPrefix` is exactly the value that would move the route after the
      // fact. Nothing else can catch this: the redirect URI is matched as an
      // exact string BY THE PROVIDER, so a mismatch fails 100% of the time,
      // for everyone, and is visible only on Google's error page.
      if (oauth) {
        const mounted  = (app.http?.router?.routePaths?.('GET') ?? []) as string[]
        const expected = callbackPath(app, prefix, '{provider}')
        if (!mounted.includes(expected)) {
          const found = mounted.filter(p => p.includes('/oauth/') && p.endsWith('/callback'))
          throw new Error(
            `[auth] OAuth callback is mounted at ${found[0] ?? '(nowhere)'} ` +
            `but the redirect URI this app gives its providers resolves to ${expected}. ` +
            `A provider matches that string exactly, so every sign-in would fail. ` +
            `Check apiPrefix and createAuthPlugin's prefix.`
          )
        }
        // ── OAuth needs cookie mode, and the alternative is silent ────
        //
        // The callback is a browser REDIRECT. It can hand back a cookie, and it
        // has nowhere to put a bearer token — a token on the URL is a thirty-day
        // credential written into browser history, which is refused, and the
        // short-lived-code exchange that would replace it is not built.
        //
        // So without cookieAuth the flow runs perfectly, sets nothing, and
        // redirects a person who is not signed in to a page that will not say
        // why. Refused here rather than discovered there.
        if (!cookieAuth) {
          throw new Error(
            `[auth] { oauth } requires { cookieAuth: true }. The OAuth callback is a browser ` +
            `redirect and can only hand back a session as a cookie — with Bearer sessions the ` +
            `flow would complete and sign nobody in.`
          )
        }

        if (!oauthAuth.oauthBegin) {
          throw new Error(
            `[auth] createAuthPlugin was given { oauth } but this IAuth provider has no OAuth support. ` +
            `Use createLitestoneAuth with { oauthProviders }, or drop the oauth block.`
          )
        }
      }

      if (services === false) return

      for (const svc of createAuthServices(auth, services)) {
        if (app.services?.has?.(svc.name)) {
          throw new Error(
            `[auth] service '${svc.name}' is already registered by this app. ` +
            `Rename or drop auth's — createAuthPlugin(auth, { services: { ` +
            `${svc.name === 'api-keys' ? 'apiKeys' : svc.name}: false } }).`
          )
        }
        app.services.register(svc)
      }
    },

    register(app: App) {

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

      app.post(`${prefix}/register`, async (ctx: TransportContext) => {
        registerLimiter(ctx)

        const { email, password, name } = body(ctx)
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

      app.post(`${prefix}/login`, async (ctx: TransportContext) => {
        loginLimiter(ctx)

        const { email, password } = body(ctx)
        if (!email)    throw new BadRequest('email is required')
        if (!password) throw new BadRequest('password is required')

        const result = await auth.login(email, password)
        return respond(ctx, result, cookieAuth, cookieMaxAge)
      })

      // ── POST /auth/logout ────────────────────────────────────────────

      app.post(`${prefix}/logout`, async (ctx: TransportContext) => {
        const token = extractToken(ctx)
        if (token) await auth.logout(token)
        if (cookieAuth) clearCookie(ctx)
        return ctx.json({ ok: true })
      })

      // GET /auth/me was here. It is `account.get('me')` now — a request that
      // can be refused for want of a session is a service, and as a service it
      // gets the hook pipeline, the audit trail and the WebSocket transport
      // that a hand-rolled route never had (DECISIONS.md § API design).

      // ── POST /auth/password-reset/request ────────────────────────────
      // Always returns ok — never reveals whether the email is registered.

      app.post(`${prefix}/password-reset/request`, async (ctx: TransportContext) => {
        const { email } = body(ctx)
        if (!email) throw new BadRequest('email is required')

        if (auth.requestPasswordReset) {
          await auth.requestPasswordReset(email)
        }

        return ctx.json({ ok: true })
      })

      // ── POST /auth/password-reset/confirm ────────────────────────────

      app.post(`${prefix}/password-reset/confirm`, async (ctx: TransportContext) => {
        const { token, password } = body(ctx)
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

      app.post(`${prefix}/email/verify/request`, async (ctx: TransportContext) => {
        if (!ctx.user) throw new Unauthorized('Authentication required')

        const user = ctx.user as SessionContext

        if (auth.requestEmailVerification) {
          await auth.requestEmailVerification(user.userId)
        }

        return ctx.json({ ok: true })
      })

      // ── GET /auth/email/verify?token= ────────────────────────────────

      app.get(`${prefix}/email/verify`, async (ctx: TransportContext) => {
        const token = ctx.query?.token as string | undefined
        if (!token) throw new BadRequest('token is required')

        if (!auth.verifyEmail) {
          throw new BadRequest('Email verification not supported by this auth provider')
        }

        const user = await auth.verifyEmail(token)
        return ctx.json({ ok: true, user })
      })

      // ── GET /auth/oauth ──────────────────────────────────────────────
      //
      // What a sign-in screen has to know before it can draw anything: which
      // providers this app is actually configured for. Mounted whether or not
      // `oauth` is configured, and answering `[]` when it is not, because *this
      // app has no providers* is a real answer and a 404 is not one a screen
      // can render — a client that had to treat "not found" as "none" could not
      // tell it apart from a wrong prefix.
      //
      // Unauthenticated, because the page that asks has no session by
      // definition, and not secret: the same names are on the sign-in page of
      // every site that offers one.

      app.get(oauthPath, async (ctx: TransportContext) =>
        ctx.json({ providers: oauth ? (oauthAuth.oauthProviderNames?.() ?? []) : [] })
      )

      // ── The OAuth pair ───────────────────────────────────────────────
      //
      // Not like the seven above, and the difference is the caller: those
      // answer JSON to a `fetch()`, and these are BROWSER NAVIGATIONS — a link
      // somebody clicks, and a redirect the provider sends their address bar
      // to. So both answer 302s, and a refusal has to be a redirect as well. A
      // 400 with a JSON body would leave a person who clicked *Deny* at Google
      // looking at `{"error":...}` in their URL bar.
      //
      // `{provider}`, not `:provider` — junction's raw routes take braces, and
      // a colon registers as a LITERAL segment which then 404s forever.

      if (oauth) {

        app.get(`${oauthPath}/{provider}`, async (ctx: TransportContext) => {
          oauthLimiter(ctx)
          const provider = String(ctx.route?.provider ?? '')

          if (!oauthAuth.oauthBegin) return oauthFailure(ctx, oauth, 'unavailable')

          try {
            const { authorizeUrl, state } = await oauthAuth.oauthBegin(provider, {
              redirectUri: callbackUri(app, prefix, oauth.publicUrl, provider),
              returnTo:    ctx.query?.returnTo ? String(ctx.query.returnTo) : null,
            })

            // The browser half of the state. A flow record found by the state
            // value ALONE is login CSRF: an attacker starts a flow, keeps their
            // own code and state, and hands the callback URL to somebody else,
            // who is then signed in as the attacker in their own browser.
            //
            // `lax`, never `strict`: the callback is a cross-site top-level GET
            // navigation from the provider and `strict` withholds the cookie on
            // exactly that, so the flow would fail every single time.
            ctx.setCookie?.(OAUTH_STATE_COOKIE, state, {
              httpOnly: true,
              sameSite: 'lax',
              secure:   process.env.NODE_ENV === 'production',
              maxAge:   600,
              // callbackPath and NOT `${oauthPath}/...`: a cookie Path is
              // matched against the URL the browser actually requests, which
              // carries apiPrefix. Scoped without it the cookie is never sent
              // to the callback at all, so every sign-in fails the state check
              // — and it fails the same way a real attack does, which is the
              // worst possible thing for it to look like.
              path:     callbackPath(app, prefix, provider),
            })

            return ctx.redirect!(authorizeUrl)
          } catch {
            return oauthFailure(ctx, oauth, 'unavailable')
          }
        })

        app.get(`${oauthPath}/{provider}/callback`, async (ctx: TransportContext) => {
          const provider = String(ctx.route?.provider ?? '')
          const state    = ctx.query?.state ? String(ctx.query.state) : ''
          const code     = ctx.query?.code  ? String(ctx.query.code)  : ''
          const cookiePath = callbackPath(app, prefix, provider)

          // However this ends, the flow is over: the cookie is single use, and
          // leaving it set means the next visit carries a state with no row.
          ctx.setCookie?.(OAUTH_STATE_COOKIE, '', { maxAge: 0, path: cookiePath })

          // The person clicked Deny, or the provider refused. Not an error on
          // our side, and the most common non-happy path there is.
          if (ctx.query?.error)         return oauthFailure(ctx, oauth, 'denied')
          if (!code || !state)          return oauthFailure(ctx, oauth, 'state')
          if (!oauthAuth.oauthCallback) return oauthFailure(ctx, oauth, 'unavailable')

          let identity, returnTo
          try {
            const done = await oauthAuth.oauthCallback(provider, {
              code,
              state,
              cookieState: ctx.cookies?.[OAUTH_STATE_COOKIE] ?? null,
              redirectUri: callbackUri(app, prefix, oauth.publicUrl, provider),
            })
            identity = done.identity
            returnTo = done.returnTo
          } catch {
            // One code for every refusal, deliberately. Which one it was is in
            // the audit trail; telling the browser whether a state existed, or
            // whether an exchange failed, is an oracle handed to whoever can
            // reach the URL.
            return oauthFailure(ctx, oauth, 'state')
          }

          if (!oauthAuth.oauthResolve) return oauthFailure(ctx, oauth, 'unavailable')

          let resolved
          try {
            resolved = await oauthAuth.oauthResolve(provider, identity)
          } catch {
            return oauthFailure(ctx, oauth, 'exchange')
          }

          // An account already holds this address and has not proved it owns
          // it. A distinct code, and the address-existence it discloses is
          // already disclosed by POST /auth/register, which answers 409
          // EmailTakenError — so hiding it here would buy nothing and leave a
          // person who cannot sign in with no idea why.
          if (resolved.outcome === 'proof-required') {
            return oauthFailure(ctx, oauth, 'link_required')
          }

          // The same cookie every other route in this plugin sets, through the
          // same options — this is a sign-in and there is no second kind.
          if (cookieAuth && typeof ctx.setCookie === 'function') {
            ctx.setCookie('session', resolved.token, {
              httpOnly: true,
              sameSite: 'lax',
              secure:   process.env.NODE_ENV === 'production',
              maxAge:   cookieMaxAge,
            })
          }

          // `returnTo` was checked against the app's allow-list when the flow
          // STARTED and written down only if it passed, so there is nothing
          // left to decide here.
          return ctx.redirect!(returnTo ?? '/')
        })

        // ── Proving the address, and attaching after ──────────────────
        //
        // Reached from a link in an email, so a browser navigation again — and
        // the LAST step of the flow rather than a second one: it signs the
        // person in, because presenting this token is the proof the account was
        // asked for.
        app.get(`${oauthPath}/link/confirm`, async (ctx: TransportContext) => {
          oauthLimiter(ctx)
          const token = ctx.query?.token ? String(ctx.query.token) : ''

          if (!token)                        return oauthFailure(ctx, oauth, 'state')
          if (!oauthAuth.confirmOAuthLink)   return oauthFailure(ctx, oauth, 'unavailable')

          let issued
          try {
            issued = await oauthAuth.confirmOAuthLink(token)
          } catch {
            return oauthFailure(ctx, oauth, 'state')
          }

          if (cookieAuth && typeof ctx.setCookie === 'function') {
            ctx.setCookie('session', issued.token, {
              httpOnly: true,
              sameSite: 'lax',
              secure:   process.env.NODE_ENV === 'production',
              maxAge:   cookieMaxAge,
            })
          }

          return ctx.redirect!('/')
        })
      }

    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// `ctx.body` is `unknown` — it is whatever a caller posted, and these routes are
// upstream of every validator the app has. One reader, so the assertion that it
// is shaped like this is written once rather than at each of the four handlers.
//
// It CHECKS rather than asserts, because these routes have no validator in front
// of them: a service gets `autoValidate` off the model's JSON Schema, and a raw
// route by definition does not. `{ "email": { "contains": "@" } }` was reaching
// `sys.user.findFirst({ where: { email } })` as a Litestone where-operator, so
// the address became a FILTER — with a correct password it signed the caller in
// as the first matching row, and `startsWith` walked the user table without
// knowing a single address (FJS-296).
//
// So a declared field is a string or the request is a 400 naming it, and a key
// not declared here does not travel. Presence is still each handler's own
// question — this one only answers what KIND of thing arrived.
const BODY_FIELDS = ['email', 'password', 'name', 'token'] as const

interface AuthBody {
  email?:    string
  password?: string
  name?:     string
  token?:    string
}

function body(ctx: TransportContext): AuthBody {
  const raw = ctx.body
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequest('body must be a JSON object')
  }

  const out: AuthBody = {}
  for (const key of BODY_FIELDS) {
    const value = (raw as Record<string, unknown>)[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw new BadRequest(`${key} must be a string`)
    out[key] = value
  }
  return out
}

function respond(
  ctx:         TransportContext,
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

// The optional chains stay although `headers`, `cookies` and `setCookie` are all
// required on a TransportContext: these run against whatever the transport in
// front of them built, and a hand-made context in a test has never had to be a
// whole one.
function extractToken(ctx: TransportContext): string | null {
  const header = ctx.headers?.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice(7).trim()
  return ctx.cookies?.session ?? null
}

function clearCookie(ctx: TransportContext): void {
  ctx.setCookie?.('session', '', { maxAge: 0 })
}

// ─── OAuth helpers ────────────────────────────────────────────────────────

/**
 * The redirect URI, exactly as the provider has it on file.
 *
 * Built from `app.config.apiPrefix` at REQUEST time rather than closed over at
 * registration, because a plugin's `register()` runs synchronously inside
 * `configure()` and `junction.config.js` is not loaded until the `load-config`
 * start phase — so a value read at registration is the config as it was BEFORE
 * the file (`FJS-431`). An apiPrefix that arrives from the config file would
 * move the route and leave this string pointing at the old one, and a provider
 * matches it as an exact string.
 */
function callbackPath(app: App, prefix: string, provider: string): string {
  const apiPrefix = String((app as { config?: { apiPrefix?: string } }).config?.apiPrefix ?? '')
    .replace(/\/+$/, '')
  return `${apiPrefix}${prefix}/oauth/${provider}/callback`
}

function callbackUri(app: App, prefix: string, publicUrl: string, provider: string): string {
  // String concatenation and deliberately not `new URL(...).pathname`: the boot
  // check asks this for the literal `{provider}`, and URL percent-encodes the
  // braces into %7B…%7D, so the comparison it exists to make never matched.
  return `${publicUrl.replace(/\/+$/, '')}${callbackPath(app, prefix, provider)}`
}

/**
 * Send the browser somewhere it can render a message.
 *
 * The code is coarse on purpose and is never the provider's own text, which is
 * attacker-influenced and headed for a screen.
 */
function oauthFailure(
  ctx:    TransportContext,
  oauth:  { errorRedirect?: string },
  code:   'denied' | 'state' | 'exchange' | 'unavailable' | 'link_required',
): Response {
  const target = oauth.errorRedirect ?? '/'
  const join   = target.includes('?') ? '&' : '?'
  return ctx.redirect!(`${target}${join}oauth_error=${code}`)
}
