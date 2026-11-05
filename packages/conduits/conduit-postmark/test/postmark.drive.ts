// test/postmark.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: an INBOUND message arrives parsed and is
// authenticated by the credential the app put in the URL, which is all
// Postmark offers; a batch answers per message on a 200; `MessageID` is the
// id FJS-D684 wants; a 406 is a recipient already bounced, not a bad address.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '@frontierjs/conduit/testing'
import { startPostmarkSink } from '../sink.ts'
import { postmarkTarget, bindSend, sendEmail, sendBatch, createPostmarkMailer, toPostmarkPayload, verifyPostmarkWebhook, suppressionFor, postmarkMailDialect, type PostmarkInbound, type PostmarkBounce } from '../src/index.ts'

const { got, t } = results()
const CRED = 'hook-user:hook-pass-key'
const inbox: { subject: string; from: string }[] = []
const suppressed: { email: string; reason: string }[] = []
const seenIds: string[] = []
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const v = verifyPostmarkWebhook<PostmarkInbound | PostmarkBounce>({ rawBody: raw, authorization: req.headers.get('authorization'), credential: CRED, ip: '127.0.0.1', allowIps: ['127.0.0.1'] })
    if (!v.ok) return Response.json({ error: v.reason }, { status: 401 })
    const id = 'RecordType' in v.event ? `b-${v.event.ID}` : v.event.MessageID
    if (seenIds.includes(id)) return Response.json({ ok: true, duplicate: true })
    seenIds.push(id)
    if ('RecordType' in v.event) { const s = suppressionFor(v.event); if (s) suppressed.push({ email: s.email, reason: s.reason }) }
    else inbox.push({ subject: v.event.Subject, from: v.event.From })
    return Response.json({ ok: true })
  },
})
const hookUrl = `http://${encodeURIComponent('hook-user')}:${encodeURIComponent('hook-pass-key')}@127.0.0.1:${receiver.port}/webhooks/postmark`
const sink = startPostmarkSink({ hookUrl }), ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ POSTMARK_SERVER_TOKEN: sink.token, POSTMARK_INBOUND: CRED }), ...DRIVE_RESILIENCE })
await conduit.register(postmarkTarget({ address: sink.url }))
const send = bindSend(conduit)
const seen = () => ctl.seen() as unknown as Promise<{ requests: { headers: Record<string, string>; body: string }[]; sent: unknown[]; events: { type: string; status: number | null }[] }>
const settle = () => new Promise(r => setTimeout(r, 60))

