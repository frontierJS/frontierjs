// sink.ts — a minimal OpenID Provider, standing in for every one of them.
//
// Generates its own RSA key at start (WebCrypto RS256) and serves discovery,
// JWKS, an authorization endpoint that consents as a fixed user and answers
// a code, a token endpoint (authorization_code with PKCE S256 verified, and
// refresh_token with ROTATION: the old token is burned on use, the Microsoft
// shape) and userinfo. Client authentication is `client_secret_basic` ONLY,
// decoded here by hand with RFC 6749 §2.3.1's form-urlencoding undone; a
// client_secret in the body is refused by name, so a connector sending the
// credential the wrong way is a 401 rather than an agreement. The form parser
// is written here rather than borrowed from conduit's encoder.
//
// It owns the chaos (FJS-D890), under `/_sink/arm`:
//   { lost }                   the next request is applied and never answered
//   { rateLimit: { retryAfter } }  one 429
//   { failNext }               one 500 `temporarily_unavailable`-shaped server error
//   { wrongIssuer }            discovery answers an issuer that is not this one
//   { invalidGrant: token }    that refresh token answers `invalid_grant`
//   { expiresIn }              every token answered from now carries this expires_in
// `/_sink/rotate` adds a new kid and retires the old; `/_sink/seen` is what
// arrived (recorded on ARRIVAL); `/_sink/reset` clears what arrived and what
// is armed and keeps the keys, codes, grants and tokens.
//
// Not the provider's semantics: no consent screen, no scopes beyond echoing,
// no PKCE `plain` (the spec says S256 or nothing), no client registration.

import { createHash, randomBytes } from 'node:crypto'
import { generateKeyPair, publicJwk, signJwt } from './src/jwt.ts'
import type { Jwk } from './src/types.ts'

export interface OidcSinkOptions {
  port?:    number
  clientId?:     string
  clientSecret?: string
  /** What `sub` the authorization endpoint consents as. */
  user?:    { sub: string; email?: string; name?: string }
  /** Seconds an access token lives, unless armed otherwise. */
  expiresIn?: number
}

export function parseForm(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of text.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const k  = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '))
    out[k]   = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
  }
  return out
}

