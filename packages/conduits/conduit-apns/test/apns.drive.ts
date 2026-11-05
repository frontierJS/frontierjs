// test/apns.drive.ts -- APNs through a real conduit against the sink.
//
// Run: `bun run drive`. No fixture: nothing conforming to APNs runs locally,
// and no key exists on this machine.
//
// The negative control is the ES256 mint: the same connector with a key the
// sink did not issue must be `InvalidProviderToken`, or every row about the
// provider token is about the sink accepting anything with a dot in it.
//
// The 403 is measured beside conduit's replay: APNs's expired provider token
// is named by the signer's `refused`, so conduit forgets it and replays once
// (FJS-2721).

import { byRef, createConduit, withCache, type ConduitError } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startApnsSink } from '../sink.ts'
import {
  apnsTarget, bindApns, apnsTokenResolver, sendApns, payloadBytes, apnsSigners, translate, decodeJwt, APNS_TOKEN_TTL_MS, type ApnsPayload,
} from '../src/index.ts'

const { got, t } = results()
const sink = startApnsSink()
const ctl  = control(sink.url)

const apnsMint   = apnsTokenResolver(sink.apns)
const apnsCached = withCache(apnsMint, { ttl_ms: APNS_TOKEN_TTL_MS })

const conduit = createConduit({
  credentials: byRef({ APNS_KEY: apnsCached }),
  signers:     { ...apnsSigners },
  ...DRIVE_RESILIENCE,
})
await conduit.register(apnsTarget({ ref: 'APNS_KEY', address: sink.url }))
const apns = bindApns(conduit)

type Seen = { requests: { path: string; headers: Record<string, string>; body: string }[]; pushes: { id: string; to: string }[] }
const seen = () => ctl.seen() as unknown as Promise<Seen>
const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff'
const payload: ApnsPayload = { aps: { alert: { title: 'Order shipped', body: 'ORD-1 is on its way' }, badge: 1, sound: 'default' }, orderId: 'ORD-1' }
const pick = (e: { kind: string; code?: string; retryable: boolean; retryAfterMs?: number; timestamp?: number; indeterminate?: boolean } | undefined) =>
  e && { kind: e.kind, code: e.code, retryable: e.retryable, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}), ...(e.timestamp !== undefined ? { hasTimestamp: true } : {}), ...(e.indeterminate ? { indeterminate: true } : {}) }

