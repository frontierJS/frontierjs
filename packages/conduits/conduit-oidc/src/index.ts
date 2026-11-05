// @frontierjs/conduit-oidc — OpenID Connect over conduit (FJS-D889, a PROTOCOL
// connector: Google, Microsoft, Apple, Okta, Auth0, Keycloak, Dex and panva's
// oidc-provider all speak this; a vendor's extension stays the app's).
//
// The builder returns a descriptor and installs nothing (FJS-D890); every call
// takes the bound bundle, so the connector runs in a drive with no junction present.
//
// ─── The target is the issuer's ORIGIN, not the issuer ────────────────────
// An issuer with a path (`https://login.microsoftonline.com/<tenant>/v2.0`)
// names endpoints OUTSIDE that path, so the address is the origin and the
// issuer's path is prefixed onto the discovery request alone. Every endpoint
// discovery names is sent as an absolute `address`; one on another origin
// (Google: token `oauth2.googleapis.com`, JWKS `www.googleapis.com`) goes
// through only where the target declares it in `origins`, and conduit refuses
// any other by name (FJS-2730).
//
// ─── Who spends what: one target per credential, one bundle ───────────────
// The token endpoint spends the CLIENT's credential (`client_secret_basic`,
// the `oidc-client-basic` signer) and goes through the `client` target.
// Discovery and JWKS spend nothing and userinfo spends the USER's access
// token, which the caller puts on the request; all three go through the
// `public` target, whose auth is `none`. Conduit has one `auth` per target,
// so two credentials are two targets (FJS-2729). `oidcTargets` builds both from
// one issuer and `bindOidc` binds both; every call takes the bundle and picks
// its own role, so a call cannot be handed the wrong credential (C1 — the
// bundle).

import type { ConduitRequest, ConduitResult, ResponseValidator, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type OidcFailure } from './errors.ts'
import { OIDC_SIGNER } from './signer.ts'
import { b64url } from './jwt.ts'
import type { Discovery, Jwks, TokenSet, UserInfo } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './signer.ts'
export * from './verify.ts'
export * from './resolver.ts'
export { parseJwt, b64url, unb64url, generateKeyPair, signJwt, algFitsKey, importPublicJwk, verifySignature, ALLOWED_ALGS, type AllowedAlg } from './jwt.ts'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

/** One Send per role. Every call below takes this and picks. */
export interface OidcSend { client: Send; public: Send }

export interface OidcTargets { client: TargetDescriptor; public: TargetDescriptor }

export interface OidcTargetsOptions {
  /** The issuer exactly as the provider spells it in `iss`; a trailing slash is part of the spelling. */
  issuer:   string
  /** A short name for this provider: `provider:oidc:<name>` for the client target, `…:public` for the public one. */
  name:     string
  /** The resolver's ref for `<client_id>:<client_secret>`; the client target's alone. */
  ref:      string
  /** The origin requests go to; the issuer's origin unless the provider puts endpoints elsewhere. */
  address?: string
  /** Further origins discovery names endpoints on (Google: `https://www.googleapis.com`). */
  origins?: string[]
  /** The client target's id; the public one's is `<id>:public`. */
  id?:      string
}

/**
 * `client` is the token endpoint, revocation and introspection: every request
 * carries the client's Basic. `public` is discovery, JWKS and userinfo: no
 * client credential, and userinfo's Bearer is the caller's.
 */
export function oidcTargets(opts: OidcTargetsOptions): OidcTargets {
  const id = opts.id ?? `provider:oidc:${opts.name}`
  const base = {
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? new URL(opts.issuer).origin,
    ...(opts.origins ? { origins: opts.origins } : {}),
    registered_at: Date.now(),
    last_seen_at:  null,
  } as const
  return {
    client: { ...base, id,                encoding: 'form', auth: { type: 'signed', signer: OIDC_SIGNER, ref: opts.ref } },
    public: { ...base, id: `${id}:public`,                  auth: { type: 'none' } },
  }
}

export function bindOidc(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: OidcTargets | { client: { id: string }; public: { id: string } }): OidcSend {
  return {
    client: req => conduit.send({ target: targets.client.id, ...req }),
    public: req => conduit.send({ target: targets.public.id, ...req }),
  }
}

export function discoveryPath(issuer: string): string {
  const path = new URL(issuer).pathname.replace(/\/$/, '')
  return `${path}/.well-known/openid-configuration`
}

// ─── validators: a 200 whose body is not the thing is refused (C4) ─────────

const REQUIRED_DISCOVERY = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const

export const discoveryValidator = (issuer: string): ResponseValidator<Discovery> => ({
  validate(data) {
    const d = data as Partial<Discovery> | null
    if (!d || typeof d !== 'object') return { ok: false, errors: ['discovery is not an object'] }
    const missing = REQUIRED_DISCOVERY.filter(k => typeof d[k] !== 'string')
    if (missing.length) return { ok: false, errors: [`discovery lacks ${missing.join(', ')}`] }
    // Discovery §4.3: the issuer in the document MUST equal the one that was
    // asked. A mismatch is a misconfigured provider or a proxy answering for
    // another — and every id_token it later signs would be refused on `iss`
    // anyway, so refusing here is the same answer a call earlier.
    if (d.issuer !== issuer) return { ok: false, errors: [`discovery says issuer '${d.issuer}', asked '${issuer}'`] }
    return { ok: true, value: d as Discovery }
  },
})

export const jwksValidator: ResponseValidator<Jwks> = {
  validate(data) {
    const j = data as Partial<Jwks> | null
    if (!j || !Array.isArray(j.keys)) return { ok: false, errors: ['JWKS has no keys array'] }
    return { ok: true, value: j as Jwks }
  },
}

