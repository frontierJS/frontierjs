// test/sendgrid.drive.ts — the connector against the sink. No fixture: a real
// send bills and lands in a real inbox. What is only provable here: the 202's
// answer is a header and the sandbox 200 has no id; a bad reply_to is refused
// before the send; an event batch verifies over the raw bytes under a moved
// clock, carries the row's own `messageId` back, and a repeated delivery is
// one set of events; the domain verbs return three unproxied CNAMEs and
// `validate` flips only once DNS has had time.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startSendgridSink } from '../sink.ts'
import { sendgridTarget, bindSend, sendEmail, toSendgridPayload, createSendgridMailer, verifySendgridSignature, authenticateDomain, validateDomain, listDomains, dnsRecordsOf } from '../src/index.ts'

const { got, t } = results()
const KEY = 'SG.dev'
const inbox: { event: string; messageId?: string }[] = []
const seenEvents = new Set<string>()
let publicKey = ''
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const v = verifySendgridSignature({ rawBody: raw, headers: { 'x-twilio-email-event-webhook-signature': req.headers.get('x-twilio-email-event-webhook-signature'), 'x-twilio-email-event-webhook-timestamp': req.headers.get('x-twilio-email-event-webhook-timestamp') }, publicKey, now: Math.floor(Date.now() / 1000) })
    if (!v.ok) return Response.json({ error: v.reason }, { status: 401 })
    for (const e of v.events) if (!seenEvents.has(e.sg_event_id)) { seenEvents.add(e.sg_event_id); inbox.push({ event: e.event, messageId: e.messageId }) }
    return Response.json({ ok: true })
  },
})
const sink = await startSendgridSink({ key: KEY, hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/sendgrid`, dnsAfter: 2 })
publicKey = sink.publicKey
const ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ SENDGRID_API_KEY: KEY }), ...DRIVE_RESILIENCE })
await conduit.register(sendgridTarget({ address: sink.url }))
const send = bindSend(conduit)
const from = { from: 'Kobami <hello@kobami.test>' }
const seen = () => ctl.seen() as unknown as Promise<{ requests: { status: number }[]; events: { type: string; status: number | null }[] }>
const settle = () => new Promise(r => setTimeout(r, 80))

try {
  const payload = toSendgridPayload({ to: 'a@b.test', subject: 'hi', text: 'hello' }, from, { messageId: 'row-17' })
  t('payload.carriesRowIdAndParsedFrom', { customArgs: payload.custom_args, from: payload.from, kinds: payload.content.map(c => c.type) })

  let threw = ''
  try { toSendgridPayload({ to: 'a@b.test', subject: 'hi', text: 'x', replyTo: 'no address' }, from) } catch (e) { threw = (e as Error).message }
  t('replyTo.withoutAddressRefusedLocally', { refused: /reply_to/.test(threw), attempts: (await seen()).requests.length })

  const sent = await sendEmail(send, payload)
  await settle()
  t('send.idIsTheHeader', { ok: !sent.error, id: sent.id?.startsWith('msg-'), events: inbox.map(e => e.event), rowFound: inbox.every(e => e.messageId === 'row-17') })

  const sandbox = await sendEmail(send, toSendgridPayload({ to: 'a@b.test', subject: 'hi', text: 'x' }, from, { sandbox: true }))
  const badSandbox = await sendEmail(send, { ...toSendgridPayload({ to: 'a@b.test', subject: 'hi', text: 'x' }, from, { sandbox: true }), from: { email: 'nobody' } })
  t('sandbox.noIdAndStillRefusesBadSender', { ok: !sandbox.error, id: sandbox.id, badKind: badSandbox.error?.kind, badField: badSandbox.error?.field })

  const unverified = await sendEmail(send, toSendgridPayload({ to: 'a@b.test', subject: 'hi', text: 'x' }, { from: 'x@unverified.test' }))
  t('unverifiedSender.isForbiddenNotAuth', { kind: unverified.error?.kind, retryable: unverified.error?.retryable })

  inbox.length = 0
  await ctl.reset(); await ctl.arm({ deliverTwice: true })
  await sendEmail(send, toSendgridPayload({ to: 'c@b.test', subject: 'hi', text: 'x' }, from, { messageId: 'row-18' }))
  await settle()
  t('events.deliveredTwiceProcessedOnce', { deliveries: (await seen()).events.length, answered: (await seen()).events.map(e => e.status), processed: inbox.length })

  const mailer = createSendgridMailer(send, { from: 'hello@kobami.test' })
  let mailerErr: Record<string, unknown> | null = null
  try { await mailer.send({ to: 'a@b.test', subject: 'hi', text: 'x', from: 'x@unverified.test' }) } catch (e) { mailerErr = { kind: (e as { kind: string }).kind, message: (e as Error).message } }
  const ok = await mailer.send({ to: 'a@b.test', subject: 'hi', text: 'x' })
  t('mailer.throwsWithFailureFields', { thrown: mailerErr?.kind, said: /Sender Identity/.test(String(mailerErr?.message)), sent: ok.message })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const limited = await sendEmail(send, payload)
  t('rateLimited.handedToCaller', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await sendEmail(send, payload)
  t('lostResponse.notReplayed', { kind: lost.error?.kind, retryable: lost.error?.retryable, attempts: (await seen()).requests.length })

  const created = await authenticateDomain(send, { domain: 'client.test' })
  const records = created.domain ? dnsRecordsOf(created.domain) : []
  t('domain.threeUnproxiedCnames', { count: records.length, types: [...new Set(records.map(r => r.type))], proxied: [...new Set(records.map(r => r.proxied))], hosts: records.map(r => r.name) })
  const first = await validateDomain(send, created.domain!.id)
  const second = await validateDomain(send, created.domain!.id)
  t('domain.validFlipsAfterDnsHasTime', { first: first.domain?.valid, second: second.domain?.valid })
  const dupe = await authenticateDomain(send, { domain: 'client.test' })
  const listed = await listDomains(send)
  t('domain.duplicateRefusedAndListResolves', { kind: dupe.error?.kind, field: dupe.error?.field, found: listed.domains?.some(d => d.domain === 'client.test') })
  const notDomain = await authenticateDomain(send, { domain: 'not a domain' })
  t('domain.refusedLocally', { kind: notDomain.error?.kind })

  const body = JSON.stringify([{ event: 'delivered', email: 'a@b.test', timestamp: 1, sg_event_id: 'e1' }])
  const now = 1_700_000_000
  const { createSign, generateKeyPairSync } = await import('node:crypto')
  const sign = (ts: number) => {
    // The drive signs with its own key for the forged case; the sink's private key never leaves it.
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const s = createSign('sha256'); s.update(String(ts) + body)
    return { sig: s.sign({ key: kp.privateKey, dsaEncoding: 'der' }).toString('base64'), pub: kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  }
  const own = sign(now)
  const objectBody = JSON.stringify({ event: 'delivered' })
  const objSigner = createSign('sha256'); objSigner.update(String(now) + objectBody)
  const objKp = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const notArray = verifySendgridSignature({ rawBody: objectBody, headers: { 'x-twilio-email-event-webhook-signature': objSigner.sign({ key: objKp.privateKey, dsaEncoding: 'der' }).toString('base64'), 'x-twilio-email-event-webhook-timestamp': String(now) }, publicKey: objKp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), now })
  const v = (ts: number, sig: string, pub = own.pub) => verifySendgridSignature({ rawBody: body, headers: { 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': String(ts) }, publicKey: pub, now }).ok
  t('verify.ownKeyFreshAndMovedClock', { fresh: v(now, own.sig), past: v(now - 400, sign(now - 400).sig), wrongKey: v(now, own.sig, sink.publicKey), notArray: notArray.ok ? 'ok' : notArray.reason, tamperedBody: verifySendgridSignature({ rawBody: body + ' ', headers: { 'x-twilio-email-event-webhook-signature': own.sig, 'x-twilio-email-event-webhook-timestamp': String(now) }, publicKey: own.pub, now }).ok })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'payload.carriesRowIdAndParsedFrom':      { customArgs: { messageId: 'row-17' }, from: { email: 'hello@kobami.test', name: 'Kobami' }, kinds: ['text/plain'] },
  'replyTo.withoutAddressRefusedLocally':   { refused: true, attempts: 0 },
  'send.idIsTheHeader':                     { ok: true, id: true, events: ['processed', 'delivered'], rowFound: true },
  'sandbox.noIdAndStillRefusesBadSender':   { ok: true, id: '', badKind: 'refused', badField: 'from.email' },
  'unverifiedSender.isForbiddenNotAuth':    { kind: 'forbidden', retryable: false },
  'events.deliveredTwiceProcessedOnce':     { deliveries: 2, answered: [200, 200], processed: 2 },
  'mailer.throwsWithFailureFields':         { thrown: 'forbidden', said: true, sent: 'sent' },
  'rateLimited.handedToCaller':             { kind: 'rate_limited', retryable: true, retryAfterMs: 1000, attempts: 1 },
  'lostResponse.notReplayed':               { kind: 'timeout', retryable: false, attempts: 1 },
  'domain.threeUnproxiedCnames':            { count: 3, types: ['CNAME'], proxied: [false], hosts: ['mail.client.test', 's1._domainkey.client.test', 's2._domainkey.client.test'] },
  'domain.validFlipsAfterDnsHasTime':       { first: false, second: true },
  'domain.duplicateRefusedAndListResolves': { kind: 'refused', field: 'domain', found: true },
  'domain.refusedLocally':                  { kind: 'refused' },
  'verify.ownKeyFreshAndMovedClock':        { fresh: true, past: false, wrongKey: false, notArray: 'body is not an array of events', tamperedBody: false },
}))
