// test/twilio.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: Basic rides the signer seam and the body is a
// form; the webhook verifies against the PUBLIC url the app knows and fails
// against the internal one a proxy shows; a delivery status arrives on a
// later webhook as a second column; opted-out and 10DLC refusals are domain
// answers.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startTwilioSink } from '../sink.ts'
import { twilioTarget, bindSend, sendMessage, getMessage, verifyTwilioSignature, toE164 } from '../src/index.ts'

const { got, t } = results()
const sink = startTwilioSink(), ctl = control(sink.url)
const inbox: { type: string; status?: string; keyword: unknown }[] = []
const seenSids: string[] = []
let publicUrl = ''
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const kind = new URL(req.url).pathname.endsWith('/status') ? 'status' : 'inbound'
    const v = verifyTwilioSignature({ url: `${publicUrl}/${kind}`, rawBody: raw, header: req.headers.get('x-twilio-signature'), authToken: sink.authToken })
    if (!v.ok) return new Response(v.reason, { status: 401 })
    const id = `${kind}:${v.params.MessageSid}`
    if (!seenSids.includes(id)) { seenSids.push(id); inbox.push({ type: kind, status: v.params.MessageStatus, keyword: v.keyword }) }
    return new Response('<Response/>', { headers: { 'content-type': 'text/xml' } })
  },
})
// The URL Twilio is TOLD — here it is the receiver's own, which is the easy case.
publicUrl = `http://127.0.0.1:${receiver.port}/webhooks/twilio`
const conduit = createConduit({ credentials: createStaticResolver({ TWILIO_CREDENTIAL: `${sink.accountSid}:${sink.authToken}` }), ...DRIVE_RESILIENCE })
await conduit.register(twilioTarget({ address: sink.url }))
const send = bindSend(conduit)
const seen = () => ctl.seen() as unknown as Promise<{ requests: { headers: Record<string, string>; body: string }[]; events: { type: string; status: number | null }[] }>
const settle = () => new Promise(r => setTimeout(r, 80))
const base = { accountSid: sink.accountSid, from: '+15550001111' }

