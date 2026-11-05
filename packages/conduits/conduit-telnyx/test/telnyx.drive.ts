// test/telnyx.drive.ts — the connector against the sink. No fixture: nobody
// runs a local carrier. What is only provable here: `sent` and `delivered`
// are two columns and the receipt may arrive FIRST; a STOP from a person is
// classified before the app sees it; an Ed25519 event verifies over the raw
// bytes under a moved clock.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startTelnyxSink } from '../sink.ts'
import { telnyxTarget, bindSend, sendMessage, toE164, verifyTelnyxSignature, keywordOf } from '../src/index.ts'

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
const sink = await startTelnyxSink({ key: KEY, hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/telnyx` })
publicKey = sink.publicKey
const ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ TELNYX_API_KEY: KEY }), ...DRIVE_RESILIENCE })
await conduit.register(telnyxTarget({ address: sink.url }))
const send = bindSend(conduit)
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
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

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
}))
