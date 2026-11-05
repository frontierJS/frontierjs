// test/oidc.drive.ts — the connector through a real conduit against the sink,
// and against a conforming provider when `FIXTURE_URL` names one.
//
// Run: `bun run drive`. Starts and stops its own sink on an ephemeral port.
// `FIXTURE_URL=http://127.0.0.1:3000 FIXTURE_CLIENT=id:secret bun run drive`
// adds the protocol rows (discovery, JWKS, a verified id_token minted by the
// fixture, userinfo) against it; `test/fixture/README.md` starts one.
//
// The negative control is the signer: the same connector with the
// `oidc-client-basic` signer replaced by one that signs nothing must be refused
// by the token endpoint as `invalid_client`, or every row about the Basic
// header is about something else.
//
// Two measurements are the point of the file. `refresh.race`: five callers on
// one grant, one refresh at the provider. `expiresIn.droppedByWithCache`:
// the provider says the token lives one second and conduit's `withCache`
// hands the dead token out for its own TTL — the gap `FJS-2245` names.

import { createHmac } from 'node:crypto'
import { createConduit, createStaticResolver, withCache } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startOidcSink } from '../sink.ts'
import {
  oidcTargets, bindOidc, discover, fetchJwks, exchangeCode, refreshTokens, userInfo, pkce, authorizationUrl,
  verifyIdToken, verifyLogoutToken, LOGOUT_EVENT, jwksResolver, jwksKeys, oidcTokenResolver, appleClientSecretResolver,
  oidcSigners, OIDC_SIGNER, b64url, generateKeyPair,
  type Discovery, type Jwks, type Send, type OidcFailure,
} from '../src/index.ts'

const { got, t } = results()
const REDIRECT = 'http://app.test/callback'

const sink = await startOidcSink({ expiresIn: 3600 })
const ctl  = control(sink.url)
const CRED = `${sink.client.id}:${sink.client.secret}`
const conduit = createConduit({ credentials: createStaticResolver({ OIDC_SINK: CRED }), signers: oidcSigners, ...DRIVE_RESILIENCE })
const targets = oidcTargets({ issuer: sink.issuer, name: 'sink', ref: 'OIDC_SINK' })
await conduit.register(targets.client)
await conduit.register(targets.public)
const oidc    = bindOidc(conduit, targets)

type Seen = { requests: { method: string; path: string; headers: Record<string, string>; body: string }[]; kids: string[]; live: number; burned: number }
const seen  = () => ctl.seen<never>() as unknown as Promise<Seen>
const count = async (path?: string) => (await seen()).requests.filter(r => !path || r.path === path).length
const nowS  = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Leg one with the human removed: the sink consents and 302s a code back. */
async function login(discovery: Discovery, nonce: string) {
  const p   = await pkce()
  const res = await fetch(authorizationUrl(discovery, { clientId: sink.client.id, redirectUri: REDIRECT, state: 'st', nonce, codeChallenge: p.challenge, scope: 'openid email offline_access' }), { redirect: 'manual' })
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!
  return { code, verifier: p.verifier }
}
/** A token the sink signs with its live key, with the claims asked for. */
const mint = (claims: Record<string, unknown>, kid?: string) =>
  fetch(`${sink.url}/_sink/mint`, { method: 'POST', body: JSON.stringify({ claims, kid }) }).then(r => r.json()).then(j => (j as { jwt: string }).jwt)

