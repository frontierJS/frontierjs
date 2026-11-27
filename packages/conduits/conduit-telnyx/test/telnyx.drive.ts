// test/telnyx.drive.ts — the connector against the sink. No fixture: nobody
// runs a local carrier. What is only provable here: `sent` and `delivered`
// are two columns and the receipt may arrive FIRST; a STOP from a person is
// classified before the app sees it; an Ed25519 event verifies over the raw
// bytes under a moved clock.
//
// The rest runs the voice half against the same sink: a dial and a repeated
// `command_id` that Telnyx drops, `client_state` coming back, a credential's
// life, a recording's link, an event parsed flat, a media stream the sink dials
// into a WebSocket this drive serves, and two tenants whose keys never cross.

import { createConduit, createStaticResolver, type ConduitError } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startTelnyxSink } from '../sink.ts'
import {
  telnyxTarget, bindSend, sendMessage, toE164, isE164, verifyTelnyxSignature, keywordOf, translate,
  dial, callAction, recordingLink, parseEvent, encodeClientState, decodeClientState,
  createCredential, deleteCredential, credentialToken, sipUri,
  parseFrame, mediaFrame, markFrame, toneAudio, silence, level, FRAME_MS, type StreamFrame, type TelnyxEventRecord,
} from '../src/index.ts'

const { got, t } = results()
const KEY = 'KEY_dev'
const inbox: { type: string; status: string; keyword: ReturnType<typeof keywordOf> }[] = []
const seenEvents: string[] = []
let publicKey = ''
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const v = await verifyTelnyxSignature({ rawBody: raw, headers: { 'telnyx-signature-ed25519': req.headers.get('telnyx-signature-ed25519'), 'telnyx-timestamp': req.headers.get('telnyx-timestamp') }, publicKey, now: Math.floor(Date.now() / 1000) })
    if (!v.ok) return Response.json({ error: v.reason }, { status: 401 })
    if (!seenEvents.includes(v.event.data.id)) { seenEvents.push(v.event.data.id); inbox.push({ type: v.event.data.event_type, status: v.event.data.payload.to[0].status, keyword: keywordOf(v.event.data.payload.text) }) }
    return Response.json({ ok: true })
  },
})
const sink = startTelnyxSink({ key: KEY, hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/telnyx` })
publicKey = sink.publicKey
// The voice half: its own sink, whose webhooks land in a second receiver so the
// call events can be read flat and the message rows above stay untouched.
const callEvents: TelnyxEventRecord[] = []
let callKey = ''
const callReceiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const v = await verifyTelnyxSignature({ rawBody: raw, headers: { 'telnyx-signature-ed25519': req.headers.get('telnyx-signature-ed25519'), 'telnyx-timestamp': req.headers.get('telnyx-timestamp') }, publicKey: callKey, now: Math.floor(Date.now() / 1000) })
    const ev = v.ok ? parseEvent(JSON.parse(raw)) : null
    if (ev) callEvents.push(ev)
    return Response.json({ ok: true })
  },
})
const csink = startTelnyxSink({ key: KEY, hookUrl: `http://127.0.0.1:${callReceiver.port}/`, callControlConnection: 'cc-drive', credentialConnection: 'cred-drive' })
callKey = csink.publicKey
// The sink dials this as Telnyx dials an app's `stream_url`.
const fromSink: StreamFrame[] = []
const streamServer = Bun.serve({
  port: 0,
  fetch(req, server) { return server.upgrade(req) ? undefined : new Response('upgrade', { status: 426 }) },
  websocket: {
    message(ws, data) {
      const f = parseFrame(data as string)
      if (!f) return
      fromSink.push(f)
      if (f.event === 'start') { ws.send(mediaFrame(toneAudio(100, 440))); ws.send(markFrame('m1')) }
    },
  },
})
const ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ TELNYX_API_KEY: KEY }), ...DRIVE_RESILIENCE })
await conduit.register(telnyxTarget({ address: sink.url }))
const send = bindSend(conduit)
await conduit.register(telnyxTarget({ id: 'provider:telnyx:calls', address: csink.url }))
const callSend = bindSend(conduit, 'provider:telnyx:calls')
const seen = () => ctl.seen() as unknown as Promise<{ requests: unknown[]; events: { type: string; status: number | null }[] }>
const settle = () => new Promise(r => setTimeout(r, 80))

