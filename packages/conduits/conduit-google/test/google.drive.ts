// test/google.drive.ts — the connector through a real conduit against the sink.
//
// Run: `bun run drive`. Starts and stops its own sink on an ephemeral port; the
// two targets register against the same port, since the sink tells the hosts
// apart by path. No fixture exists and no key: sink only.
//
// The negative control is the field mask: a raw send with the local check
// bypassed must be REFUSED by the sink with Google's 400 naming
// X-Goog-FieldMask, or the rows about the mask are about nothing.
//
// The `fcm.` rows run a second conduit (a service account, not a key) against
// the same listener: the RS256 mint is checked by the sink with node:crypto,
// and an expired access token (401) is forgotten and replayed once by conduit.
// The exchange is a send through its own target, so a token endpoint outage
// is measured as the FCM send's retryable `auth_failed` with nothing sent to
// FCM (FJS-2722).
//
// The `staticMap.` rows run a per-account conduit (`getFor`, one JSON value per
// account) against the Static API path; the sink verifies each signature with
// node:crypto, so a wrong secret is refused there and nowhere earlier.

import { byRef, createConduit, createStaticResolver, withCache, type ConduitError } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startGoogleSink, KNOWN_PLACES, SIGNING_SECRET, STATIC_PNG } from '../sink.ts'
import { maps as googleMaps, fcm as googleFcm } from '../src/index.ts'

const {
  googleMapsTargets, bindGoogleMaps, geocodeLegacy, searchText, geocode, placeDetails, driveTime, cacheKey, normalizeAddress,
  GOOGLE_MAPS_PLACES_TARGET, GOOGLE_MAPS_ROUTES_TARGET, GEOCODE_FIELD_MASK, RATE_LIMIT_FALLBACK_MS,
  googleStaticMapTarget, bindStaticMap, staticMap, signStaticMapUrl, staticMapCredential, staticMapSigners, GOOGLE_STATIC_MAP_TARGET,
} = googleMaps

const {
  fcmTargets, bindFcm, fcmTokenResolver, sendFcm, forgetAccessToken, fcmSigners, decodeJwt, FCM_TOKEN_TTL_MS, FCM_TOKEN_TARGET, translate: translateFcm,
} = googleFcm

const { got, t } = results()
const KEY = 'AIza-sink-dev'

type Seen = { requests: { api: string; method: string; path: string; headers: Record<string, string>; body: string; fieldMask: string | null; sku: string; keyInQuery?: boolean; query?: string; signed?: boolean | null }[] }

const sink    = startGoogleSink({ key: KEY })
const ctl     = control(sink.maps)
const seen    = () => ctl.seen() as unknown as Promise<Seen>
const attempts = async () => (await seen()).requests.length
const conduit = createConduit({ credentials: createStaticResolver({ GOOGLE_MAPS_API_KEY: KEY }), ...DRIVE_RESILIENCE })
const targets = googleMapsTargets({ placesAddress: sink.url, routesAddress: sink.url, geocodingAddress: sink.url })
await conduit.register(targets.places)
await conduit.register(targets.routes)
const maps = bindGoogleMaps(conduit, targets)

const TOWN_HALL = KNOWN_PLACES[0], DEPOT = KNOWN_PLACES[1]

