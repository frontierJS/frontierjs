// sink-oauth.ts — Google's OAuth 2.0 endpoints, the least a grant flow needs.
//
// Mounted by sink.ts on the same listener as `/calendar/v3/*`: an access token
// minted here is accepted by the calendar stand-in for the account that
// consented, so one listener plays Connect, refresh, a Calendar call and a
// revoke. conduit-oidc's sink plays a different leg and cannot stand in for
// this one: it accepts `client_secret_basic` only (auth's code exchange posts
// the secret in the body), rotates every refresh token (Microsoft's shape, not
// Google's), has no revoke endpoint, and mints tokens no Calendar stand-in knows.
//
// Google spreads these over three hosts; here they share one:
//   GET  /o/oauth2/v2/auth   consents at once, as `login_hint`'s account or the first one
//   POST /o/oauth2/token     authorization_code (PKCE S256) and refresh_token
//   POST /o/oauth2/revoke    form `token`, a refresh or an access token
//   GET  /o/oauth2/userinfo  openidconnect.googleapis.com/v1/userinfo
// `POST /_sink/oauth/revoke { email }` is the user removing the app at
// myaccount.google.com; `GET /_sink/oauth` lists the grants.
//
// As Google does: a refresh token only when the authorize request said
// `access_type=offline`; no rotation on refresh; `invalid_grant` for a revoked
// or unknown refresh token; revoking either token of a grant revokes the grant.
// Client authentication may be the body or Basic, both of which Google takes.

import { createHash, randomBytes } from 'node:crypto'
import type { SeenRequest } from './sink.ts'

export const OAUTH_CLIENT_ID     = 'sink-client.apps.googleusercontent.com'
export const OAUTH_CLIENT_SECRET = 'GOCSPX-sink-secret'

export interface OAuthSinkOptions {
  clientId?:       string
  clientSecret?:   string
  accessTokenTtl?: number
}

export interface OAuthHost {
  seen:    SeenRequest[]
  json(body: unknown, status?: number, headers?: Record<string, string>): Response
  /** The calendar account for an address, by the token the calendar stand-in keys it on. */
  accountToken(email: string): string | null
  firstEmail(): string | null
  /** Minted access token → that account's token; the calendar stand-in reads it. */
  aliases: Map<string, string>
}

export interface SinkGrant { email: string; scope: string; offline: boolean; refreshToken: string | null; revoked: boolean; accessTokens: string[] }

export interface OAuthSinkState {
  grants: SinkGrant[]
  /** Revokes every live grant for an address, as the user would at their Google account. */
  revokeFor(email: string): number
  handle(req: Request): Promise<Response | null>
}

interface PendingCode { email: string; scope: string; offline: boolean; challenge: string; redirectUri: string; clientId: string }

const b64url = (b: Buffer) => b.toString('base64url')
const mint   = (prefix: string) => `${prefix}${b64url(randomBytes(18))}`

