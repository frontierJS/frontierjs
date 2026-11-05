// authorize.ts
// mountAuthorize(app, { auth, prefix, limiters })
//
// `GET` and `POST /authorize` (`FJS-D1925`): the page a connector sends a
// person to, where they sign in as themselves and approve the client. The
// sign-in is `authenticate` / `completeAuthenticate` (`FJS-D1948`), which prove
// a person and mint no session; the page is `Authorize.mesa`, packed.
//
// Nothing the client sends is shown or followed until its document is fetched
// and the redirect is one that document lists. Before that a refusal is plain
// text, because the page would name a host nothing has verified and a
// redirect would hand the error to an address nobody vouched for
// (RFC 6749 § 4.1.2.1).

import type { App, IAuth, TransportContext } from '@frontierjs/junction'
import { BadRequest, normalizePrefix } from '@frontierjs/junction'
import { render, STYLE_HASH, type AuthorizeProps } from './authorize-page.snapshot.js'
import {
  fetchClientDocument, checkRedirect, isLoopbackOnly, clientHost,
  type ClientDocument, type ClientFetchOptions,
} from './clients.ts'
import { ClientRefusedError } from './errors.ts'
import type { ConsentVerbs } from './auth.ts'

export type AuthorizeAuth = IAuth & ConsentVerbs & {
  clients:              ClientFetchOptions
  authenticate:         NonNullable<IAuth['authenticate']>
  completeAuthenticate: NonNullable<IAuth['completeAuthenticate']>
  issueAuthorizationCode: NonNullable<IAuth['issueAuthorizationCode']>
}

/** Whether this auth can serve `/authorize`: a third-party IAuth, or one with no `encryptionKey`, cannot. */
export function canAuthorize(auth: IAuth): auth is AuthorizeAuth {
  const a = auth as Partial<AuthorizeAuth>
  return typeof a.issueConsent === 'function' && typeof a.redeemConsent === 'function'
    && typeof a.authenticate === 'function' && typeof a.completeAuthenticate === 'function'
    && typeof a.issueAuthorizationCode === 'function' && !!a.clients
}

type Limiter = (ctx: TransportContext) => void

// ─── the request ──────────────────────────────────────────────────────────────

// The OAuth parameters, carried as hidden inputs from step to step and graded
// again on every POST: the form is the client's request as the browser holds
// it, and a browser can be made to send anything.
const REQUEST_FIELDS = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'resource'] as const
// The page's own. `login`'s reader does not declare these, so `/auth/login`
// never starts reading a `ticket`.
const PAGE_FIELDS    = ['step', 'email', 'password', 'challenge', 'code', 'ticket', 'decision'] as const

type RequestField = typeof REQUEST_FIELDS[number]
type PageField    = typeof PAGE_FIELDS[number]
type Params       = Partial<Record<RequestField | PageField, string>>

interface Admitted {
  doc:      ClientDocument
  redirect: URL
  request:  Record<RequestField, string>
}

/** The client and its redirect, verified, and the rest graded; or the Response that refuses them. */
async function admit(app: App, auth: AuthorizeAuth, req: Request, p: Params): Promise<Admitted | Response> {
  const clientId = p.client_id ?? ''
  let doc: ClientDocument
  try { doc = await fetchClientDocument(clientId, auth.clients) }
  catch (err) {
    if (err instanceof ClientRefusedError) return plain(400, err.message)
    throw err
  }

  const redirectUri = p.redirect_uri ?? ''
  if (!checkRedirect(doc, redirectUri)) return plain(400, `redirect_uri is not one ${clientId} lists, so nothing was sent to it`)
  const redirect = new URL(redirectUri)

  // From here the client is known and its redirect is its own, so an error
  // goes back to it (RFC 6749 § 4.1.2.1).
  const back = (error: string, description: string) => toRedirect(redirect, { error, error_description: description, state: p.state })
  if (p.response_type !== 'code')         return back('unsupported_response_type', 'response_type must be code')
  if (p.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256')
  if (!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? '')) return back('invalid_request', 'code_challenge must be an S256 challenge')
  const resource = mcpResource(app, req)
  if (!p.resource)                        return back('invalid_request', `resource is required: ${resource}`)
  if (p.resource !== resource)            return back('invalid_target', `resource must be ${resource}`)

  const request = Object.fromEntries(REQUEST_FIELDS.map(k => [k, p[k] ?? ''])) as Record<RequestField, string>
  return { doc, redirect, request }
}

/**
 * The `resource` a token here is for: the string `@frontierjs/mcp`'s
 * protected-resource document states. The mcp plugin's `path` option is not
 * visible from auth, so this is its default, `/mcp`.
 */
export function mcpResource(app: App, req: Request): string {
  const origin = app.config.publicUrl ?? new URL(req.url).origin
  return `${origin}${normalizePrefix(app.config.apiPrefix)}/mcp`
}

/** One value per name; a repeated parameter is refused (RFC 6749 § 3.1). */
function queryParams(req: Request): Params | Response {
  const search = new URL(req.url).searchParams
  const out: Params = {}
  for (const key of REQUEST_FIELDS) {
    const all = search.getAll(key)
    if (all.length > 1) return plain(400, `${key} was sent more than once`)
    if (all.length)     out[key] = all[0]
  }
  return out
}