try {
  const payload = toPostmarkPayload({ to: ['a@example.com', 'b@example.com'], subject: 'Hi', html: '<img src="cid:chart">', attachments: [{ filename: 'c.png', content: new Uint8Array([1, 2]), type: 'image/png', cid: 'chart' }], tags: { k: 'v', k2: 'v2' } }, { from: 'Shop <no-reply@example.com>', stream: 'outbound' })
  const one = await sendEmail(send, payload)
  const wire = (await seen()).requests[0]
  t('send.succeeds', { ok: !one.error, guid: /^[0-9a-f-]{36}$/.test(one.id ?? ''), tokenHeader: wire.headers['x-postmark-server-token'] === sink.token, noAuthorization: !('authorization' in wire.headers), toJoined: JSON.parse(wire.body).To, tag: JSON.parse(wire.body).Tag, cid: JSON.parse(wire.body).Attachments[0].ContentID })

  t('send.inactiveRecipientIsSuppressed', { kind: (await sendEmail(send, { ...payload, To: 'gone@inactive.example' })).error?.kind, code: (await sendEmail(send, { ...payload, To: 'gone@inactive.example' })).error?.code })
  t('send.badAddressIsRefused', { kind: (await sendEmail(send, { ...payload, To: 'not an address' })).error?.kind, code: (await sendEmail(send, { ...payload, To: 'not an address' })).error?.code })

  const batch = await sendBatch(send, [payload, { ...payload, To: 'gone@inactive.example' }, { ...payload, To: 'c@example.com' }])
  t('batch.answersPerMessage', { kinds: batch.results?.map(r => 'id' in r ? 'sent' : r.error.kind) })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await sendEmail(send, payload)
  const after = await seen()
  t('lostResponse.notReplayed', { kind: lost.error?.kind, retryable: lost.error?.retryable, emailsSent: after.sent.length, attempts: after.requests.length })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const rl = await sendEmail(send, payload)
  t('rateLimited.handedToCaller', { kind: rl.error?.kind, retryAfterMs: rl.error?.retryAfterMs })

  const mailer = createPostmarkMailer(send, { from: 'no-reply@example.com' })
  const r = await mailer.send({ to: 'd@example.com', subject: 's', text: 't' })
  let thrown: { kind?: string } = {}
  try { await mailer.send({ to: 'gone@inactive.example', subject: 's', text: 't' }) } catch (e) { thrown = e as typeof thrown }
  t('imail.sendsAndThrowsReadably', { sent: r.message, thrownKind: thrown.kind })

  // Inbound, delivered twice, processed once; authenticated by the URL credential.
  await ctl.reset(); await ctl.arm({ deliverTwice: true })
  await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: 'customer@example.org', to: 'support+abc@inbound.example.com', subject: 'Help', text: 'hi', hash: 'abc' }) })
  await settle()
  const ev = (await seen()).events.filter(e => e.type === 'Inbound')
  t('inbound.parsedDeliveredTwiceProcessedOnce', { deliveries: ev.length, answered: ev.map(e => e.status), inbox })

  await sendEmail(send, { ...payload, To: 'dead@bounce.example' })
  await settle()
  t('bounce.writesSuppression', { suppressed })

  const body = JSON.stringify({ MessageID: 'x', From: 'a', To: 'b', Subject: 's', Date: 'd' })
  const basic = (c: string) => `Basic ${Buffer.from(c).toString('base64')}`
  t('verify.urlCredential', {
    right: verifyPostmarkWebhook({ rawBody: body, authorization: basic(CRED), credential: CRED }).ok,
    wrong: verifyPostmarkWebhook({ rawBody: body, authorization: basic('hook-user:nope'), credential: CRED }).ok,
    none:  verifyPostmarkWebhook({ rawBody: body, authorization: null, credential: CRED }).ok,
    badIp: verifyPostmarkWebhook({ rawBody: body, authorization: basic(CRED), credential: CRED, ip: '203.0.113.9', allowIps: ['3.134.147.250'] }).ok,
  })

  // The dialect through conduit's own order (FJS-D899): a delivery applied once, its retry a duplicate,
  // the wrong URL credential one 401, a bounce at the same path ignored; the mail arrives as ReceivedMail.
  const landed: { recipient: string; from: string; messageId: string | null }[] = []
  conduit.receive({
    provider: 'postmark', path: '/mail/postmark', dialect: postmarkMailDialect, credential: 'POSTMARK_INBOUND',
    apply(ev) { landed.push({ recipient: ev.payload.recipient, from: ev.payload.from, messageId: ev.payload.headers['Message-ID'] ?? null }); return 'applied' },
  })
  const inbound = JSON.stringify({ MessageID: 'pm-1', From: 'ada@example.org', FromFull: { Email: 'ada@example.org', Name: 'Ada, Customer' }, To: 'Support <support+t0k3n@inbound.example.com>', OriginalRecipient: 'support+t0k3n@inbound.example.com', Subject: 'Re: Help', Date: 'd', TextBody: 'thanks', Headers: [{ Name: 'Message-ID', Value: '<m1@example.org>' }] })
  const delivery = (auth: string | null, raw = inbound) => ({ method: 'POST', path: '/mail/postmark', query: '', route: {}, headers: (auth ? { authorization: auth } : {}) as Record<string, string>, rawBody: raw, body: JSON.parse(raw) })
  const nowS = Math.floor(Date.now() / 1000)
  const first  = await conduit.accept('/mail/postmark', delivery(basic(CRED)), nowS)
  const again  = await conduit.accept('/mail/postmark', delivery(basic(CRED)), nowS)
  const wrong  = await conduit.accept('/mail/postmark', delivery(basic('hook-user:nope')), nowS)
  const bounce = await conduit.accept('/mail/postmark', delivery(basic(CRED), JSON.stringify({ RecordType: 'Bounce', ID: 1, MessageID: 'b1', Email: 'x@y.example', Inactive: true, Type: 'HardBounce', TypeCode: 1 })), nowS)
  t('dialect.conduitOrder', { first: first.result, again: again.result, wrong: wrong.status, bounce: bounce.result, landed })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'send.succeeds':                       { ok: true, guid: true, tokenHeader: true, noAuthorization: true, toJoined: 'a@example.com, b@example.com', tag: 'k:v', cid: 'cid:chart' },
  'send.inactiveRecipientIsSuppressed':  { kind: 'suppressed', code: 406 },
  'send.badAddressIsRefused':            { kind: 'refused', code: 300 },
  'batch.answersPerMessage':             { kinds: ['sent', 'suppressed', 'sent'] },
  'lostResponse.notReplayed':            { kind: 'timeout', retryable: false, emailsSent: 1, attempts: 1 },
  'rateLimited.handedToCaller':          { kind: 'rate_limited', retryAfterMs: 1000 },
  'imail.sendsAndThrowsReadably':        { sent: 'sent', thrownKind: 'suppressed' },
  'inbound.parsedDeliveredTwiceProcessedOnce': { deliveries: 2, answered: [200, 200], inbox: [{ subject: 'Help', from: 'customer@example.org' }] },
  'bounce.writesSuppression':            { suppressed: [{ email: 'dead@bounce.example', reason: 'bounce' }] },
  'verify.urlCredential':                { right: true, wrong: false, none: false, badIp: false },
  'dialect.conduitOrder':                { first: 'applied', again: 'duplicate', wrong: 401, bounce: 'ignored', landed: [{ recipient: 'support+t0k3n@inbound.example.com', from: '"Ada, Customer" <ada@example.org>', messageId: '<m1@example.org>' }] },
}))