export const tokenSetValidator: ResponseValidator<TokenSet> = {
  validate(data) {
    const t = data as Partial<TokenSet> | null
    if (!t || typeof t.access_token !== 'string' || typeof t.token_type !== 'string') return { ok: false, errors: ['token response lacks access_token or token_type'] }
    if (t.expires_in !== undefined && !(Number.isFinite(t.expires_in) && t.expires_in >= 0)) return { ok: false, errors: ['expires_in is not a non-negative number'] }
    return { ok: true, value: t as TokenSet }
  },
}

export const userInfoValidator: ResponseValidator<UserInfo> = {
  validate(data) {
    const u = data as Partial<UserInfo> | null
    if (!u || typeof u.sub !== 'string') return { ok: false, errors: ['userinfo has no sub'] }
    return { ok: true, value: u as UserInfo }
  },
}

// ─── the calls ─────────────────────────────────────────────────────────────

export type Answer<K extends string, T> = { [P in K]?: T } & { error?: OidcFailure }

export async function discover(oidc: OidcSend, issuer: string): Promise<Answer<'discovery', Discovery>> {
  const r = await oidc.public<Discovery>({ method: 'GET', path: discoveryPath(issuer), validate: discoveryValidator(issuer) })
  if (r.error) return { error: translate(r.error, r.meta.headers) }
  return { discovery: r.data }
}

export async function fetchJwks(oidc: OidcSend, discovery: Pick<Discovery, 'jwks_uri'>): Promise<Answer<'jwks', Jwks>> {
  const r = await oidc.public<Jwks>({ method: 'GET', address: discovery.jwks_uri, validate: jwksValidator })
  if (r.error) return { error: translate(r.error, r.meta.headers) }
  return { jwks: r.data }
}

/**
 * Leg two: the code for tokens. Unkeyed and not replayable — a code is single
 * use at the provider, so a replay of a lost response is `invalid_grant`, and
 * that refusal is what resolves the lost case (C6): the first attempt landed and
 * its answer is gone, so the user signs in again.
 */
export async function exchangeCode(oidc: OidcSend, discovery: Pick<Discovery, 'token_endpoint'>, req: {
  code:         string
  redirectUri:  string
  codeVerifier: string
  /** Sent only where the provider wants it in the body beside Basic (Apple does not; some do). */
  clientId?:    string
}): Promise<Answer<'tokens', TokenSet>> {
  if (!req.codeVerifier) throw new TypeError('oidc: exchangeCode needs the PKCE code_verifier; a code exchange without one is a code anybody who saw it can redeem')
  const r = await oidc.client<TokenSet>({
    method: 'POST', address: discovery.token_endpoint, validate: tokenSetValidator,
    body: {
      grant_type:    'authorization_code',
      code:          req.code,
      redirect_uri:  req.redirectUri,
      code_verifier: req.codeVerifier,
      ...(req.clientId ? { client_id: req.clientId } : {}),
    },
  })
  if (r.error) return { error: translate(r.error, r.meta.headers) }
  return { tokens: r.data }
}

/**
 * Leg three: a fresh access token off a refresh token. Unkeyed and not replayable:
 * a provider that ROTATES (Microsoft, Auth0 with rotation on) burns the old token on
 * use, so a replayed refresh is `invalid_grant` even though the first one
 * landed. There is no read that resolves a lost refresh; the connector's answer
 * is `grant_lost` and the user signs in again. `oidcTokenResolver` is the caller
 * that holds the lock and hands a rotated token to the app.
 */
export async function refreshTokens(oidc: OidcSend, discovery: Pick<Discovery, 'token_endpoint'>, req: {
  refreshToken: string
  scope?:       string
}): Promise<Answer<'tokens', TokenSet>> {
  const r = await oidc.client<TokenSet>({
    method: 'POST', address: discovery.token_endpoint, validate: tokenSetValidator,
    body: { grant_type: 'refresh_token', refresh_token: req.refreshToken, ...(req.scope ? { scope: req.scope } : {}) },
  })
  if (r.error) return { error: translate(r.error, r.meta.headers) }
  return { tokens: r.data }
}

/** The user's claims for an access token. A 401 here is the TOKEN's (`token_invalid`), never the client credential's. */
export async function userInfo(oidc: OidcSend, discovery: Pick<Discovery, 'userinfo_endpoint'>, accessToken: string): Promise<Answer<'user', UserInfo>> {
  if (!discovery.userinfo_endpoint) throw new TypeError('oidc: this provider publishes no userinfo_endpoint')
  const r = await oidc.public<UserInfo>({
    method: 'GET', address: discovery.userinfo_endpoint, validate: userInfoValidator,
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (r.error) return { error: translate(r.error, r.meta.headers) }
  return { user: r.data }
}

// ─── leg one: what the browser is sent to, and PKCE ────────────────────────

/** RFC 7636 §4: a verifier of 43–128 unreserved characters and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string; method: 'S256' }> {
  const verifier  = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge, method: 'S256' }
}

export function authorizationUrl(discovery: Pick<Discovery, 'authorization_endpoint'>, req: {
  clientId:      string
  redirectUri:   string
  scope?:        string
  state:         string
  nonce:         string
  codeChallenge: string
  extra?:        Record<string, string>
}): string {
  const url = new URL(discovery.authorization_endpoint)
  const params = {
    response_type: 'code', client_id: req.clientId, redirect_uri: req.redirectUri,
    scope: req.scope ?? 'openid', state: req.state, nonce: req.nonce,
    code_challenge: req.codeChallenge, code_challenge_method: 'S256', ...(req.extra ?? {}),
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}