export function createOAuthSink(host: OAuthHost, opts: OAuthSinkOptions = {}): OAuthSinkState {
  const { seen, json, aliases } = host
  const clientId     = opts.clientId ?? OAUTH_CLIENT_ID
  const clientSecret = opts.clientSecret ?? OAUTH_CLIENT_SECRET
  const ttl          = opts.accessTokenTtl ?? 3599
  const codes  = new Map<string, PendingCode>()
  const grants: SinkGrant[] = []

  const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status)

  function revoke(g: SinkGrant) {
    g.revoked = true
    for (const t of g.accessTokens) aliases.delete(t)
  }

  function issueAccess(g: SinkGrant): string {
    const at = mint('ya29.sink-')
    const token = host.accountToken(g.email)
    if (token) aliases.set(at, token)
    g.accessTokens.push(at)
    return at
  }

  function clientOf(req: Request, form: URLSearchParams): { id: string; secret: string } {
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
    if (basic) {
      const [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent)
      return { id: id ?? '', secret: secret ?? '' }
    }
    return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? '' }
  }

  async function handle(req: Request): Promise<Response | null> {
    const url  = new URL(req.url)
    const path = url.pathname

    if (path === '/_sink/oauth' && req.method === 'GET') return json({ grants })
    if (path === '/_sink/oauth/revoke' && req.method === 'POST') {
      const { email } = await req.json() as { email: string }
      return json({ revoked: revokeFor(email) })
    }
    if (!path.startsWith('/o/oauth2/')) return null

    const text = req.method === 'POST' ? await req.text() : ''
    seen.push({ method: req.method, path, query: url.search, headers: Object.fromEntries(req.headers), body: text, at: Date.now(), units: 0 })
    const form = new URLSearchParams(text)

    if (path === '/o/oauth2/v2/auth' && req.method === 'GET') {
      const q = url.searchParams
      const redirectUri = q.get('redirect_uri')
      if (q.get('client_id') !== clientId) return oauthError('invalid_client', 'The OAuth client was not found.', 401)
      if (!redirectUri) return oauthError('invalid_request', 'Missing required parameter: redirect_uri')
      if (q.get('response_type') !== 'code') return oauthError('unsupported_response_type', 'response_type must be code')
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return oauthError('invalid_request', 'PKCE S256 is required here')
      const email = q.get('login_hint') ?? host.firstEmail()
      if (!email || !host.accountToken(email)) return oauthError('access_denied', 'no such account')
      const code = mint('4/sink-')
      codes.set(code, { email, scope: q.get('scope') ?? '', offline: q.get('access_type') === 'offline', challenge: q.get('code_challenge')!, redirectUri, clientId })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      back.searchParams.set('scope', q.get('scope') ?? '')
      if (q.get('state') !== null) back.searchParams.set('state', q.get('state')!)
      return new Response(null, { status: 302, headers: { location: back.toString() } })
    }

    if (path === '/o/oauth2/token' && req.method === 'POST') {
      const client = clientOf(req, form)
      if (client.id !== clientId || client.secret !== clientSecret) return oauthError('invalid_client', 'Unauthorized', 401)

      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? ''
        const pending = codes.get(code)
        codes.delete(code)
        if (!pending || pending.clientId !== client.id) return oauthError('invalid_grant', 'Malformed auth code.')
        if (form.get('redirect_uri') !== pending.redirectUri) return oauthError('redirect_uri_mismatch', 'Bad Request')
        const verifier = form.get('code_verifier') ?? ''
        if (b64url(createHash('sha256').update(verifier).digest()) !== pending.challenge) return oauthError('invalid_grant', 'Invalid code verifier.')
        const g: SinkGrant = { email: pending.email, scope: pending.scope, offline: pending.offline, refreshToken: pending.offline ? mint('1//sink-') : null, revoked: false, accessTokens: [] }
        grants.push(g)
        return json({ access_token: issueAccess(g), expires_in: ttl, token_type: 'Bearer', scope: g.scope, ...(g.refreshToken ? { refresh_token: g.refreshToken } : {}) })
      }

      if (form.get('grant_type') === 'refresh_token') {
        const g = grants.find(x => x.refreshToken === form.get('refresh_token'))
        if (!g || g.revoked) return oauthError('invalid_grant', 'Token has been expired or revoked.')
        return json({ access_token: issueAccess(g), expires_in: ttl, token_type: 'Bearer', scope: g.scope })
      }
      return oauthError('unsupported_grant_type', 'Invalid grant_type')
    }

    if (path === '/o/oauth2/revoke' && req.method === 'POST') {
      const token = form.get('token') ?? url.searchParams.get('token') ?? ''
      const g = grants.find(x => !x.revoked && (x.refreshToken === token || x.accessTokens.includes(token)))
      if (!g) return oauthError('invalid_token', 'Token expired or revoked')
      revoke(g)
      return json({})
    }

    if (path === '/o/oauth2/userinfo' && req.method === 'GET') {
      const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const g = grants.find(x => !x.revoked && x.accessTokens.includes(bearer))
      if (!g) return json({ error: 'invalid_request', error_description: 'Invalid Credentials' }, 401)
      return json({ sub: createHash('sha256').update(g.email).digest('hex').slice(0, 21), email: g.email, email_verified: true })
    }
    return null
  }

  function revokeFor(email: string): number {
    const live = grants.filter(g => g.email === email && !g.revoked)
    for (const g of live) revoke(g)
    return live.length
  }

  return { grants, revokeFor, handle }
}