try {
  // ── the two targets ────────────────────────────────────────────────────
  const real = googleMapsTargets()
  t('targets.twoHostsOneKey', {
    ids: [real.places.id, real.routes.id], hosts: [new URL(real.places.address).host, new URL(real.routes.address).host],
    sameRef: real.places.auth.type === 'api_key' && real.routes.auth.type === 'api_key' && real.places.auth.ref === real.routes.auth.ref && real.places.auth.ref === 'GOOGLE_MAPS_API_KEY',
    header: real.places.auth.type === 'api_key' ? real.places.auth.header : null,
  })

  // ── geocode: the shape on the wire ─────────────────────────────────────
  const hit = await geocode(maps, { address: '1 Town Hall Square, Springfield' })
  const first = (await seen()).requests[0]
  t('geocode.found', {
    answer: hit.result?.answer, id: hit.result?.answer === 'found' ? hit.result.place.id : null,
    location: hit.result?.answer === 'found' ? hit.result.location : null,
    keyOnWire: first.headers['x-goog-api-key'] === KEY, maskOnWire: first.fieldMask, sku: first.sku,
    path: first.path, body: JSON.parse(first.body),
  })

  const miss = await geocode(maps, { address: 'Nowhere Lane, Atlantis' })
  t('geocode.zeroResultsIsAnAnswer', { answer: miss.result?.answer, error: miss.error ?? null })

  // ── the field mask, refused before the send ────────────────────────────
  await ctl.reset()
  const thrown = async (f: () => Promise<unknown>) => { try { await f(); return '' } catch (e) { return (e as Error).message } }
  const none = await thrown(() => searchText(maps, { query: 'x', fieldMask: [] }))
  const star = await thrown(() => searchText(maps, { query: 'x', fieldMask: ['*'] }))
  const sub  = await thrown(() => placeDetails(maps, { id: TOWN_HALL.id, fieldMask: ['places.*'] }))
  t('fieldMask.missingRefusedLocally',  { threw: /field mask/.test(none), sent: await attempts() })
  t('fieldMask.wildcardRefusedLocally', { star: /expensive/.test(star), sub: /expensive/.test(sub), sent: await attempts() })

  // ── negative control: the same request past the local check ───────────
  const bare = await maps.places<unknown>({ method: 'POST', path: '/v1/places:searchText', body: { textQuery: 'x' }, replayable: true })
  const refusal = (await seen()).requests[0]
  t('fieldMask.sinkRefusesWithoutIt', {
    kind: bare.error?.kind, status: bare.meta.status, sku: refusal.sku,
    namesTheHeader: JSON.stringify(bare.error?.raw ?? '').includes('X-Goog-FieldMask'),
    conduitDidNotRetry: await attempts(),
  })

  // ── details ────────────────────────────────────────────────────────────
  await ctl.reset()
  const det = await placeDetails(maps, { id: TOWN_HALL.id })
  const detReq = (await seen()).requests[0]
  t('placeDetails.found', { method: detReq.method, path: detReq.path, mask: detReq.fieldMask, name: det.place?.displayName?.text, hasLocation: !!det.place?.location, types: det.place?.types ?? null })
  const gone = await placeDetails(maps, { id: 'ChIJ_never' })
  t('placeDetails.unknownIsGone', { kind: gone.error?.kind, status: gone.error?.status, retryable: gone.error?.retryable })

  // ── routes, on the other host ──────────────────────────────────────────
  await ctl.reset()
  const drive = await driveTime(maps, { origin: { placeId: TOWN_HALL.id }, destination: { address: DEPOT.formattedAddress } })
  const rReq = (await seen()).requests[0]
  t('driveTime.found', {
    answer: drive.result?.answer, api: rReq.api, path: rReq.path, mask: rReq.fieldMask, travelMode: JSON.parse(rReq.body).travelMode,
    plausible: drive.result?.answer === 'found' && drive.result.distanceMeters > 1000 && drive.result.distanceMeters < 5000 && drive.result.durationSeconds > 60,
    masked: drive.result?.answer === 'found' ? drive.result.route.polyline === undefined : null,
  })
  const noRoute = await driveTime(maps, { origin: { address: 'Nowhere' }, destination: { placeId: DEPOT.id } })
  t('driveTime.noRouteIsAnAnswer', { answer: noRoute.result?.answer, error: noRoute.error ?? null })

  // ── Google's refusals, read off the body ───────────────────────────────
  const bad = await maps.routes<unknown>({ method: 'POST', path: '/directions/v2:computeRoutes', headers: { 'X-Goog-FieldMask': 'routes.duration' }, body: { origin: { address: 'a' }, destination: { address: 'b' }, travelMode: 'TELEPORT' }, replayable: true })
  const { translate } = await import('../src/maps/errors.ts')
  const refused = bad.error ? translate(bad.error) : null
  t('invalidArgument.isRefused', { kind: refused?.kind, status: refused?.status, retryable: refused?.retryable })

  await ctl.reset()
  await ctl.arm({ denyApi: 'routes' })
  const denied = await driveTime(maps, { origin: { placeId: TOWN_HALL.id }, destination: { placeId: DEPOT.id } })
  // The key is the project's, so the next call on the same credential must still go out signed.
  const after = await placeDetails(maps, { id: DEPOT.id })
  t('permissionDenied.namesTheApi', { kind: denied.error?.kind, reason: denied.error?.reason, namesIt: (denied.error?.message ?? '').includes('Routes API'), retryable: denied.error?.retryable, keyStillUsed: !after.error && (await seen()).requests[1].headers['x-goog-api-key'] === KEY })

  const wrongKey = createConduit({ credentials: createStaticResolver({ GOOGLE_MAPS_API_KEY: 'AIza-wrong' }) })
  const wrongTargets = googleMapsTargets({ placesAddress: sink.url, geocodingAddress: sink.url })
  await wrongKey.register(wrongTargets.places)
  const badKey = await geocode(bindGoogleMaps(wrongKey, wrongTargets), { address: 'x' })
  await wrongKey.destroy()
  t('wrongKey.isAuthFailedNotRefused', { conduitSaw: badKey.error ? 'client_error' : null, kind: badKey.error?.kind, reason: badKey.error?.reason })

  // ── legacy Geocoding: the key only as ?key= (FJS-2727) ─────────────────
  const observed: unknown[] = []
  const legacy = createConduit({ credentials: createStaticResolver({ GOOGLE_MAPS_API_KEY: KEY }), observers: { onRequest: (r) => { observed.push(r) } }, ...DRIVE_RESILIENCE })
  await legacy.register(targets.geocoding)
  const geoSend = bindGoogleMaps(legacy, targets)
  await ctl.reset()
  const legacyHit = await geocodeLegacy(geoSend, { address: '400 Depot Street, Springfield' })
  const legacyReq = (await seen()).requests[0]
  t('geocoding.keyInQueryOnly', {
    answer: legacyHit.result?.answer, location: legacyHit.result?.answer === 'found' ? legacyHit.result.location : null,
    keyInQuery: legacyReq?.keyInQuery, keyHeader: legacyReq?.headers['x-goog-api-key'] ?? null,
    keyNotObserved: observed.length > 0 && !JSON.stringify(observed).includes(KEY),
    keyNotInResult: !JSON.stringify(legacyHit).includes(KEY),
  })
  const legacyMiss = await geocodeLegacy(geoSend, { address: 'Nowhere Lane, Atlantis' })
  t('geocoding.zeroResultsIsAnAnswer', { answer: legacyMiss.result?.answer, error: legacyMiss.error ?? null })
  await legacy.destroy()
  const legacyWrong = createConduit({ credentials: createStaticResolver({ GOOGLE_MAPS_API_KEY: 'AIza-wrong' }) })
  await legacyWrong.register(targets.geocoding)
  const denied2 = await geocodeLegacy(bindGoogleMaps(legacyWrong, targets), { address: 'x' })
  await legacyWrong.destroy()
  t('geocoding.requestDeniedIsAuthFailed', { kind: denied2.error?.kind, status: denied2.error?.status, retryable: denied2.error?.retryable })

  // ── chaos ──────────────────────────────────────────────────────────────
  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const t0 = Date.now()
  const limited = await geocode(maps, { address: TOWN_HALL.formattedAddress })
  t('rateLimited.withRetryAfter.waits', { answer: limited.result?.answer, waitedAtLeast: Date.now() - t0 >= 1000, attempts: await attempts() })

  await ctl.reset()
  await ctl.arm({ rateLimit: { times: DRIVE_RESILIENCE.retry_limit + 1 } })
  const starved = await geocode(maps, { address: TOWN_HALL.formattedAddress })
  t('rateLimited.noRetryAfter.suppliesSixtySeconds', { kind: starved.error?.kind, retryAfterMs: starved.error?.retryAfterMs, retryable: starved.error?.retryable, attempts: await attempts(), sixty: RATE_LIMIT_FALLBACK_MS })

  await ctl.reset()
  await ctl.arm({ failNext: true })
  const flaky = await geocode(maps, { address: TOWN_HALL.formattedAddress })
  t('unavailable.isReplayed', { answer: flaky.result?.answer, attempts: await attempts() })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const lost = await geocode(maps, { address: TOWN_HALL.formattedAddress })
  t('lostResponse.readIsReplayed', { answer: lost.result?.answer, attempts: await attempts() })

  // ── the cache is the app's; the key is ours ────────────────────────────
  await ctl.reset()
  await geocode(maps, { address: '1 Town Hall Square, Springfield' })
  await geocode(maps, { address: '1 town hall square,  springfield.' })
  t('cacheKey.stableAndNotCachedHere', {
    same: cacheKey('1 Town Hall Square, Springfield') === cacheKey(' 1 town hall square ,  springfield. '),
    region: cacheKey('x', { region: 'US' }) === cacheKey('x', { region: 'us' }) && cacheKey('x', { region: 'US' }) !== cacheKey('x'),
    streetStaysDistinct: cacheKey('400 Depot St') !== cacheKey('400 Depot Street'),
    key: cacheKey('1 Town Hall Square, Springfield'), normalized: normalizeAddress(' 1 Town Hall Square ,Springfield. '),
    chargedTwice: await attempts(),
  })
  t('geocode.maskIsEssentialsOnly', GEOCODE_FIELD_MASK)

  // ═══ staticMap: one image, the account's own key and signing secret ═══
  {
    const observed: unknown[] = []
    const WRONG_SECRET = 'd3Jvbmctc2VjcmV0LWZpeHR1cmU'
    const stored: Record<string, string> = {
      'acct-1': staticMapCredential(KEY, SIGNING_SECRET),
      'acct-3': staticMapCredential(KEY),
      'acct-4': staticMapCredential(KEY, WRONG_SECRET),
      'acct-5': 'not json',
    }
    const sconduit = createConduit({
      credentials: { ...createStaticResolver({}), get: async () => null,
        getFor: async (ref: string, who) => ref === 'GOOGLE_STATIC_MAP_CREDENTIAL' ? stored[who.tenant ?? ''] ?? null : null },
      signers: staticMapSigners,
      observers: { onRequest: (r) => { observed.push(r) }, onResponse: (r, res) => { observed.push(r, res) }, onError: (r, e) => { observed.push(r, e) } },
      ...DRIVE_RESILIENCE,
    })
    await sconduit.register(googleStaticMapTarget({ address: sink.url }))
    const sm = bindStaticMap(sconduit)
    const as = (tenant: string) => ({ who: { tenant, principal: null, grant: null } })
    const HOME = { center: { lat: 39.799, lng: -89.644 }, zoom: 19, width: 640, height: 400, scale: 2 as const }
    const same = (a?: Uint8Array) => !!a && a.length === STATIC_PNG.length && a.every((v, i) => v === STATIC_PNG[i])
    const signatures = async () => (await seen()).requests.map(r => new URLSearchParams(r.query ?? '').get('signature')).filter((x): x is string => !!x)
    const leaks = (v: unknown, extra: string[] = []) => { const j = JSON.stringify(v, (_k, x) => x instanceof Uint8Array ? undefined : x); return [KEY, SIGNING_SECRET, ...extra].some(x => j.includes(x) || j.includes(encodeURIComponent(x))) }
    let wrong: ReturnType<typeof createConduit> | undefined

    try {
      const real = googleStaticMapTarget()
      t('staticMap.target', { id: real.id, host: new URL(real.address).host, auth: real.auth })

      await ctl.reset()
      const img = await staticMap(sm, HOME, as('acct-1'))
      const r0 = (await seen()).requests[0]
      const q = new URLSearchParams(r0?.query ?? '')
      t('staticMap.signedImageRoundTrips', {
        same: same(img.image?.bytes), type: img.image?.contentType, cache: img.image?.cacheControl,
        path: r0?.path, center: q.get('center'), zoom: q.get('zoom'), size: q.get('size'), scale: q.get('scale'), maptype: q.get('maptype'),
        keyInQuery: r0?.keyInQuery, signatureLast: (r0?.query ?? '').split('&').pop()?.startsWith('signature='), sinkVerified: r0?.signed,
      })

      // Through conduit: the sink verifies with node:crypto, apart from the WebCrypto signer.
      await ctl.reset()
      const wrongSecret = await staticMap(sm, HOME, as('acct-4'))
      const unsigned = await staticMap(sm, HOME, as('acct-3'))
      const verdicts = (await seen()).requests.map(r => r.signed)
      t('staticMap.signature', {
        vector: await signStaticMapUrl('/maps/api/geocode/json?address=New+York&client=clientID', 'vNIXE0xscrmjlyV-12Nj_BvUPaw='),
        wrongSecret: { kind: wrongSecret.error?.kind, status: wrongSecret.error?.status }, unsignedOk: same(unsigned.image?.bytes), sinkSaw: verdicts,
      })
      const sigs = [q.get('signature') ?? '', ...await signatures()].filter(Boolean)
      t('staticMap.keyAndSignatureNeverObserved', { observed: observed.length > 0, leaked: leaks(observed, sigs), inResults: leaks([img, wrongSecret, unsigned], sigs), signaturesSeen: sigs.length })

      await ctl.reset()
      const none = await staticMap(sm, HOME, as('acct-2'))
      const noWho = await staticMap(sm, HOME)
      const malformed = await staticMap(sm, HOME, as('acct-5'))
      t('staticMap.noKeySendsNothing', { kind: none.error?.kind, retryable: none.error?.retryable, noWho: noWho.error?.kind, malformed: malformed.error?.kind, malformedNamesShape: /\{ key, secret\? \}/.test(malformed.error?.message ?? ''), sent: await attempts() })

      const refusals = await Promise.all([
        { ...HOME, center: { lat: 90.1, lng: 0 } }, { ...HOME, center: { lat: 0, lng: -180.5 } }, { ...HOME, center: { lat: Number.NaN, lng: 0 } },
        { ...HOME, zoom: 22 }, { ...HOME, zoom: 1.5 }, { ...HOME, width: 641 }, { ...HOME, height: 0 },
        { ...HOME, scale: 3 as unknown as 2 }, { ...HOME, maptype: 'streetview' as unknown as 'satellite' },
      ].map(r => staticMap(sm, r, as('acct-1'))))
      t('staticMap.rangeRefusedBeforeSend', { kinds: [...new Set(refusals.map(r => r.error?.kind))], each: refusals.map(r => r.error?.message.split(' ')[0]), sent: await attempts() })

      // Negative control: past the local check, the sink refuses the same size.
      const raw = await sm<unknown>({ method: 'GET', path: '/maps/api/staticmap', query: { center: '0,0', zoom: '1', size: '641x641' }, who: as('acct-1').who })
      t('staticMap.sinkRefusesOutOfRange', { kind: raw.error?.kind, status: raw.meta.status })

      wrong = createConduit({ credentials: { ...createStaticResolver({}), getFor: async () => staticMapCredential('AIza-wrong', SIGNING_SECRET) }, signers: staticMapSigners, ...DRIVE_RESILIENCE })
      await wrong.register(googleStaticMapTarget({ address: sink.url }))
      await ctl.reset()
      const bad = await staticMap(bindStaticMap(wrong), HOME, as('acct-1'))
      t('staticMap.wrongKeyIsBadKey', { kind: bad.error?.kind, status: bad.error?.status, leaked: leaks(bad), sent: await attempts() })

      await ctl.reset(); await ctl.arm({ markup200: true })
      const mk = await staticMap(sm, HOME, as('acct-1'))
      t('staticMap.markup200IsConduitsRefusal', { image: mk.image ?? null, kind: mk.error?.kind })
      await ctl.reset(); await ctl.arm({ failNext: true })
      const flaky = await staticMap(sm, HOME, as('acct-1'))
      t('staticMap.unavailableIsReplayedSigned', { ok: same(flaky.image?.bytes), attempts: await attempts(), bothVerified: (await seen()).requests.every(r => r.signed === true) })
    } finally {
      await sconduit.destroy(); await wrong?.destroy()
    }
  }

  // ═══ fcm: the service-account module, same listener ═════════════════════
  {
    const fctl  = control(sink.fcm)
    const fseen = () => fctl.seen() as unknown as Promise<{ requests: { path: string; headers: Record<string, string>; body: string }[]; pushes: { id: string; to: string }[] }>
    const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff'
    const fpick = (e: { kind: string; code?: string; retryable: boolean; retryAfterMs?: number } | undefined) =>
      e && { kind: e.kind, code: e.code, retryable: e.retryable, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) }

    const tokenErrors: ConduitError[] = []
    // Bound late: the resolver sends through the conduit it is handed to.
    const fcmMint   = fcmTokenResolver(sink.serviceAccount, { tokenUrl: sink.tokenUrl, send: req => fcmSend.token(req) })
    const fcmCached = withCache(fcmMint, { ttl_ms: FCM_TOKEN_TTL_MS })
    const fconduit  = createConduit({
      credentials: byRef({ FCM_SA: fcmCached }),
      signers:     { ...fcmSigners },
      observers:   { onError: (_req, err) => { if (err.target === FCM_TOKEN_TARGET) tokenErrors.push(err) } },
      ...DRIVE_RESILIENCE,
    })
    const fcmT = fcmTargets({ ref: 'FCM_SA', projectId: sink.projectId, address: sink.url, tokenUrl: sink.tokenUrl })
    await fconduit.register(fcmT.token)
    await fconduit.register(fcmT.api)
    const fcmSend = bindFcm(fconduit, fcmT)
    const forget = () => forgetAccessToken(fcmCached, 'FCM_SA')

    try {
      const f1 = await sendFcm(fcmSend, sink.projectId, { token: DEVICE, notification: { title: 'Order shipped', body: 'ORD-1' }, data: { orderId: 'ORD-1' } })
      const fcmReqs = (await fseen()).requests
      const exchange = fcmReqs.find(r => r.path === '/token')
      const assertion = exchange && decodeJwt(new URLSearchParams(exchange.body).get('assertion') ?? '')
      t('fcm.send.succeeds', { ok: !f1.error, hasId: !!f1.result?.id, exchangedFirst: fcmReqs[0]?.path === '/token',
        grant: exchange && new URLSearchParams(exchange.body).get('grant_type'), alg: assertion?.header.alg, iss: assertion?.payload.iss, aud: assertion?.payload.aud,
        scheme: fcmReqs[1]?.headers.authorization.slice(0, 7), bodyWrapsMessage: JSON.parse(fcmReqs[1]?.body ?? '{}').message?.token === DEVICE })
      const f2 = await sendFcm(fcmSend, sink.projectId, { topic: 'news', notification: { title: 'Hi' } })
      t('fcm.token.isCachedAcrossSends', { ok: !f2.error, exchanges: fcmMint.exchanges(), tokenCalls: (await fseen()).requests.filter(r => r.path === '/token').length })

      const unreg = await sendFcm(fcmSend, sink.projectId, { token: DEVICE.slice(0, -4) + '0000', notification: { title: 'x' } })
      t('fcm.unregistered.isUnregistered', fpick(unreg.error))
      const mismatch = await sendFcm(fcmSend, sink.projectId, { token: DEVICE.slice(0, -4) + '9999', notification: { title: 'x' } })
      t('fcm.senderIdMismatch.isForbidden', fpick(mismatch.error))

      await fctl.reset()
      await fctl.arm({ rateLimit: { retryAfter: 2 } })
      const quota = await sendFcm(fcmSend, sink.projectId, { token: DEVICE, notification: { title: 'x' } })
      t('fcm.quotaExceeded.handedToCaller', { ...fpick(quota.error), attempts: (await fseen()).requests.length })

      let threw = ''
      try { await sendFcm(fcmSend, sink.projectId, { token: DEVICE, topic: 'news' }) } catch (e) { threw = (e as Error).message }
      t('fcm.twoRecipients.refusedBeforeSend', /exactly one of token, topic, condition/.test(threw))

      // The 401: forgotten and replayed once by conduit.
      await fctl.reset()
      await fctl.arm({ expireAccessToken: true })
      const ex = fcmMint.exchanges()
      const reminted = await sendFcm(fcmSend, sink.projectId, { token: DEVICE, notification: { title: 'x' } })
      const r = (await fseen()).requests
      t('fcm.expiredAccessToken.remintedByConduit', { ok: !reminted.error, exchanges: fcmMint.exchanges() - ex, sends: r.filter(x => x.path.endsWith(':send')).length, order: r.map(x => x.path === '/token' ? 'token' : 'send') })

      await fctl.reset()
      await fctl.arm({ invalidGrant: true })
      await forget()
      const refusedGrant = await sendFcm(fcmSend, sink.projectId, { token: DEVICE, notification: { title: 'x' } })
      t('fcm.invalidGrant.isAuthFailedBeforeSend', { ...fpick(refusedGrant.error), refusal: fcmMint.lastRefusal()?.code, sends: (await fseen()).requests.filter(x => x.path.endsWith(':send')).length })

      // The token endpoint down: the mint's failure, carried.
      await forget()
      await fctl.reset()
      await fctl.arm({ tokenUnavailable: true })
      tokenErrors.length = 0
      const down = await sendFcm(fcmSend, sink.projectId, { token: DEVICE, notification: { title: 'x' } })
      const downSeen = (await fseen()).requests
      t('fcm.tokenEndpointDown.isRetryableAuthFailed', { ...fpick(down.error), exchanges: downSeen.filter(x => x.path === '/token').length,
        sends: downSeen.filter(x => x.path.endsWith(':send')).length, observedAt: tokenErrors[0]?.target, observedKind: tokenErrors[0]?.kind })

      // The rest of the table, against the pure reader.
      const synth = (kind: ConduitError['kind'], raw: unknown, retryable = false): ConduitError => ({ kind, target: 't', protocol: 'http', message: 'm', retryable, raw: JSON.stringify(raw) })
      t('fcm.translate.table', {
        invalidArg:  translateFcm(synth('client_error', { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } })).kind,
        unavailable: translateFcm(synth('server_error', { error: { status: 'UNAVAILABLE', message: 'The service is currently unavailable.', details: [{ errorCode: 'UNAVAILABLE' }] } }, true)),
        noBody:      translateFcm(synth('timeout', undefined, true)).kind,
      })
    } finally {
      await fconduit.destroy()
    }
  }
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); await conduit.destroy()
}