try {
  // ─── APNs: the shape on the wire ──────────────────────────────────────
  const first = await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload, id: '11111111-2222-4333-8444-555555555555', expiration: 0, priority: 10 })
  const wire = (await seen()).requests[0]
  const jwt  = decodeJwt(wire.headers.authorization.slice(7))
  t('apns.send.succeeds', { ok: !first.error, id: first.result?.id, topic: wire.headers['apns-topic'], pushType: wire.headers['apns-push-type'], priority: wire.headers['apns-priority'], expiration: wire.headers['apns-expiration'],
    scheme: wire.headers.authorization.slice(0, 7), bodyIsJson: wire.body === JSON.stringify(payload) })
  t('apns.jwt.shape', { alg: jwt.header.alg, kid: jwt.header.kid, iss: jwt.payload.iss, iatIsSeconds: typeof jwt.payload.iat === 'number' && (jwt.payload.iat as number) < 1e11 })

  const second = await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload })
  const reqs = (await seen()).requests
  t('apns.jwt.isCachedAcrossSends', { ok: !second.error, sameToken: reqs[0].headers.authorization === reqs[1].headers.authorization, mints: apnsMint.mints(), mintedId: !!second.result?.id && second.result.id !== first.result?.id })

  // ─── negative control: a key Apple never issued ────────────────────────
  const { generateKeyPairSync } = await import('node:crypto')
  const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const forged = createConduit({ credentials: byRef({ APNS_KEY: apnsTokenResolver({ ...sink.apns, p8: stranger }) }), signers: { ...apnsSigners } })
  await forged.register(apnsTarget({ ref: 'APNS_KEY', address: sink.url }))
  const bad = await sendApns(bindApns(forged), { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload })
  await forged.destroy()
  t('apns.strangerKey.isInvalidProviderToken', pick(bad.error))

  // ─── the unregistered reading ──────────────────────────────────────────
  await ctl.reset()
  const badToken = await sendApns(apns, { deviceToken: DEVICE.slice(0, -4) + '0000', topic: 'com.example.shop', pushType: 'alert', payload })
  t('apns.badDeviceToken.isUnregistered', pick(badToken.error))
  const gone = await sendApns(apns, { deviceToken: DEVICE.slice(0, -4) + '4100', topic: 'com.example.shop', pushType: 'alert', payload })
  t('apns.unregistered410.carriesTimestamp', pick(gone.error))
  const disallowed = await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.forbidden', pushType: 'alert', payload })
  t('apns.topicDisallowed.isRefused', pick(disallowed.error))

  // ─── C9: refused here, nothing sent ────────────────────────────────────
  await ctl.reset()
  const fat: ApnsPayload = { aps: { alert: 'x' }, blob: 'y'.repeat(4097 - payloadBytes({ aps: { alert: 'x' }, blob: '' })) }
  let threw = ''
  try { await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload: fat }) } catch (e) { threw = (e as Error).message }
  t('apns.oversizedPayload.refusedBeforeSend', { bytes: payloadBytes(fat), threw: /4097 bytes, limit is 4096/.test(threw), sent: (await seen()).requests.length })

  // ─── the 403 measurement ───────────────────────────────────────────────
  await ctl.reset()
  await ctl.arm({ expireProviderToken: true })
  const before = apnsMint.mints()
  const expired = await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload })
  const replayed = (await seen()).requests
  t('apns.expiredProviderToken.remintedByConduit', { ok: !expired.error, attempts: replayed.length, mints: apnsMint.mints() - before, newToken: replayed[0]?.headers.authorization !== replayed[1]?.headers.authorization })

  // ─── chaos ─────────────────────────────────────────────────────────────
  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const limited = await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload })
  t('apns.rateLimited.handedToCaller', { ...pick(limited.error), attempts: (await seen()).requests.length })

  await ctl.reset()
  await ctl.arm({ failNext: true })
  const flaky = await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload })
  t('apns.serverError.notReplayed', { ...pick(flaky.error), attempts: (await seen()).requests.length })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const lost = await sendApns(apns, { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert', payload })
  t('apns.lostResponse.isIndeterminate', { ...pick(lost.error), attempts: (await seen()).requests.length, delivered: (await seen()).pushes.length })

  await ctl.reset()
  const dup = { deviceToken: DEVICE, topic: 'com.example.shop', pushType: 'alert' as const, payload, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
  const d1 = await sendApns(apns, dup), d2 = await sendApns(apns, dup)
  t('apns.sameIdTwice.isOnePush', { ok: !d1.error && !d2.error, sameId: d1.result?.id === d2.result?.id, pushes: (await seen()).pushes.length })

  // ─── the rest of the table, against the pure reader ────────────────────
  const synth = (kind: ConduitError['kind'], raw: unknown, retryable = false): ConduitError => ({ kind, target: 't', protocol: 'http', message: 'm', retryable, raw: JSON.stringify(raw) })
  t('translate.table', {
    payloadTooLarge: translate(synth('client_error', { reason: 'PayloadTooLarge' })).kind,
    tooMany:         translate(synth('rate_limited', { reason: 'TooManyRequests' }, true)).kind,
    notForTopic:     translate(synth('client_error', { reason: 'DeviceTokenNotForTopic' })).kind,
    unknownReason:   translate(synth('client_error', { reason: 'SomethingNew' })).kind,
    noBody:          translate(synth('timeout', undefined, true)).kind,
  })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); await conduit.destroy()
}

process.exit(report(got, {
  'apns.send.succeeds':                              { ok: true, id: '11111111-2222-4333-8444-555555555555', topic: 'com.example.shop', pushType: 'alert', priority: '10', expiration: '0', scheme: 'bearer ', bodyIsJson: true },
  'apns.jwt.shape':                                  { alg: 'ES256', kid: 'ABC123DEFG', iss: 'TEAM000001', iatIsSeconds: true },
  'apns.jwt.isCachedAcrossSends':                    { ok: true, sameToken: true, mints: 1, mintedId: true },
  'apns.strangerKey.isInvalidProviderToken':         { kind: 'remint', code: 'InvalidProviderToken', retryable: false },
  'apns.badDeviceToken.isUnregistered':              { kind: 'unregistered', code: 'BadDeviceToken', retryable: false },
  'apns.unregistered410.carriesTimestamp':           { kind: 'unregistered', code: 'Unregistered', retryable: false, hasTimestamp: true },
  'apns.topicDisallowed.isRefused':                  { kind: 'refused', code: 'TopicDisallowed', retryable: false },
  'apns.oversizedPayload.refusedBeforeSend':         { bytes: 4097, threw: true, sent: 0 },
  'apns.expiredProviderToken.remintedByConduit':     { ok: true, attempts: 2, mints: 1, newToken: true },
  'apns.rateLimited.handedToCaller':                 { kind: 'rate_limited', code: 'TooManyRequests', retryable: true, retryAfterMs: 1000, attempts: 1 },
  'apns.serverError.notReplayed':                    { kind: 'server_error', code: 'InternalServerError', retryable: false, indeterminate: true, attempts: 1 },
  'apns.lostResponse.isIndeterminate':               { kind: 'timeout', code: undefined, retryable: false, indeterminate: true, attempts: 1, delivered: 1 },
  'apns.sameIdTwice.isOnePush':                      { ok: true, sameId: true, pushes: 1 },
  'translate.table':                                 { payloadTooLarge: 'too_large', tooMany: 'rate_limited', notForTopic: 'unregistered', unknownReason: 'refused', noBody: 'timeout' },
}))