try {
  t('e164.normalizes', { paren: toE164('(415) 555-0100', '1'), intl: toE164('+44 20 7946 0958'), zeros: toE164('0044 20 7946 0958') })
  let threw = ''
  try { toE164('555-0100') } catch (e) { threw = (e as Error).message }
  t('e164.refusesWithoutCountry', /no country code/.test(threw))

  const sent = await sendMessage(send, { from: '+15550001111', to: '+14155550100', text: 'hi' })
  await settle()
  t('send.queuedThenDeliveredLater', { ok: !sent.error, atSend: sent.message?.to[0].status, laterEvent: inbox.find(e => e.type === 'message.finalized')?.status })

  // The receipt arrives BEFORE the send answers: the app must not overwrite
  // `delivered` with the send's `queued`, which is why they are two columns.
  inbox.length = 0
  await ctl.arm({ finalizeFirst: true })
  const early = await sendMessage(send, { from: '+15550001111', to: '+14155550101', text: 'hi' })
  t('receipt.mayArriveBeforeSendAnswers', { sendSays: early.message?.to[0].status, receiptAlreadyIn: inbox.some(e => e.type === 'message.finalized' && e.status === 'delivered') })

  const stop = await sendMessage(send, { from: '+15550001111', to: '+14155550000', text: 'hi' })
  t('optedOut.isDomainAnswer', { kind: stop.error?.kind, code: stop.error?.code, retryable: stop.error?.retryable })
  const bad = await sendMessage(send, { from: '+15550001111', to: '+14155559999', text: 'hi' })
  t('invalidDestination.isDomainAnswer', { kind: bad.error?.kind, retryable: bad.error?.retryable })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const limited = await sendMessage(send, { from: '+15550001111', to: '+14155550102', text: 'hi' })
  t('rateLimited.handedToCaller', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await sendMessage(send, { from: '+15550001111', to: '+14155550103', text: 'hi' })
  const after = await seen()
  t('lostResponse.notReplayed', { kind: lost.error?.kind, retryable: lost.error?.retryable, attempts: after.requests.length })

  // A person texts STOP: the connector names the keyword, the app writes the row.
  inbox.length = 0
  await ctl.arm({ deliverTwice: true })
  await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: '+14155550100', to: '+15550001111', text: ' Stop ' }) })
  await settle()
  const ev = (await seen()).events.filter(e => e.type === 'message.received')
  t('inbound.stopClassifiedDeliveredTwiceOnce', { deliveries: ev.length, answered: ev.map(e => e.status), processed: inbox.length, keyword: inbox[0]?.keyword })

  const body = JSON.stringify({ data: { event_type: 'message.sent', id: 'e', occurred_at: 'x', payload: { to: [{ status: 'sent' }] } } })
  const now = 1_700_000_000
  const sign = async (ts: number) => {
    // The drive signs with its own key for the forged case; the sink's private key never leaves it.
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    return { sig: Buffer.from(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(`${ts}|${body}`))).toString('base64'), pub: Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64') }
  }
  const own = await sign(now)
  const v = (ts: number, sig: string, pub = own.pub) => verifyTelnyxSignature({ rawBody: body, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': String(ts) }, publicKey: pub, now }).then(r => r.ok)
  t('verify.ownKeyFreshAndMovedClock', { fresh: await v(now, own.sig), past: await v(now - 400, (await sign(now - 400)).sig), wrongKey: await v(now, own.sig, sink.publicKey) })

  // ── 3.1 ──
  const bodyOf = (code: string) => ({ kind: 'client_error', target: 't', protocol: 'http', message: 'HTTP 422', retryable: false, raw: JSON.stringify({ errors: [{ code, title: 'x' }] }) }) as ConduitError
  t('translate.carrier10039IsInvalidDestination', { kind: translate(bodyOf('10039')).kind, code: translate(bodyOf('10039')).code, retryable: translate(bodyOf('10039')).retryable })
  t('e164.isE164AsTheCarrierSpellsIt', { seven: isE164('+1234567'), full: isE164('+14155550100'), tooLong: isE164('+1234567890123456'), noPlus: isE164('14155550100'), notText: isE164(14155550100) })
  t('target.perCallerAndResilienceAreOptIn', {
    plain: { perCaller: 'per_caller' in telnyxTarget().auth, resilience: telnyxTarget().resilience ?? null },
    asked: { perCaller: (telnyxTarget({ perCaller: true }).auth as { per_caller?: true }).per_caller, resilience: telnyxTarget({ resilience: { retry_limit: 3, timeout_ms: 5000 } }).resilience },
  })

  // Two accounts on one conduit: the key a send spends is the one its `who`
  // names, and a send that names nobody spends nothing.
  const keysByTenant: Record<string, string> = { 'acct-a': 'KEY_a', 'acct-b': 'KEY_b' }
  const tsink = startTelnyxSink({ key: Object.values(keysByTenant) })
  const tenants = createConduit({ credentials: { ...createStaticResolver({}), getFor: async (ref, who) => ref === 'TELNYX_API_KEY' ? keysByTenant[who.tenant ?? ''] ?? null : null }, ...DRIVE_RESILIENCE })
  await tenants.register(telnyxTarget({ address: tsink.url, perCaller: true }))
  const tsend = bindSend(tenants)
  const asTenant = (tenant: string): typeof tsend => req => tsend({ ...req, who: { tenant, principal: null, grant: null } })
  const textFor = (tenant: string | null) => sendMessage(tenant ? asTenant(tenant) : tsend, { from: '+15550001111', to: '+14155550100', text: 'hi' })
  const forA = await textFor('acct-a'), forB = await textFor('acct-b')
  const noWho = await textFor(null), stranger = await textFor('acct-c')
  t('perCaller.eachTenantSpendsItsOwnKey', {
    ok:        [!forA.error, !forB.error],
    bearers:   tsink.log.map(r => r.bearer),
    noWho:     noWho.error?.kind,
    stranger:  stranger.error?.kind,
    sentCount: tsink.log.length,
  })
  const bare = createConduit({ credentials: createStaticResolver({ TELNYX_API_KEY: KEY }), ...DRIVE_RESILIENCE })
  let refused = ''
  try { await bare.register(telnyxTarget({ address: tsink.url, perCaller: true })) } catch (e) { refused = (e as Error).message }
  t('perCaller.refusedWhenTheResolverHasNoGetFor', { threw: refused !== '', names: /getFor/.test(refused) })
  tsink.stop(); await tenants.destroy(); await bare.destroy()

  // ── 3.2: the sink's key, and what it signs with ──
  const a1 = startTelnyxSink({ seed: 'drive-seed' }), a2 = startTelnyxSink({ seed: 'drive-seed' }), a3 = startTelnyxSink()
  t('sink.seedFixesTheKey', { sameSeedSameKey: a1.publicKey === a2.publicKey, freshKeyDiffers: a1.publicKey !== a3.publicKey, bytes: Buffer.from(a1.publicKey, 'base64').length })
  a1.stop(); a2.stop(); a3.stop()

  // ── Call control ──
  type CallState = { step: string; n: number }
  const state: CallState = { step: 'greet', n: 2 }
  const placed = await dial<CallState>(callSend, { connectionId: 'cc-drive', from: '+15550001111', to: '(415) 555-0100', defaultCountry: '1', commandId: 'dial-1', clientState: state })
  const again  = await dial<CallState>(callSend, { connectionId: 'cc-drive', from: '+15550001111', to: '(415) 555-0100', defaultCountry: '1', commandId: 'dial-1', clientState: state })
  const callId = placed.call?.call_control_id ?? ''
  const dialBody = csink.log.find(r => r.path === '/v2/calls')?.body
  t('dial.placesOnTheNamedConnectionAndAReplayPlacesNothing', {
    connection: dialBody?.connection_id, to: dialBody?.to, commandId: dialBody?.command_id,
    sameLegOnReplay: placed.call?.call_control_id === again.call?.call_control_id, legs: csink.legs.size,
  })
  const sipLeg = await dial(callSend, { connectionId: 'cc-drive', from: '+15550001111', to: sipUri('nobody'), commandId: 'dial-sip' })
  t('dial.sipPassesThroughAndAnUnknownIdentityIsRefused', { sent: csink.log.find(r => r.body?.command_id === 'dial-sip')?.body.to, kind: sipLeg.error?.kind, code: sipLeg.error?.code })
  await csink.idle()

  const first  = await callAction<CallState>(callSend, { callControlId: callId, action: 'speak', commandId: 'speak-1', clientState: { step: 'menu', n: 3 }, params: { payload: 'hello', voice: 'female' } })
  const repeat = await callAction<CallState>(callSend, { callControlId: callId, action: 'speak', commandId: 'speak-1', clientState: { step: 'menu', n: 3 }, params: { payload: 'hello', voice: 'female' } })
  await csink.idle()
  t('callAction.aRepeatedCommandIdActsOnce', {
    ok: [first.ok, repeat.ok],
    requests: csink.log.filter(r => r.body?.command_id === 'speak-1').length,
    spoken: callEvents.filter(e => e.type === 'call.speak.ended').length,
    body: csink.log.find(r => r.body?.command_id === 'speak-1')?.body.payload,
  })
  const gone = await callAction(callSend, { callControlId: 'v3:missing', action: 'hangup', commandId: 'hang-x' })
  t('callAction.aDeadCallIsARefusalNotAThrow', { ok: gone.ok, kind: gone.error?.kind, code: gone.error?.code })

  t('clientState.roundTrips', {
    codec:    decodeClientState(encodeClientState({ a: [1, 'é'], b: null })),
    notBase64Json: [decodeClientState('%%%'), decodeClientState(''), decodeClientState(undefined)],
    onTheLeg: decodeClientState(csink.legs.get(callId)?.clientState),
    echoed:   decodeClientState(callEvents.find(e => e.type === 'call.speak.ended')?.payload.client_state),
  })

  // ── Credentials ──
  const made = await createCredential(callSend, { connectionId: 'cred-drive', name: 'desk phone' })
  const sip = made.credential?.sip_username ?? ''
  const token = await credentialToken({ address: csink.url, key: KEY, credentialId: made.credential?.id ?? '' })
  const viaConduit = await callSend({ method: 'POST', path: `/v2/telephony_credentials/${made.credential?.id}/token`, body: {} })
  const dev = await dial(callSend, { connectionId: 'cc-drive', from: '+15550001111', to: sipUri(sip), commandId: 'dial-dev', linkTo: callId, timeoutSecs: 5 })
  const connection = csink.credentials.get(made.credential?.id ?? '')?.connection_id
  const removed = await deleteCredential(callSend, made.credential?.id ?? '')
  const gone2 = await credentialToken({ address: csink.url, key: KEY, credentialId: made.credential?.id ?? '' })
  const badKey = await credentialToken({ address: csink.url, key: 'wrong', credentialId: 'x' })
  const unreachable = await credentialToken({ address: 'http://127.0.0.1:1', key: KEY, credentialId: 'x' })
  t('credentials.createTokenDeviceLegDelete', {
    sip:        sipUri(sip) === `sip:${sip}@sip.telnyx.com`,
    connection,
    jwt:        token.token?.split('.').length,
    linkedLeg:  csink.legs.get(dev.call?.call_control_id ?? '')?.session === csink.legs.get(callId)?.session,
    removed:    removed.ok, left: csink.credentials.size,
    afterDelete: [gone2.error?.kind, gone2.error?.code], badKey: badKey.error?.kind, unreachable: [unreachable.error?.kind, unreachable.error?.retryable],
  })
  // Why `credentialToken` is not a `send`: the bare JWT has no content-type.
  t('credentials.conduitStillRefusesTheUntypedToken', viaConduit.error?.kind ?? 'accepted')

  // ── A recording, and the events the sink delivered ──
  const rec = await callAction(callSend, { callControlId: callId, action: 'record_start', commandId: 'rec-1', params: { format: 'mp3', channels: 'single' } })
  for (let i = 0; i < 50 && !callEvents.some(e => e.type === 'call.recording.saved'); i++) await new Promise(r => setTimeout(r, 20))
  const saved = callEvents.find(e => e.type === 'call.recording.saved')
  const link = await recordingLink(callSend, String(saved?.payload.recording_id))
  const noLink = await recordingLink(callSend, 'nope')
  t('recordingLink.askedForAtPlayTime', {
    started: rec.ok, link: /\/recordings\/[^/]+\.mp3\?X-Amz-Expires=600/.test(link.url ?? ''), matchesTheEvent: new URL(link.url!).pathname === new URL(saved!.payload.recording_urls.mp3).pathname,
    unknown: [noLink.error?.kind, noLink.error?.code],
  })
  const initiated = callEvents.find(e => e.type === 'call.initiated')
  t('parseEvent.flatRecord', {
    type: initiated?.type, keys: Object.keys(initiated ?? {}).sort(), leg: initiated?.payload.call_control_id === callId, when: !Number.isNaN(Date.parse(initiated?.occurredAt ?? '')),
    junk: [parseEvent(null), parseEvent({}), parseEvent({ data: { id: 'x', event_type: 'y' } }), parseEvent({ data: { record_type: 'event', id: 5, event_type: 'y' } })],
  })

  // ── The media stream ──
  const streamLeg = await dial<{ step: string }>(callSend, { connectionId: 'cc-drive', from: '+15550001111', to: '+14155550123', commandId: 'dial-stream', clientState: { step: 'agent' } })
  const streamId = streamLeg.call?.call_control_id ?? ''
  await new Promise(r => setTimeout(r, 60))
  const began = await callAction(callSend, { callControlId: streamId, action: 'streaming_start', commandId: 'stream-1', params: { stream_url: `ws://127.0.0.1:${streamServer.port}/`, stream_bidirectional_mode: 'rtp' } })
  for (let i = 0; i < 100 && !(fromSink.some(f => f.event === 'mark') && (csink.streams.get(streamId)?.echoed.length ?? 0) > 0); i++) await new Promise(r => setTimeout(r, 20))
  const ended = await callAction(callSend, { callControlId: streamId, action: 'streaming_stop', commandId: 'stream-2' })
  for (let i = 0; i < 50 && !fromSink.some(f => f.event === 'stop'); i++) await new Promise(r => setTimeout(r, 20))
  const st = csink.streams.get(streamId)
  const heard = fromSink.filter((f): f is Extract<StreamFrame, { event: 'media' }> => f.event === 'media')
  t('stream.theSinkDialsInAndFramesRoundTrip', {
    began: began.ok, ended: ended.ok,
    order: [fromSink[0]?.event, fromSink[1]?.event],
    startNamesTheLeg: (fromSink[1] as Extract<StreamFrame, { event: 'start' }> | undefined)?.start.call_control_id === streamId,
    callerAudio: heard.length >= 3 && heard.every(f => f.media.track === 'inbound'),
    markEchoed: fromSink.filter(f => f.event === 'mark').map(f => (f as { mark: { name: string } }).mark.name), sinkEchoed: st?.echoed,
    appAudioPlayed: (st?.playedMs ?? 0) >= 100, stopped: fromSink.some(f => f.event === 'stop'),
    startedEvent: callEvents.some(e => e.type === 'streaming.started'),
  })
  t('stream.codec', {
    junk: [parseFrame('nope'), parseFrame('{"event":"wat"}')],
    mediaFrame: JSON.parse(mediaFrame(new Uint8Array([1, 2]))).media.payload, markFrame: JSON.parse(markFrame('x')),
    toneIsLouderThanSilence: level(toneAudio(FRAME_MS, 220)) > 1000 && level(silence(FRAME_MS)) === 0,
  })

  // ── The two new refusals in the verifier ──
  const odd = await verifyTelnyxSignature({ rawBody: body, headers: { 'telnyx-signature-ed25519': own.sig, 'telnyx-timestamp': `${now}.5` }, publicKey: own.pub, now })
  const short = await verifyTelnyxSignature({ rawBody: body, headers: { 'telnyx-signature-ed25519': Buffer.alloc(10).toString('base64'), 'telnyx-timestamp': String(now) }, publicKey: own.pub, now })
  t('verify.refusesAFractionalTimestampAndAShortSignature', [odd, short].map(r => r.ok ? 'ok' : r.reason))
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); csink.stop(); receiver.stop(true); callReceiver.stop(true); streamServer.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'e164.normalizes':                { paren: '+14155550100', intl: '+442079460958', zeros: '+442079460958' },
  'e164.refusesWithoutCountry':     true,
  'send.queuedThenDeliveredLater':  { ok: true, atSend: 'queued', laterEvent: 'delivered' },
  'receipt.mayArriveBeforeSendAnswers': { sendSays: 'queued', receiptAlreadyIn: true },
  'optedOut.isDomainAnswer':        { kind: 'opted_out', code: '40300', retryable: false },
  'invalidDestination.isDomainAnswer': { kind: 'invalid_destination', retryable: false },
  'rateLimited.handedToCaller':     { kind: 'rate_limited', retryable: true, retryAfterMs: 1000, attempts: 1 },
  'lostResponse.notReplayed':       { kind: 'timeout', retryable: false, attempts: 1 },
  'inbound.stopClassifiedDeliveredTwiceOnce': { deliveries: 2, answered: [200, 200], processed: 1, keyword: 'STOP' },
  'verify.ownKeyFreshAndMovedClock': { fresh: true, past: false, wrongKey: false },
  'translate.carrier10039IsInvalidDestination': { kind: 'invalid_destination', code: '10039', retryable: false },
  'e164.isE164AsTheCarrierSpellsIt': { seven: true, full: true, tooLong: false, noPlus: false, notText: false },
  'target.perCallerAndResilienceAreOptIn': { plain: { perCaller: false, resilience: null }, asked: { perCaller: true, resilience: { retry_limit: 3, timeout_ms: 5000 } } },
  'perCaller.eachTenantSpendsItsOwnKey': { ok: [true, true], bearers: ['KEY_a', 'KEY_b'], noWho: 'auth_failed', stranger: 'auth_failed', sentCount: 2 },
  'perCaller.refusedWhenTheResolverHasNoGetFor': { threw: true, names: true },
  'sink.seedFixesTheKey': { sameSeedSameKey: true, freshKeyDiffers: true, bytes: 32 },
  'dial.placesOnTheNamedConnectionAndAReplayPlacesNothing': { connection: 'cc-drive', to: '+14155550100', commandId: 'dial-1', sameLegOnReplay: true, legs: 1 },
  'dial.sipPassesThroughAndAnUnknownIdentityIsRefused': { sent: 'sip:nobody@sip.telnyx.com', kind: 'refused', code: '10005' },
  'callAction.aRepeatedCommandIdActsOnce': { ok: [true, true], requests: 2, spoken: 1, body: 'hello' },
  'callAction.aDeadCallIsARefusalNotAThrow': { ok: false, kind: 'refused', code: '90018' },
  'clientState.roundTrips': { codec: { a: [1, 'é'], b: null }, notBase64Json: [null, null, null], onTheLeg: { step: 'menu', n: 3 }, echoed: { step: 'menu', n: 3 } },
  'credentials.createTokenDeviceLegDelete': { sip: true, connection: 'cred-drive', jwt: 3, linkedLeg: true, removed: true, left: 0, afterDelete: ['refused', '10005'], badKey: 'auth_failed', unreachable: ['connection_failed', true] },
  'credentials.conduitStillRefusesTheUntypedToken': 'invalid_response',
  'recordingLink.askedForAtPlayTime': { started: true, link: true, matchesTheEvent: true, unknown: ['refused', '10005'] },
  'parseEvent.flatRecord': { type: 'call.initiated', keys: ['id', 'occurredAt', 'payload', 'type'], leg: true, when: true, junk: [null, null, null, null] },
  'stream.theSinkDialsInAndFramesRoundTrip': { began: true, ended: true, order: ['connected', 'start'], startNamesTheLeg: true, callerAudio: true, markEchoed: ['m1'], sinkEchoed: ['m1'], appAudioPlayed: true, stopped: true, startedEvent: true },
  'stream.codec': { junk: [null, null], mediaFrame: 'AQI=', markFrame: { event: 'mark', mark: { name: 'x' } }, toneIsLouderThanSilence: true },
  'verify.refusesAFractionalTimestampAndAShortSignature': ['timestamp is not a whole number of seconds', 'signature is not 64 bytes'],
}))