try {
  const sent = await sendMessage(send, { ...base, to: '(415) 555-0100', defaultCountry: '1', body: 'hi', statusCallback: `${publicUrl}/status` })
  const wire = (await seen()).requests[0]
  await settle()
  t('send.basicOverForm', { ok: !sent.error, status: sent.message?.status, auth: wire.headers.authorization === `Basic ${Buffer.from(`${sink.accountSid}:${sink.authToken}`).toString('base64')}`, form: wire.body.includes('To=%2B14155550100'), laterStatus: inbox.find(e => e.type === 'status')?.status })

  const got1 = await getMessage(send, sink.accountSid, sent.message!.sid)
  t('get.resolvesLater', { status: got1.message?.status })

  t('optedOut.isDomainAnswer', (({ error }) => ({ kind: error?.kind, code: error?.code, retryable: error?.retryable }))(await sendMessage(send, { ...base, to: '+14155550000', body: 'hi' })))
  t('invalidDestination.isDomainAnswer', (({ error }) => ({ kind: error?.kind, code: error?.code }))(await sendMessage(send, { ...base, to: '+14155559999', body: 'hi' })))
  t('tenDlc.isUnregistered', (({ error }) => ({ kind: error?.kind, code: error?.code }))(await sendMessage(send, { ...base, to: '+14155558888', body: 'hi' })))
  let threw = ''
  try { await sendMessage(send, { ...base, to: '+14155550101', body: 'x'.repeat(1601) }) } catch (e) { threw = (e as Error).message }
  t('body.tooLongRefusedLocally', /1600/.test(threw))
  t('e164.shared', toE164('0044 20 7946 0958'))

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const rl = await sendMessage(send, { ...base, to: '+14155550102', body: 'hi' })
  t('rateLimited.handedToCaller', { kind: rl.error?.kind, code: rl.error?.code, retryAfterMs: rl.error?.retryAfterMs, attempts: (await seen()).requests.length })
  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await sendMessage(send, { ...base, to: '+14155550103', body: 'hi' })
  t('lostResponse.notReplayed', { kind: lost.error?.kind, retryable: lost.error?.retryable, attempts: (await seen()).requests.length })

  // The negative control: a JSON target is refused by the sink naming the content-type.
  const bare = createConduit({ credentials: createStaticResolver({ TWILIO_CREDENTIAL: `${sink.accountSid}:${sink.authToken}` }) })
  const { encoding: _e, ...jsonTarget } = twilioTarget({ address: sink.url })
  await bare.register(jsonTarget)
  const wrong = await sendMessage(bindSend(bare), { ...base, to: '+14155550104', body: 'hi' })
  t('withoutFormEncoding.isRefused', { kind: wrong.error?.kind, code: wrong.error?.code })
  await bare.destroy()

  // Inbound STOP, delivered twice.
  await ctl.reset(); await ctl.arm({ deliverTwice: true })
  await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ url: `${publicUrl}/inbound`, from: '+14155550100', to: '+15550001111', body: 'STOP' }) })
  await settle()
  const ev = (await seen()).events.filter(e => e.type === 'inbound')
  t('inbound.stopDeliveredTwiceProcessedOnce', { deliveries: ev.length, answered: ev.map(e => e.status), processed: inbox.filter(e => e.type === 'inbound').length, keyword: inbox.find(e => e.type === 'inbound')?.keyword })

  // The verifier: the public URL is the whole trick. Behind a proxy the
  // request's own URL is a different string and every event fails.
  const params = { MessageSid: 'SMx', From: '+1', To: '+2', Body: 'Hello' }
  const body = new URLSearchParams(params).toString()
  const { createHmac } = await import('node:crypto')
  const sig = createHmac('sha1', sink.authToken).update('https://shop.example/webhooks/twilio/inbound' + 'Body' + 'Hello' + 'From' + '+1' + 'MessageSid' + 'SMx' + 'To' + '+2').digest('base64')
  t('verify.publicUrlNotInternal', {
    public:   verifyTwilioSignature({ url: 'https://shop.example/webhooks/twilio/inbound', rawBody: body, header: sig, authToken: sink.authToken }).ok,
    internal: verifyTwilioSignature({ url: 'http://10.0.0.5:8080/webhooks/twilio/inbound', rawBody: body, header: sig, authToken: sink.authToken }).ok,
    swapped:  verifyTwilioSignature({ url: 'https://shop.example/webhooks/twilio/inbound', rawBody: body.replace('Hello', 'Bye'), header: sig, authToken: sink.authToken }).ok,
    wrongToken: verifyTwilioSignature({ url: 'https://shop.example/webhooks/twilio/inbound', rawBody: body, header: sig, authToken: 'other' }).ok,
  })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'send.basicOverForm':                 { ok: true, status: 'queued', auth: true, form: true, laterStatus: 'delivered' },
  'get.resolvesLater':                  { status: 'delivered' },
  'optedOut.isDomainAnswer':            { kind: 'opted_out', code: 21610, retryable: false },
  'invalidDestination.isDomainAnswer':  { kind: 'invalid_destination', code: 21211 },
  'tenDlc.isUnregistered':              { kind: 'unregistered', code: 30034 },
  'body.tooLongRefusedLocally':         true,
  'e164.shared':                        '+442079460958',
  'rateLimited.handedToCaller':         { kind: 'rate_limited', code: 20429, retryAfterMs: 1000, attempts: 1 },
  'lostResponse.notReplayed':           { kind: 'timeout', retryable: false, attempts: 1 },
  'withoutFormEncoding.isRefused':      { kind: 'refused', code: 20001 },
  'inbound.stopDeliveredTwiceProcessedOnce': { deliveries: 2, answered: [200, 200], processed: 1, keyword: 'STOP' },
  'verify.publicUrlNotInternal':        { public: true, internal: false, swapped: false, wrongToken: false },
}))