/** The POST body, through its own declared list (`FJS-296`): a key not named here does not travel. */
function formParams(ctx: TransportContext): Params {
  const raw = ctx.body
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('body must be a form')
  const out: Params = {}
  for (const key of [...REQUEST_FIELDS, ...PAGE_FIELDS]) {
    const value = (raw as Record<string, unknown>)[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw new BadRequest(`${key} must be a string`)
    out[key] = value
  }
  return out
}

// ─── the answers ──────────────────────────────────────────────────────────────

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

function toRedirect(redirect: URL, params: Record<string, string | undefined>): Response {
  const target = new URL(redirect)
  for (const [k, v] of Object.entries(params)) if (v) target.searchParams.set(k, v)
  return new Response(null, { status: 302, headers: { location: String(target), 'cache-control': 'no-store' } })
}

/**
 * The page. `form-action` names the checked redirect's origin because
 * Chromium holds the 302 after a POST to it; junction sets its own CSP only
 * where a response has none, so this one is the one that arrives.
 */
function page(
  app: App, req: Request, a: Admitted,
  step: AuthorizeProps['step'], extra: Record<string, string> = {}, error: string | null = null, status = 200,
): Response {
  const html = render({
    app:          String(app.config.name ?? ''),
    client:       { host: clientHost(a.request.client_id), loopback: isLoopbackOnly(a.doc) },
    redirectHost: a.redirect.host,
    step,
    error,
    action:       new URL(req.url).pathname,
    fields:       { ...a.request, step, ...extra },
  })
  return new Response(html, { status, headers: {
    'content-type':            'text/html; charset=utf-8',
    'cache-control':           'no-store',
    'content-security-policy': `default-src 'none'; style-src '${STYLE_HASH}'; form-action 'self' ${a.redirect.origin}; frame-ancestors 'none'; base-uri 'none'`,
  } })
}

// ─── the routes ───────────────────────────────────────────────────────────────

export function mountAuthorize(app: App, opts: { auth: AuthorizeAuth, prefix: string, limiters: { login: Limiter, account: Limiter } }): void {
  const { auth, prefix, limiters } = opts
  const requestOf = (ctx: TransportContext) => (ctx.$raw as { $req: Request }).$req

  app.get(`${prefix}/authorize`, async (ctx: TransportContext) => {
    const req = requestOf(ctx)
    const p   = queryParams(req)
    if (p instanceof Response) return p
    const a = await admit(app, auth, req, p)
    return a instanceof Response ? a : page(app, req, a, 'password')
  })

  app.post(`${prefix}/authorize`, async (ctx: TransportContext) => {
    const req = requestOf(ctx)
    const p   = formParams(ctx)
    const a   = await admit(app, auth, req, p)
    if (a instanceof Response) return a
    const binding = { clientId: a.request.client_id, redirectUri: a.request.redirect_uri, resource: a.request.resource, challenge: a.request.code_challenge }

    const consent = async (userId: string) => {
      const { ticket } = await auth.issueConsent({ ...binding, userId })
      return page(app, req, a, 'consent', { ticket })
    }

    // A refused proof re-renders its step and never answers 401, which sierra
    // reads as a sign-out (`FJS-1088`); a throttle keeps its 429.
    const refused = (err: unknown, step: AuthorizeProps['step'], extra: Record<string, string> = {}) => {
      const status = (err as { status?: number })?.status
      if (typeof status !== 'number' || status < 400 || status >= 500) throw err
      return page(app, req, a, step, extra, (err as Error).message, status === 429 ? 429 : 200)
    }

    if (p.step === 'totp') {
      // The challenge rides the form as `/login/challenge` takes it in a body:
      // it is single use and lives minutes, and the consent ticket it leads to
      // is bound to this client's PKCE challenge, which a cross-site poster
      // does not know.
      const challenge = p.challenge ?? ''
      try {
        limiters.login(ctx)
        return await consent((await auth.completeAuthenticate(challenge, p.code ?? '')).userId)
      } catch (err) { return refused(err, 'totp', { challenge }) }
    }

    if (p.step === 'consent') {
      const spent = await auth.redeemConsent({ ...binding, ticket: p.ticket ?? '' })
      if (!spent) return page(app, req, a, 'password', {}, 'This approval has expired or was already used. Sign in again.')
      if (p.decision !== 'allow') return toRedirect(a.redirect, { error: 'access_denied', state: a.request.state })
      const { code } = await auth.issueAuthorizationCode({ ...binding, userId: spent.userId })
      return toRedirect(a.redirect, { code, state: a.request.state })
    }

    try {
      limiters.login(ctx)
      if (!p.email) throw new BadRequest('email is required')
      limiters.account(ctx)
      if (!p.password) throw new BadRequest('password is required')
      const proved = await auth.authenticate(p.email, p.password)
      if ('challenge' in proved) return page(app, req, a, 'totp', { challenge: proved.challenge })
      return await consent(proved.userId)
    } catch (err) { return refused(err, 'password') }
  })
}