try {
  // ── discovery and keys ─────────────────────────────────────────────────
  const d = await discover(oidc, sink.issuer)
  const discovery = d.discovery!
  const first = (await seen()).requests[0]
  t('discovery.succeeds', { ok: !d.error, issuer: discovery?.issuer === sink.issuer, hasToken: typeof discovery?.token_endpoint === 'string', basicOnGet: 'authorization' in first.headers })

  await ctl.arm({ wrongIssuer: true })
  const wrong = await discover(oidc, sink.issuer)
  t('discovery.wrongIssuerRefused', { kind: wrong.error?.kind, names: (wrong.error?.message ?? '').includes('somebody-else.example') })

  await ctl.reset(); await ctl.arm({ failNext: true })
  const flaky = await discover(oidc, sink.issuer)
  t('discovery.serverErrorRetriedByConduit', { ok: !flaky.error, attempts: await count() })

  const j = await fetchJwks(oidc, discovery)
  const jwks = j.jwks!
  t('jwks.fetched', { keys: jwks.keys.length, kty: jwks.keys[0]?.kty, alg: jwks.keys[0]?.alg, kid: jwks.keys[0]?.kid })

  // ── leg two: the code for tokens, Basic on the wire ───────────────────
  await ctl.reset()
  const { code, verifier } = await login(discovery, 'nonce-1')
  const ex = await exchangeCode(oidc, discovery, { code, redirectUri: REDIRECT, codeVerifier: verifier })
  const tokenReq = (await seen()).requests.find(r => r.path === '/token')!
  const basic = Buffer.from((tokenReq.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString()
  t('code.exchanged', {
    ok: !ex.error, tokenType: ex.tokens?.token_type, hasId: !!ex.tokens?.id_token, hasRefresh: !!ex.tokens?.refresh_token,
    contentType: tokenReq.headers['content-type'], bodyIsForm: tokenReq.body.includes('grant_type=authorization_code&'),
    basicIsUrlencoded: basic === `${sink.client.id}:${encodeURIComponent(sink.client.secret)}`, noKeyHeader: !('idempotency-key' in tokenReq.headers),
  })
  const tokens = ex.tokens!

  const replay = await exchangeCode(oidc, discovery, { code, redirectUri: REDIRECT, codeVerifier: verifier })
  t('code.secondRedeemIsGrantLost', { kind: replay.error?.kind, code: replay.error?.code, retryable: replay.error?.retryable })

  const { code: code2 } = await login(discovery, 'nonce-2')
  const badPkce = await exchangeCode(oidc, discovery, { code: code2, redirectUri: REDIRECT, codeVerifier: 'not-the-verifier-not-the-verifier-not-the-verifier' })
  t('pkce.wrongVerifierRefused', { kind: badPkce.error?.kind, code: badPkce.error?.code, saysPkce: (badPkce.error?.message ?? '').includes('PKCE') })

  // ── negative control: the signer that signs nothing ────────────────────
  const bare = createConduit({ credentials: createStaticResolver({ OIDC_SINK: CRED }), signers: { [OIDC_SIGNER]: () => ({}) } })
  await bare.register(targets.client)
  const { code: code3, verifier: v3 } = await login(discovery, 'nonce-3')
  const unsigned = await exchangeCode(bindOidc(bare, targets), discovery, { code: code3, redirectUri: REDIRECT, codeVerifier: v3 })
  t('withoutSigner.isRefused', { kind: unsigned.error?.kind, code: unsigned.error?.code })
  await bare.destroy()

  // ── the verifier, pure, against real signatures ────────────────────────
  const base = { jwks, issuer: sink.issuer, audience: sink.client.id, now: nowS() }
  const ok = await verifyIdToken(tokens.id_token!, { ...base, nonce: 'nonce-1' })
  t('idToken.verified', { ok: ok.ok, sub: ok.ok ? ok.claims.sub : null, kid: ok.ok ? ok.kid : null, alg: ok.ok ? ok.alg : null })
  t('idToken.nonceMismatch', (await verifyIdToken(tokens.id_token!, { ...base, nonce: 'other' })).ok)
  t('idToken.wrongIssuer',   (await verifyIdToken(tokens.id_token!, { ...base, issuer: 'https://somebody-else.example' })).ok)
  t('idToken.wrongAudience', (await verifyIdToken(tokens.id_token!, { ...base, audience: 'another-client' })).ok)

  const [h, p] = tokens.id_token!.split('.')
  const forged = (alg: string, sig: string) => `${b64url(JSON.stringify({ alg, kid: jwks.keys[0].kid, typ: 'JWT' }))}.${p}.${sig}`
  const hs = (jwtHead: string) => createHmac('sha256', JSON.stringify(jwks.keys[0])).update(`${jwtHead}.${p}`).digest('base64url')
  const none  = await verifyIdToken(forged('none', ''), base)
  const hs256 = await verifyIdToken(forged('HS256', hs(b64url(JSON.stringify({ alg: 'HS256', kid: jwks.keys[0].kid, typ: 'JWT' })))), base)
  const ps256 = await verifyIdToken(forged('PS256', 'AAAA'), base)
  t('alg.refusedByName', { none: none.ok === false && none.reason.includes("'none'"), hs256: hs256.ok === false && hs256.reason.includes("'HS256'"), ps256: ps256.ok === false && ps256.reason.includes("'PS256'") })
  t('signature.swappedBodyRefused', (await verifyIdToken(`${h}.${b64url(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'mallory' }))}.${tokens.id_token!.split('.')[2]}`, base)).ok)

  const at = nowS()
  const audArray  = await mint({ aud: [sink.client.id, 'other-client'], azp: sink.client.id })
  const audNoAzp  = await mint({ aud: [sink.client.id, 'other-client'] })
  const audBadAzp = await mint({ aud: [sink.client.id, 'other-client'], azp: 'other-client' })
  t('aud.arrayNeedsAzp', {
    arrayWithAzp: (await verifyIdToken(audArray, base)).ok,
    arrayNoAzp:   (await verifyIdToken(audNoAzp, base)).ok,
    arrayWrongAzp: (await verifyIdToken(audBadAzp, base)).ok,
  })

  const exp30  = await mint({ iat: at - 400, exp: at - 30 })
  const exp120 = await mint({ iat: at - 400, exp: at - 120 })
  t('exp.skew', {
    past30with60:  (await verifyIdToken(exp30,  { ...base, now: at, clockSkewSeconds: 60 })).ok,
    past120with60: (await verifyIdToken(exp120, { ...base, now: at, clockSkewSeconds: 60 })).ok,
    past120with180: (await verifyIdToken(exp120, { ...base, now: at, clockSkewSeconds: 180 })).ok,
  })
  t('nbfIat.future', {
    nbfAhead: (await verifyIdToken(await mint({ nbf: at + 300 }), { ...base, now: at })).ok,
    iatAhead: (await verifyIdToken(await mint({ iat: at + 300 }), { ...base, now: at })).ok,
    noExp:    (await verifyIdToken(await mint({ exp: null }), { ...base, now: at })).ok,
  })

  const logout = await mint({ events: { [LOGOUT_EVENT]: {} }, jti: 'j1', sid: 'sess-1', exp: null, sub: null })
  const logoutWithNonce = await mint({ events: { [LOGOUT_EVENT]: {} }, jti: 'j2', nonce: 'x' })
  t('logoutToken.sameVerifier', {
    ok: (await verifyLogoutToken(logout, base)).ok,
    withNonce: (await verifyLogoutToken(logoutWithNonce, base)).ok,
    asIdToken: (await verifyIdToken(logout, base)).ok,
  })

  // ── kid rotation: the cached set is refetched ONCE on an unknown kid ────
  await ctl.reset()
  const keys = jwksKeys(withCache(jwksResolver(oidc, discovery), { ttl_ms: 60_000 }), discovery)
  await keys.jwks()
  await fetch(`${sink.url}/_sink/rotate`)
  const afterRotate = await mint({})
  const rotated = await keys.verify(afterRotate, { issuer: sink.issuer, audience: sink.client.id, now: nowS() })
  const fetchesAfterRotation = await count('/jwks')
  const ghost = await keys.verify(await mint({}, 'ghost'), { issuer: sink.issuer, audience: sink.client.id, now: nowS() })
  const fetchesAfterGhost = await count('/jwks')
  const stale = await keys.verify(tokens.id_token!, { issuer: sink.issuer, audience: sink.client.id, now: nowS() })
  t('kid.rotationRefetchesOnce', { ok: rotated.ok, refetched: rotated.ok && rotated.refetched === true, fetches: fetchesAfterRotation })
  t('kid.unknownRefusedAfterOneRefetch', { ok: ghost.ok, reasonNamesKid: !ghost.ok && ghost.reason.includes("'ghost'"), fetches: fetchesAfterGhost })
  t('kid.retiredKeyRefused', { ok: stale.ok, fetches: await count('/jwks') })

  // ── userinfo spends the USER's token, not the client's ─────────────────
  await ctl.reset()
  const u = await userInfo(oidc, discovery, tokens.access_token)
  const uReq = (await seen()).requests[0]
  t('userinfo.bearerIsTheCallers', { ok: !u.error, sub: u.user?.sub, authorization: uReq.headers.authorization === `Bearer ${tokens.access_token}` })
  const uBad = await userInfo(oidc, discovery, 'at_nobody')
  t('userinfo.deadTokenIsTokenInvalid', { kind: uBad.error?.kind, code: uBad.error?.code, retryable: uBad.error?.retryable })

  // ── leg three: refresh, rotation, the lock, the lost grant ─────────────
  await ctl.reset()
  const rotations: Array<{ ref: string; next: string; previous: string }> = []
  const lost: Array<{ ref: string; failure: OidcFailure }> = []
  const store = new Map<string, string>([['alice', tokens.refresh_token!]])
  const grants = {
    refreshTokenFor: (ref: string) => store.get(ref) ?? null,
    onRotated: (ref: string, next: string, previous: string) => { rotations.push({ ref, next, previous }); store.set(ref, next) },
    onLost:    (ref: string, failure: OidcFailure) => { lost.push({ ref, failure }) },
  }
  const resolver = oidcTokenResolver(oidc, discovery, grants, { earlySeconds: 0 })

  const racers = await Promise.all([1, 2, 3, 4, 5].map(() => resolver.get('alice')))
  t('refresh.race', { callers: 5, refreshesAtSink: await count('/token'), oneToken: new Set(racers).size, resolverCount: resolver.refreshes('alice') })
  t('refresh.rotationHandedOverNotStored', {
    rotated: rotations.length, newDiffers: rotations[0]?.next !== tokens.refresh_token, previousWasOurs: rotations[0]?.previous === tokens.refresh_token,
    appHoldsNew: store.get('alice') === rotations[0]?.next, live: (await seen()).live, burned: (await seen()).burned,
  })
  const cachedAgain = await resolver.get('alice')
  t('refresh.cachedUntilExpiry', { same: cachedAgain === racers[0], refreshes: await count('/token') })

  // conduit's own 401 path: the provider refuses the access token, the resolver forgets it, the send replays on a fresh one
  const userConduit = createConduit({ credentials: resolver, signers: {}, ...DRIVE_RESILIENCE })
  await userConduit.register({ ...oidcTargets({ issuer: sink.issuer, name: 'user', ref: 'alice' }).client, auth: { type: 'bearer', ref: 'alice' } })
  const userSend: Send = bindOidc(userConduit, { client: { id: 'provider:oidc:user' }, public: { id: 'provider:oidc:user' } }).public
  resolver.forget('alice'); store.set('alice', rotations[rotations.length - 1].next)
  await ctl.reset()
  const viaBearer = await userSend<{ sub: string }>({ method: 'GET', address: discovery.userinfo_endpoint! })
  const spent = (await resolver.get('alice'))!
  await ctl.arm({ invalidGrant: 'nothing' })
  // A revoked ACCESS token: fake it by expiring at the sink through a 1 s token
  t('bearerTarget.resolverMintsOnDemand', { ok: !viaBearer.error, sub: viaBearer.data?.sub, refreshes: await count('/token') })
  resolver.invalidate('alice', spent)
  const afterInvalidate = await resolver.get('alice')
  t('resolver.invalidateForgetsOnlyThatToken', { reminted: afterInvalidate !== spent, secondInvalidateIsNoop: (resolver.invalidate('alice', spent), (await resolver.get('alice')) === afterInvalidate) })
  await userConduit.destroy()

  await ctl.reset()
  await ctl.arm({ invalidGrant: store.get('alice') })
  resolver.forget('alice')
  const gone = await resolver.get('alice')
  const goneAgain = await resolver.get('alice')
  t('refresh.invalidGrantIsLost', {
    answered: gone, state: resolver.state('alice').status, failureKind: lost[0]?.failure.kind, code: lost[0]?.failure.code,
    laterGetFailsClosed: goneAgain, refreshesAtSink: await count('/token'),
  })

  // ── expires_in: honored here, dropped by withCache (FJS-2245) ──────────
  await ctl.reset(); await ctl.arm({ expiresIn: 1 })
  const { code: c4, verifier: v4 } = await login(discovery, 'nonce-4')
  const short = (await exchangeCode(oidc, discovery, { code: c4, redirectUri: REDIRECT, codeVerifier: v4 })).tokens!
  store.set('bob', short.refresh_token!)
  const honoring = oidcTokenResolver(oidc, discovery, grants, { earlySeconds: 0 })
  const b1 = await honoring.get('bob')
  await sleep(1200)
  const b2 = await honoring.get('bob')
  t('expiresIn.honoredByResolver', { refreshedAfterExpiry: b1 !== b2, refreshes: honoring.refreshes('bob'), providerSaid: short.expires_in })

  const { code: c5, verifier: v5 } = await login(discovery, 'nonce-5')
  store.set('carol', (await exchangeCode(oidc, discovery, { code: c5, redirectUri: REDIRECT, codeVerifier: v5 })).tokens!.refresh_token!)
  const cached = withCache(oidcTokenResolver(oidc, discovery, grants, { earlySeconds: 0, defaultExpiresIn: 3600 }), { ttl_ms: 60_000 })
  const c1 = await cached.get('carol')
  await sleep(1200)
  const c2 = await cached.get('carol')
  const deadAtProvider = await userInfo(oidc, discovery, c2!)
  t('expiresIn.droppedByWithCache', { providerSaid: 1, cacheTtlMs: 60_000, sameTokenAfterExpiry: c1 === c2, providerAnswers: deadAtProvider.error?.kind })
  await ctl.reset()

  // ── chaos on the token endpoint: nothing is replayed ───────────────────
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const limited = await refreshTokens(oidc, discovery, { refreshToken: store.get('alice') ?? 'rt_x' })
  t('token.rateLimitedNotReplayed', { kind: limited.error?.kind, retryAfterMs: limited.error?.retryAfterMs, retryable: limited.error?.retryable, attempts: await count('/token') })

  await ctl.reset(); await ctl.arm({ failNext: true })
  const broke = await refreshTokens(oidc, discovery, { refreshToken: 'rt_x' })
  t('token.serverErrorNotReplayed', { kind: broke.error?.kind, retryable: broke.error?.retryable, attempts: await count('/token') })

  const { code: c6, verifier: v6 } = await login(discovery, 'nonce-6')
  const fresh = (await exchangeCode(oidc, discovery, { code: c6, redirectUri: REDIRECT, codeVerifier: v6 })).tokens!
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostRefresh = await refreshTokens(oidc, discovery, { refreshToken: fresh.refresh_token! })
  const retryOld = await refreshTokens(oidc, discovery, { refreshToken: fresh.refresh_token! })
  t('refresh.lostResponseBurnsTheGrant', {
    kind: lostRefresh.error?.kind, indeterminate: lostRefresh.error?.indeterminate,
    retryable: lostRefresh.error?.retryable, retryWithOldToken: retryOld.error?.kind, attempts: await count('/token'),
  })

  // ── Apple: the client secret is a JWT the resolver mints, no vendor call ─
  const applePair = await generateKeyPair('ES256')
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', applePair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
  const apple = appleClientSecretResolver({ teamId: 'TEAM1', clientId: 'com.example.app', keyId: 'KEY1', privateKey: pem, now: () => 1_700_000_000 })
  const secret = (await apple.get('APPLE'))!
  const [appleId, appleJwt] = [secret.slice(0, secret.indexOf(':')), secret.slice(secret.indexOf(':') + 1)]
  const appleJwk = await crypto.subtle.exportKey('jwk', applePair.publicKey)
  const appleOk = await verifyIdToken(appleJwt, { jwks: { keys: [{ ...(appleJwk as Jwks['keys'][0]), kid: 'KEY1', alg: 'ES256' }] }, issuer: 'TEAM1', audience: 'https://appleid.apple.com', now: 1_700_000_100 })
  t('apple.secretIsEs256Jwt', { clientId: appleId, verifies: appleOk.ok, alg: appleOk.ok ? appleOk.alg : null, sub: appleOk.ok ? appleOk.claims.sub : null, exp: appleOk.ok ? appleOk.claims.exp : null })

  // ── an endpoint on another origin: through where declared, refused by name where not ─
  // `localhost` and `127.0.0.1` are two origins onto the one sink (FJS-2730).
  const elsewhere = sink.issuer.replace('127.0.0.1', 'localhost')
  const multi = oidcTargets({ issuer: sink.issuer, name: 'multi', ref: 'OIDC_SINK', origins: [elsewhere] })
  await conduit.register(multi.public)
  await ctl.reset()
  const viaDeclared = await fetchJwks(bindOidc(conduit, multi), { jwks_uri: `${elsewhere}/jwks` })
  t('endpoint.declaredOriginReached', { ok: !viaDeclared.error, keys: (viaDeclared.jwks?.keys.length ?? 0) > 0, hits: await count('/jwks') })
  const foreign = await oidc.public({ method: 'GET', address: 'https://oauth2.googleapis.com/token' })
  t('endpoint.foreignOriginRefused', { kind: foreign.error?.kind, named: foreign.error?.message.includes('https://oauth2.googleapis.com') ?? false })

  // ── one target per credential: each call picks its own role from the bundle ─
  // Nothing is handed a send to refuse any more; the proof is on the wire: Basic
  // reaches the token endpoint alone, and the public calls carry none of the
  // client's credential.
  await ctl.reset()
  await discover(oidc, sink.issuer)
  await fetchJwks(oidc, discovery)
  const { code: c7, verifier: v7 } = await login(discovery, 'nonce-7')
  const picked = await exchangeCode(oidc, discovery, { code: c7, redirectUri: REDIRECT, codeVerifier: v7 })
  await userInfo(oidc, discovery, picked.tokens!.access_token)
  const wire = (await seen()).requests
  const auth = (path: string) => wire.find(r => r.path === path)?.headers.authorization ?? ''
  t('bundle.callsPickTheirRole', {
    tokenIsClientBasic: auth('/token').startsWith('Basic '),
    discoveryNoCredential: auth('/.well-known/openid-configuration') === '',
    jwksNoCredential: auth('/jwks') === '',
    userinfoIsCallersBearer: auth('/userinfo') === `Bearer ${picked.tokens!.access_token}`,
  })

  // ── a conforming provider, when one is up ──────────────────────────────
  if (process.env.FIXTURE_URL) await fixtureRows()
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); await conduit.destroy()
}

async function fixtureRows() {
  const issuer = process.env.FIXTURE_URL!.replace(/\/$/, '')
  const [cid, csec] = (process.env.FIXTURE_CLIENT ?? 'drive:drive-secret').split(':')
  const fx = createConduit({ credentials: createStaticResolver({ FIXTURE: `${cid}:${csec}` }), signers: oidcSigners, ...DRIVE_RESILIENCE, timeout_ms: 5_000 })
  const ft = oidcTargets({ issuer, name: 'fixture', ref: 'FIXTURE' })
  await fx.register(ft.client)
  await fx.register(ft.public)
  const foidc = bindOidc(fx, ft)
  try {
    const d = await discover(foidc, issuer)
    t('fixture.discovery', { ok: !d.error, issuer: d.discovery?.issuer === issuer, error: d.error?.message })
    if (!d.discovery) return
    const j = await fetchJwks(foidc, d.discovery)
    t('fixture.jwks', { ok: !j.error, keys: (j.jwks?.keys.length ?? 0) > 0 })
    // A code needs a browser; a fixture that hands one over under
    // FIXTURE_CODE (with FIXTURE_VERIFIER and FIXTURE_REDIRECT) runs the token
    // rows, and the row says when it did not.
    if (process.env.FIXTURE_CODE) {
      const ex = await exchangeCode(foidc, d.discovery, { code: process.env.FIXTURE_CODE, redirectUri: process.env.FIXTURE_REDIRECT ?? REDIRECT, codeVerifier: process.env.FIXTURE_VERIFIER ?? '' })
      t('fixture.tokens', { ok: !ex.error, error: ex.error?.code })
      if (ex.tokens?.id_token && j.jwks) {
        const v = await verifyIdToken(ex.tokens.id_token, { jwks: j.jwks, issuer, audience: cid, nonce: process.env.FIXTURE_NONCE, now: nowS() })
        t('fixture.idToken', { ok: v.ok, reason: v.ok ? null : v.reason })
        const u = await userInfo(foidc, d.discovery, ex.tokens.access_token)
        t('fixture.userinfo', { ok: !u.error, hasSub: typeof u.user?.sub === 'string' })
        if (ex.tokens.refresh_token) {
          const r = await refreshTokens(foidc, d.discovery, { refreshToken: ex.tokens.refresh_token })
          t('fixture.refresh', { ok: !r.error, error: r.error?.message, hasAccess: typeof r.tokens?.access_token === 'string' })
        }
        const replay = await exchangeCode(foidc, d.discovery, { code: process.env.FIXTURE_CODE, redirectUri: process.env.FIXTURE_REDIRECT ?? REDIRECT, codeVerifier: process.env.FIXTURE_VERIFIER ?? '' })
        t('fixture.codeReplayIsGrantLost', { kind: replay.error?.kind, code: replay.error?.code })
      }
    }
    const bad = await refreshTokens(foidc, d.discovery, { refreshToken: 'not-a-token' })
    t('fixture.unknownRefreshIsGrantLost', { kind: bad.error?.kind, code: bad.error?.code })
  } finally { await fx.destroy() }
}

const expected: Record<string, unknown> = {
  'discovery.succeeds':                       { ok: true, issuer: true, hasToken: true, basicOnGet: false },
  'discovery.wrongIssuerRefused':             { kind: 'invalid_response', names: true },
  'discovery.serverErrorRetriedByConduit':    { ok: true, attempts: 2 },
  'jwks.fetched':                             { keys: 1, kty: 'RSA', alg: 'RS256', kid: 'k1' },
  'code.exchanged':                           { ok: true, tokenType: 'Bearer', hasId: true, hasRefresh: true, contentType: 'application/x-www-form-urlencoded', bodyIsForm: true, basicIsUrlencoded: true, noKeyHeader: true },
  'code.secondRedeemIsGrantLost':             { kind: 'grant_lost', code: 'invalid_grant', retryable: false },
  'pkce.wrongVerifierRefused':                { kind: 'grant_lost', code: 'invalid_grant', saysPkce: true },
  'withoutSigner.isRefused':                  { kind: 'auth_failed', code: 'invalid_client' },
  'idToken.verified':                         { ok: true, sub: 'alice', kid: 'k1', alg: 'RS256' },
  'idToken.nonceMismatch':                    false,
  'idToken.wrongIssuer':                      false,
  'idToken.wrongAudience':                    false,
  'alg.refusedByName':                        { none: true, hs256: true, ps256: true },
  'signature.swappedBodyRefused':             false,
  'aud.arrayNeedsAzp':                        { arrayWithAzp: true, arrayNoAzp: false, arrayWrongAzp: false },
  'exp.skew':                                 { past30with60: true, past120with60: false, past120with180: true },
  'nbfIat.future':                            { nbfAhead: false, iatAhead: false, noExp: false },
  'logoutToken.sameVerifier':                 { ok: true, withNonce: false, asIdToken: false },
  'kid.rotationRefetchesOnce':                { ok: true, refetched: true, fetches: 2 },
  'kid.unknownRefusedAfterOneRefetch':        { ok: false, reasonNamesKid: true, fetches: 3 },
  'kid.retiredKeyRefused':                    { ok: false, fetches: 4 },
  'userinfo.bearerIsTheCallers':              { ok: true, sub: 'alice', authorization: true },
  'userinfo.deadTokenIsTokenInvalid':         { kind: 'token_invalid', code: 'invalid_token', retryable: false },
  'refresh.race':                             { callers: 5, refreshesAtSink: 1, oneToken: 1, resolverCount: 1 },
  'refresh.rotationHandedOverNotStored':      { rotated: 1, newDiffers: true, previousWasOurs: true, appHoldsNew: true, live: 1, burned: 1 },
  'refresh.cachedUntilExpiry':                { same: true, refreshes: 1 },
  'bearerTarget.resolverMintsOnDemand':       { ok: true, sub: 'alice', refreshes: 1 },
  'resolver.invalidateForgetsOnlyThatToken':  { reminted: true, secondInvalidateIsNoop: true },
  'refresh.invalidGrantIsLost':               { answered: null, state: 'lost', failureKind: 'grant_lost', code: 'invalid_grant', laterGetFailsClosed: null, refreshesAtSink: 1 },
  'expiresIn.honoredByResolver':              { refreshedAfterExpiry: true, refreshes: 2, providerSaid: 1 },
  'expiresIn.droppedByWithCache':             { providerSaid: 1, cacheTtlMs: 60_000, sameTokenAfterExpiry: true, providerAnswers: 'token_invalid' },
  'token.rateLimitedNotReplayed':             { kind: 'rate_limited', retryAfterMs: 1000, retryable: true, attempts: 1 },
  'token.serverErrorNotReplayed':             { kind: 'server_error', retryable: false, attempts: 1 },
  'refresh.lostResponseBurnsTheGrant':        { kind: 'timeout', indeterminate: true, retryable: false, retryWithOldToken: 'grant_lost', attempts: 2 },
  'apple.secretIsEs256Jwt':                   { clientId: 'com.example.app', verifies: true, alg: 'ES256', sub: 'com.example.app', exp: 1_700_086_400 },
  'endpoint.declaredOriginReached':           { ok: true, keys: true, hits: 1 },
  'endpoint.foreignOriginRefused':            { kind: 'invalid_request', named: true },
  'bundle.callsPickTheirRole':                { tokenIsClientBasic: true, discoveryNoCredential: true, jwksNoCredential: true, userinfoIsCallersBearer: true },
}
if (process.env.FIXTURE_URL) {
  Object.assign(expected, {
    'fixture.discovery': { ok: true, issuer: true },
    'fixture.jwks':      { ok: true, keys: true },
    'fixture.unknownRefreshIsGrantLost': { kind: 'grant_lost', code: 'invalid_grant' },
    ...(process.env.FIXTURE_CODE
      ? { 'fixture.tokens': { ok: true }, 'fixture.idToken': { ok: true, reason: null }, 'fixture.userinfo': { ok: true, hasSub: true },
          'fixture.refresh': { ok: true, hasAccess: true }, 'fixture.codeReplayIsGrantLost': { kind: 'grant_lost', code: 'invalid_grant' } }
      : {}),
  })
}
process.exit(report(got, expected))
