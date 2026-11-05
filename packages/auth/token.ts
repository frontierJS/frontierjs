// token.ts
// mountToken(app, { auth, prefix, limiter })
//
// `POST /token` (RFC 6749 § 3.2): where a connector trades the code
// `/authorize` sent it, and later its refresh token, for an access token.
// The client is public (`token_endpoint_auth_method` `none`), so nothing here
// authenticates it; the code's PKCE verifier and the refresh token's binding
// to its `client_id` are what a stranger lacks.
//
// The answers are RFC 6749 § 5's JSON and never a page or a redirect: the
// caller is the connector's server, not a browser.

import type { App, IAuth, TransportContext } from '@frontierjs/junction'
import type { AuthorizedAppTokens, AuthorizedAppVerbs } from './auth.ts'
import { mcpResource } from './authorize.ts'
import { InvalidGrantError } from './errors.ts'

export type TokenAuth = IAuth & AuthorizedAppVerbs & {
  redeemAuthorizationCode: NonNullable<IAuth['redeemAuthorizationCode']>
}

/** Whether this auth can serve `/token`: one with no `encryptionKey` holds neither verb. */
export function canIssueTokens(auth: IAuth): auth is TokenAuth {
  const a = auth as Partial<TokenAuth>
  return typeof a.authorizeApp === 'function' && typeof a.refreshAuthorizedApp === 'function'
    && typeof a.redeemAuthorizationCode === 'function'
}

type Limiter = (ctx: TransportContext) => void

const FIELDS = ['grant_type', 'code', 'code_verifier', 'client_id', 'redirect_uri', 'resource', 'refresh_token'] as const
type Params  = Partial<Record<typeof FIELDS[number], string>>

/** A refusal RFC 6749 § 5.2 names; `answerRefusal` is the one place it becomes a response. */
class TokenRefusal extends Error {
  constructor(readonly error: string, message: string) { super(message) }
}

// ─── the request ──────────────────────────────────────────────────────────────

/**
 * The form body, one value per name (RFC 6749 § 3.2). A JSON body is refused
 * rather than read: a client that sends one is not the client the spec
 * describes, and accepting it would make this route a second shape to keep.
 */
function tokenParams(ctx: TransportContext, req: Request): Params {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/x-www-form-urlencoded')
    throw new TokenRefusal('invalid_request', 'the body must be application/x-www-form-urlencoded')
  const raw = (ctx.body ?? {}) as Record<string, unknown>
  const out: Params = {}
  for (const key of FIELDS) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) throw new TokenRefusal('invalid_request', `${key} was sent more than once`)
    if (typeof value !== 'string') throw new TokenRefusal('invalid_request', `${key} must be a string`)
    out[key] = value
  }
  return out
}

function required(p: Params, key: keyof Params, error = 'invalid_request'): string {
  const value = p[key]
  if (!value) throw new TokenRefusal(error, `${key} is required`)
  return value
}

// ─── the grants ───────────────────────────────────────────────────────────────

async function grant(app: App, auth: TokenAuth, ctx: TransportContext, req: Request, p: Params): Promise<AuthorizedAppTokens> {
  const audience = mcpResource(app, req)
  const grantType = required(p, 'grant_type')

  if (grantType === 'authorization_code') {
    const code        = required(p, 'code')
    const verifier    = required(p, 'code_verifier')
    const clientId    = required(p, 'client_id', 'invalid_client')
    const redirectUri = required(p, 'redirect_uri')
    const resource    = required(p, 'resource')
    if (resource !== audience) throw new TokenRefusal('invalid_target', `resource must be ${audience}`)
    const { userId } = await auth.redeemAuthorizationCode({ code, verifier, clientId, redirectUri, resource })
    return auth.authorizeApp({
      userId, clientId, audience,
      ...(ctx.ip ? { ipAddress: ctx.ip } : {}),
      ...(req.headers.get('user-agent') ? { userAgent: req.headers.get('user-agent')! } : {}),
    })
  }

  if (grantType === 'refresh_token') {
    const refreshToken = required(p, 'refresh_token')
    const clientId     = required(p, 'client_id', 'invalid_client')
    if (p.resource !== undefined && p.resource !== audience) throw new TokenRefusal('invalid_target', `resource must be ${audience}`)
    return auth.refreshAuthorizedApp({ refreshToken, clientId, audience })
  }

  throw new TokenRefusal('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
}

// ─── the answers ──────────────────────────────────────────────────────────────

// RFC 6749 § 5.1: a token must not sit in any cache between here and the client.
const NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'pragma': 'no-cache' }

function answer(tokens: AuthorizedAppTokens): Response {
  return new Response(JSON.stringify({
    access_token:  tokens.accessToken,
    token_type:    'Bearer',
    expires_in:    tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  }), { status: 200, headers: NO_STORE })
}

/** The one mapping from a refusal to RFC 6749 § 5.2's 400. Anything else is not a refusal, and rethrows. */
function answerRefusal(err: unknown): Response {
  const [error, description] =
    err instanceof TokenRefusal      ? [err.error, err.message] :
    err instanceof InvalidGrantError ? ['invalid_grant', err.message] :
    [null, null]
  if (!error) throw err
  return new Response(JSON.stringify({ error, error_description: description }), { status: 400, headers: NO_STORE })
}

// ─── the route ────────────────────────────────────────────────────────────────

export function mountToken(app: App, opts: { auth: TokenAuth, prefix: string, limiter: Limiter }): void {
  const { auth, prefix, limiter } = opts

  app.post(`${prefix}/token`, async (ctx: TransportContext) => {
    const req = (ctx.$raw as { $req: Request }).$req
    // Outside the mapping: a throttle keeps junction's 429 and its Retry-After.
    limiter(ctx)
    try {
      return answer(await grant(app, auth, ctx, req, tokenParams(ctx, req)))
    } catch (err) { return answerRefusal(err) }
  })
}