process.exit(report(got, {
  'targets.twoHostsOneKey':             { ids: [GOOGLE_MAPS_PLACES_TARGET, GOOGLE_MAPS_ROUTES_TARGET], hosts: ['places.googleapis.com', 'routes.googleapis.com'], sameRef: true, header: 'X-Goog-Api-Key' },
  'geocode.found':                      { answer: 'found', id: TOWN_HALL.id, location: TOWN_HALL.location, keyOnWire: true, maskOnWire: 'places.id,places.formattedAddress,places.location', sku: 'essentials', path: '/v1/places:searchText', body: { textQuery: '1 Town Hall Square, Springfield', maxResultCount: 1 } },
  'geocode.zeroResultsIsAnAnswer':      { answer: 'zero_results', error: null },
  'fieldMask.missingRefusedLocally':    { threw: true, sent: 0 },
  'fieldMask.wildcardRefusedLocally':   { star: true, sub: true, sent: 0 },
  'fieldMask.sinkRefusesWithoutIt':     { kind: 'client_error', status: 400, sku: 'refused', namesTheHeader: true, conduitDidNotRetry: 1 },
  'placeDetails.found':                 { method: 'GET', path: `/v1/places/${TOWN_HALL.id}`, mask: 'id,formattedAddress,location,displayName', name: 'Springfield Town Hall', hasLocation: true, types: null },
  'placeDetails.unknownIsGone':         { kind: 'gone', status: 'NOT_FOUND', retryable: false },
  'driveTime.found':                    { answer: 'found', api: 'routes', path: '/directions/v2:computeRoutes', mask: 'routes.duration,routes.distanceMeters', travelMode: 'DRIVE', plausible: true, masked: true },
  'driveTime.noRouteIsAnAnswer':        { answer: 'no_route', error: null },
  'invalidArgument.isRefused':          { kind: 'refused', status: 'INVALID_ARGUMENT', retryable: false },
  'permissionDenied.namesTheApi':       { kind: 'forbidden', reason: 'SERVICE_DISABLED', namesIt: true, retryable: false, keyStillUsed: true },
  'wrongKey.isAuthFailedNotRefused':    { conduitSaw: 'client_error', kind: 'auth_failed', reason: 'API_KEY_INVALID' },
  'rateLimited.withRetryAfter.waits':   { answer: 'found', waitedAtLeast: true, attempts: 2 },
  'rateLimited.noRetryAfter.suppliesSixtySeconds': { kind: 'rate_limited', retryAfterMs: 60_000, retryable: true, attempts: 3, sixty: 60_000 },
  'unavailable.isReplayed':             { answer: 'found', attempts: 2 },
  'lostResponse.readIsReplayed':        { answer: 'found', attempts: 2 },
  'cacheKey.stableAndNotCachedHere':    { same: true, region: true, streetStaysDistinct: true, key: 'google-maps:geocode:1 town hall square, springfield', normalized: '1 town hall square, springfield', chargedTwice: 2 },
  'geocode.maskIsEssentialsOnly':       ['places.id', 'places.formattedAddress', 'places.location'],
  'geocoding.keyInQueryOnly':           { answer: 'found', location: DEPOT.location, keyInQuery: true, keyHeader: null, keyNotObserved: true, keyNotInResult: true },
  'geocoding.zeroResultsIsAnAnswer':    { answer: 'zero_results', error: null },
  'geocoding.requestDeniedIsAuthFailed': { kind: 'auth_failed', status: 'REQUEST_DENIED', retryable: false },
  'staticMap.target':                   { id: GOOGLE_STATIC_MAP_TARGET, host: 'maps.googleapis.com', auth: { type: 'signed', ref: 'GOOGLE_STATIC_MAP_CREDENTIAL', signer: 'google-maps-url', per_caller: true } },
  'staticMap.signedImageRoundTrips':    { same: true, type: 'image/png', cache: 'public, max-age=86400', path: '/maps/api/staticmap', center: '39.799000,-89.644000', zoom: '19', size: '640x400', scale: '2', maptype: 'satellite', keyInQuery: true, signatureLast: true, sinkVerified: true },
  'staticMap.signature':                { vector: 'chaRF2hTJKOScPr-RQCEhZbSzIE=', wrongSecret: { kind: 'bad_key', status: 403 }, unsignedOk: true, sinkSaw: [false, null] },
  'staticMap.keyAndSignatureNeverObserved': { observed: true, leaked: false, inResults: false, signaturesSeen: 2 },
  'staticMap.noKeySendsNothing':        { kind: 'no_key', retryable: false, noWho: 'no_key', malformed: 'no_key', malformedNamesShape: true, sent: 0 },
  'staticMap.rangeRefusedBeforeSend':   { kinds: ['refused'], each: ['center.lat', 'center.lng', 'center.lat', 'zoom', 'zoom', 'width', 'height', 'scale', 'maptype'], sent: 0 },
  'staticMap.sinkRefusesOutOfRange':    { kind: 'client_error', status: 400 },
  'staticMap.wrongKeyIsBadKey':         { kind: 'bad_key', status: 403, leaked: false, sent: 1 },
  'staticMap.markup200IsConduitsRefusal': { image: null, kind: 'invalid_response' },
  'staticMap.unavailableIsReplayedSigned': { ok: true, attempts: 2, bothVerified: true },
  'fcm.send.succeeds':                               { ok: true, hasId: true, exchangedFirst: true, grant: 'urn:ietf:params:oauth:grant-type:jwt-bearer', alg: 'RS256', iss: sink.serviceAccount.client_email, aud: sink.tokenUrl, scheme: 'Bearer ', bodyWrapsMessage: true },
  'fcm.token.isCachedAcrossSends':                   { ok: true, exchanges: 1, tokenCalls: 1 },
  'fcm.unregistered.isUnregistered':                 { kind: 'unregistered', code: 'UNREGISTERED', retryable: false },
  'fcm.senderIdMismatch.isForbidden':                { kind: 'forbidden', code: 'SENDER_ID_MISMATCH', retryable: false },
  'fcm.quotaExceeded.handedToCaller':                { kind: 'rate_limited', code: 'QUOTA_EXCEEDED', retryable: true, retryAfterMs: 2000, attempts: 1 },
  'fcm.twoRecipients.refusedBeforeSend':             true,
  'fcm.expiredAccessToken.remintedByConduit':        { ok: true, exchanges: 1, sends: 2, order: ['send', 'token', 'send'] },
  'fcm.invalidGrant.isAuthFailedBeforeSend':         { kind: 'auth_failed', code: undefined, retryable: false, refusal: 'invalid_grant', sends: 0 },
  'fcm.tokenEndpointDown.isRetryableAuthFailed':     { kind: 'auth_failed', code: undefined, retryable: true, exchanges: 3, sends: 0, observedAt: 'provider:google-oauth', observedKind: 'server_error' },
  'fcm.translate.table':                             { invalidArg: 'refused', unavailable: { kind: 'server_error', message: 'FCM: The service is currently unavailable.', retryable: true, code: 'UNAVAILABLE' }, noBody: 'timeout' },
}))