const token = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`
const json  = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
const oauthError = (error: string, description: string, status: number, headers: Record<string, string> = {}) =>
  json({ error, error_description: description }, status, headers)

interface Code  { sub: string; client_id: string; redirect_uri: string; code_challenge: string; nonce?: string; scope: string; used: boolean }
interface Grant { sub: string; client_id: string; scope: string; nonce?: string }
interface Access { sub: string; expiresAt: number }

export async function startOidcSink(opts: OidcSinkOptions = {}) {
  const CLIENT  = opts.clientId ?? 'drive-client'
  const SECRET  = opts.clientSecret ?? 's3cret:with/odd%chars'
  const USER    = opts.user ?? { sub: 'alice', email: 'alice@example.test', name: 'Alice' }
  let   kidSeq  = 0
  let   keys: Array<{ kid: string; pair: CryptoKeyPair; jwk: Jwk }> = []
  const rotate  = async () => {
    const kid  = `k${++kidSeq}`
    const pair = await generateKeyPair('RS256')
    keys = [{ kid, pair, jwk: await publicJwk('RS256', pair, kid) }]
    return kid
  }
  await rotate()

  const codes    = new Map<string, Code>()
  const refresh  = new Map<string, Grant>()     // live refresh tokens
  const burned   = new Set<string>()            // rotated away; a reuse is invalid_grant
  const access   = new Map<string, Access>()
  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, wrongIssuer: false, invalidGrant: null as null | string, expiresIn: null as null | number }
  const hanging: Array<() => void> = []
  let server!: ReturnType<typeof Bun.serve>
  const issuer = () => `http://127.0.0.1:${server.port}`

  async function mintIdToken(grant: Grant, extra: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000)
    const { kid, pair } = keys[keys.length - 1]
    return signJwt('RS256', pair.privateKey, { kid, typ: 'JWT' }, {
      iss: issuer(), sub: grant.sub, aud: grant.client_id, iat: now, exp: now + 300, auth_time: now,
      ...(grant.nonce ? { nonce: grant.nonce } : {}), email: USER.email, name: USER.name, ...extra,
    })
  }

  function issue(grant: Grant, previous?: string) {
    const expiresIn = armed.expiresIn ?? opts.expiresIn ?? 3600
    const at = token('at'); access.set(at, { sub: grant.sub, expiresAt: Date.now() + expiresIn * 1000 })
    const rt = token('rt'); refresh.set(rt, grant)
    if (previous) { refresh.delete(previous); burned.add(previous) }
    return { at, rt, expiresIn }
  }

  function clientFromBasic(header: string | null): 'none' | 'wrong' | 'ok' {
    if (!header || !/^Basic /.test(header)) return 'none'
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const i   = raw.indexOf(':')
    if (i === -1) return 'wrong'
    try {
      return decodeURIComponent(raw.slice(0, i)) === CLIENT && decodeURIComponent(raw.slice(i + 1)) === SECRET ? 'ok' : 'wrong'
    } catch { return 'wrong' }
  }

  server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url  = new URL(req.url)
      const path = url.pathname

      if (path === '/_sink/seen')   return json({ requests: seen, kids: keys.map(k => k.kid), live: refresh.size, burned: burned.size })
      if (path === '/_sink/reset')  { seen.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, wrongIssuer: false, invalidGrant: null, expiresIn: null }); return json({ ok: true }) }
      if (path === '/_sink/arm')    { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }
      if (path === '/_sink/rotate') return json({ kid: await rotate() })
      // A token signed by this sink's CURRENT key with any claims the drive asks
      // for, so the verifier's refusals are tested against real signatures. A
      // claim given as null is REMOVED, since JSON cannot carry undefined.
      if (path === '/_sink/mint') {
        const body = await req.json() as { claims: Record<string, unknown>; kid?: string }
        const now  = Math.floor(Date.now() / 1000)
        const { kid, pair } = keys[keys.length - 1]
        const claims: Record<string, unknown> = { iss: issuer(), sub: USER.sub, aud: CLIENT, iat: now, exp: now + 300, ...body.claims }
        for (const [k, v] of Object.entries(claims)) if (v === null) delete claims[k]
        const jwt  = await signJwt('RS256', pair.privateKey, { kid: body.kid ?? kid, typ: 'JWT' }, claims)
        return json({ jwt })
      }

      const text = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: text, at: Date.now() })

      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null
        return oauthError('temporarily_unavailable', 'Too many requests', 429, { 'retry-after': String(retryAfter) }) }
      if (armed.failNext) { armed.failNext = false; return oauthError('server_error', 'The authorization server encountered an unexpected condition', 500) }

      let answer: Response | null = null

      if (path === '/.well-known/openid-configuration' && req.method === 'GET') {
        const iss = armed.wrongIssuer ? 'https://somebody-else.example' : issuer()
        armed.wrongIssuer = false
        answer = json({
          issuer: iss,
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint:         `${issuer()}/token`,
          jwks_uri:               `${issuer()}/jwks`,
          userinfo_endpoint:      `${issuer()}/userinfo`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
          backchannel_logout_supported: true,
        })
      }

      if (path === '/jwks' && req.method === 'GET') answer = json({ keys: keys.map(k => k.jwk) })

      // Leg one, with the human removed: the fixed user consents to everything.
      if (path === '/authorize' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams)
        const redirect = (params: Record<string, string>) => {
          const to = new URL(q.redirect_uri)
          for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v)
          return new Response(null, { status: 302, headers: { location: to.toString() } })
        }
        if (!q.redirect_uri) answer = oauthError('invalid_request', 'redirect_uri is required', 400)
        else if (q.client_id !== CLIENT) answer = redirect({ error: 'unauthorized_client', state: q.state ?? '' })
        else if (q.response_type !== 'code') answer = redirect({ error: 'unsupported_response_type', state: q.state ?? '' })
        else if (q.code_challenge_method !== 'S256' || !q.code_challenge) answer = redirect({ error: 'invalid_request', error_description: 'PKCE S256 is required', state: q.state ?? '' })
        else {
          const code = token('code')
          codes.set(code, { sub: USER.sub, client_id: CLIENT, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, nonce: q.nonce, scope: q.scope ?? 'openid', used: false })
          answer = redirect({ code, state: q.state ?? '' })
        }
      }

      if (path === '/token' && req.method === 'POST') {
        const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim()
        if (ct !== 'application/x-www-form-urlencoded') answer = oauthError('invalid_request', `the token endpoint takes application/x-www-form-urlencoded, got '${ct || '(none)'}'`, 400)
        else {
          const form = parseForm(text)
          const who  = clientFromBasic(req.headers.get('authorization'))
          if (form.client_secret !== undefined) answer = oauthError('invalid_client', 'this provider takes client_secret_basic; a client_secret in the body is refused', 401, { 'www-authenticate': 'Basic realm="oidc-sink"' })
          else if (who !== 'ok') answer = oauthError('invalid_client', who === 'none' ? 'no client authentication' : 'client authentication failed', 401, { 'www-authenticate': 'Basic realm="oidc-sink"' })
          else if (form.grant_type === 'authorization_code') {
            const c = codes.get(form.code ?? '')
            if (!c || c.used) answer = oauthError('invalid_grant', 'authorization code is unknown or already redeemed', 400)
            else if (c.redirect_uri !== form.redirect_uri) answer = oauthError('invalid_grant', 'redirect_uri does not match the authorization request', 400)
            else if (!form.code_verifier || createHash('sha256').update(form.code_verifier).digest('base64url') !== c.code_challenge)
              answer = oauthError('invalid_grant', 'PKCE code_verifier does not match code_challenge', 400)
            else {
              c.used = true
              const grant: Grant = { sub: c.sub, client_id: c.client_id, scope: c.scope, nonce: c.nonce }
              const { at, rt, expiresIn } = issue(grant)
              answer = json({ access_token: at, token_type: 'Bearer', expires_in: expiresIn, refresh_token: rt, id_token: await mintIdToken(grant), scope: c.scope })
            }
          }
          else if (form.grant_type === 'refresh_token') {
            const rt = form.refresh_token ?? ''
            const g  = refresh.get(rt)
            if (armed.invalidGrant === rt) { armed.invalidGrant = null; refresh.delete(rt); burned.add(rt); answer = oauthError('invalid_grant', 'the refresh token was revoked', 400) }
            else if (!g) answer = oauthError('invalid_grant', burned.has(rt) ? 'the refresh token was already rotated' : 'unknown refresh token', 400)
            else {
              const { at, rt: next, expiresIn } = issue(g, rt)
              answer = json({ access_token: at, token_type: 'Bearer', expires_in: expiresIn, refresh_token: next, id_token: await mintIdToken({ ...g, nonce: undefined }), scope: g.scope })
            }
          }
          else answer = oauthError('unsupported_grant_type', `grant_type '${form.grant_type ?? '(none)'}'`, 400)
        }
      }

      if (path === '/userinfo' && req.method === 'GET') {
        const auth = req.headers.get('authorization') ?? ''
        const a    = /^Bearer (.+)$/.exec(auth)?.[1]
        const rec  = a ? access.get(a) : undefined
        if (!rec)   answer = oauthError('invalid_token', 'the access token is unknown', 401, { 'www-authenticate': 'Bearer error="invalid_token"' })
        else if (rec.expiresAt <= Date.now()) answer = oauthError('invalid_token', 'the access token has expired', 401, { 'www-authenticate': 'Bearer error="invalid_token", error_description="expired"' })
        else answer = json({ sub: rec.sub, email: USER.email, email_verified: true, name: USER.name })
      }

      if (!answer) return oauthError('invalid_request', `no such endpoint: ${req.method} ${path}`, 404)

      // Applied and never answered: a refresh here has already rotated the
      // token, which is what makes a lost refresh a lost grant.
      if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
      return answer
    },
  })

  return {
    port:   server.port,
    url:    issuer(),
    issuer: issuer(),
    client: { id: CLIENT, secret: SECRET },
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = await startOidcSink({ port: Number(process.env.OIDC_SINK_PORT ?? 0) })
  console.log(`[oidc-sink] ${s.url}  client ${s.client.id}:${s.client.secret}`)
}
