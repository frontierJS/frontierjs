// test/mailgun.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: an INBOUND message arrives as raw MIME and is
// parsed here — encoded words, quoted-printable, an inline part with a cid —
// the signature covers `timestamp + token` and nothing else, so a replayed
// token is refused and a retry re-signed with a new token is a duplicate by
// Message-ID; a mail with no Message-ID dedupes on its bytes, per recipient.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { createHmac, randomBytes } from 'node:crypto'
import { results, report, control, DRIVE_RESILIENCE } from '@frontierjs/conduit/testing'
import { startMailgunSink } from '../sink.ts'
import { mailgunTarget, bindSend, sendEmail, events, createMailgunMailer, toMailgunForm, verifyMailgunSignature, mailgunMailDialect, fromMime } from '../src/index.ts'

const { got, t } = results()
const DOMAIN = 'shop.example'
const inbox: unknown[] = []
const seenKeys: string[] = []
const spent = new Set<string>()
const nowS = () => Math.floor(Date.now() / 1000)

// The app's receiver, by hand: verify, dedupe on recipient + Message-ID, parse the bytes.
let signingKey = ''
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const f = Object.fromEntries([...(await req.formData())].map(([k, v]) => [k, String(v)]))
    const v = verifyMailgunSignature({ fields: f, key: signingKey, now: nowS(), seenNonce: tok => spent.has(tok) ? true : (spent.add(tok), false) })
    if (!v.ok) return Response.json({ error: v.reason }, { status: 401 })
    const mail = await fromMime(f['body-mime'], { recipient: f.recipient, sender: f.sender })
    if (!mail) return Response.json({ ok: true, ignored: true })
    const key = `${f.recipient} ${mail.headers['Message-ID']}`
    if (seenKeys.includes(key)) return Response.json({ ok: true, duplicate: true })
    seenKeys.push(key)
    inbox.push({ subject: mail.subject, from: mail.from, text: (mail.text ?? '').trim(), inReplyTo: mail.headers['In-Reply-To'] ?? null,
      attachments: mail.attachments?.map(a => ({ filename: a.filename, type: a.type, bytes: (a.content as Uint8Array).length, cid: a.cid ?? null })) })
    return Response.json({ ok: true })
  },
})
const sink = startMailgunSink({ hookUrl: `http://127.0.0.1:${receiver.port}/mail/mailgun/mime` }), ctl = control(sink.url)
signingKey = sink.signingKey
const conduit = createConduit({ credentials: createStaticResolver({ MAILGUN_API_KEY: `api:${sink.key}`, MAILGUN_SIGNING_KEY: sink.signingKey }), ...DRIVE_RESILIENCE })
await conduit.register(mailgunTarget({ address: sink.url }))
const send = bindSend(conduit)
const seen = () => ctl.seen() as unknown as Promise<{ requests: { headers: Record<string, string>; body: string }[]; sent: unknown[]; events: { type: string; status: number | null }[] }>
const settle = () => new Promise(r => setTimeout(r, 60))
const signed = (fields: Record<string, string>, o: { key?: string; timestamp?: number; token?: string } = {}) => {
  const timestamp = String(o.timestamp ?? nowS()), token = o.token ?? randomBytes(25).toString('hex')
  return { ...fields, timestamp, token, signature: createHmac('sha256', o.key ?? sink.signingKey).update(timestamp + token).digest('hex') }
}

try {
  const form = toMailgunForm({ to: ['a@example.com', 'b@example.com'], subject: 'Hi', text: 'hello', replyTo: 'support+t0k3n@shop.example', headers: { 'X-Order': '42' }, tags: { kind: 'receipt', order: '42' } }, { from: 'Shop <no-reply@shop.example>' })
  const one = await sendEmail(send, DOMAIN, form)
  const wire = (await seen()).requests[0], p = new URLSearchParams(wire.body)
  t('send.succeeds', { ok: !one.error, idShape: /^<[^@]+@shop\.example>$/.test(one.id ?? ''), basic: wire.headers.authorization === `Basic ${Buffer.from(`api:${sink.key}`).toString('base64')}`,
    contentType: wire.headers['content-type'], to: p.get('to'), replyTo: p.get('h:Reply-To'), header: p.get('h:X-Order'), tag: p.get('o:tag'), variables: [p.get('v:kind'), p.get('v:order')] })

  t('send.badAddressIsRefused', { kind: (await sendEmail(send, DOMAIN, { ...form, to: 'not an address' })).error?.kind, message: (await sendEmail(send, DOMAIN, { ...form, to: 'not an address' })).error?.message })
  t('send.unknownDomainIsGone', { kind: (await sendEmail(send, 'nobody.example', form)).error?.kind })
  let local = ''
  try { toMailgunForm({ to: 'a@example.com', subject: 's', text: 't', attachments: [{ filename: 'f', content: 'AQ==' }] }, { from: 'x@shop.example' }) } catch (e) { local = (e as Error).message }
  t('send.attachmentRefusedBeforeSend', { refused: /not sent/.test(local), attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await sendEmail(send, DOMAIN, { ...form, 'v:order': '77' })
  const after = await seen()
  t('lostResponse.notReplayed', { kind: lost.error?.kind, retryable: lost.error?.retryable, emailsSent: after.sent.length, attempts: after.requests.length })
  const resolved = await events(send, DOMAIN, { event: 'accepted', order: '77' })
  t('lostResponse.resolvedByEvents', { landed: resolved.items?.length, variable: resolved.items?.[0]?.['user-variables']?.order })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const rl = await sendEmail(send, DOMAIN, form)
  t('rateLimited.handedToCaller', { kind: rl.error?.kind, retryAfterMs: rl.error?.retryAfterMs })

  const mailer = createMailgunMailer(send, DOMAIN, { from: 'no-reply@shop.example' })
  const r = await mailer.send({ to: 'd@example.com', subject: 's', text: 't' })
  let thrown: { kind?: string } = {}
  try { await mailer.send({ to: 'not an address', subject: 's', text: 't' }) } catch (e) { thrown = e as typeof thrown }
  t('imail.sendsAndThrowsReadably', { sent: r.message, thrownKind: thrown.kind })

  // Inbound: raw MIME, delivered twice (re-signed), processed once; the hard parts of the bytes decoded.
  await ctl.reset(); await ctl.arm({ deliverTwice: true })
  await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({
    from: 'zoe@example.org', fromName: 'Zoë, Customer', to: 'support+t0k3n@inbound.shop.example', subject: 'Ré: Help — ünïcode', text: 'Merci — ça marche ✓\nligne deux',
    messageId: '<m1@example.org>', inReplyTo: '<sent-1@shop.example>',
    attachments: [{ name: 'résumé.pdf', type: 'application/pdf', base64: 'AQID' }, { name: 'logo.png', type: 'image/png', base64: 'AQI=', cid: 'logo' }],
  }) })
  await settle()
  const ev = (await seen()).events
  t('inbound.rawMimeDeliveredTwiceProcessedOnce', { deliveries: ev.length, answered: ev.map(e => e.status), inbox })

  const base = { recipient: 'x@inbound.shop.example', sender: 'a@example.org', 'body-mime': 'From: a@example.org\r\nSubject: s\r\n\r\nhi' }
  const nonces = new Set<string>()
  const seenNonce = (tok: string) => nonces.has(tok) ? true : (nonces.add(tok), false)
  const replayed = signed(base)
  t('verify.signature', {
    right:    verifyMailgunSignature({ fields: signed(base), key: sink.signingKey, now: nowS() }).ok,
    wrongKey: verifyMailgunSignature({ fields: signed(base, { key: 'key-somebody-else' }), key: sink.signingKey, now: nowS() }).ok,
    stale:    verifyMailgunSignature({ fields: signed(base, { timestamp: nowS() - 301 }), key: sink.signingKey, now: nowS() }).ok,
    unsigned: verifyMailgunSignature({ fields: {}, key: sink.signingKey, now: nowS() }).ok,
    once:     verifyMailgunSignature({ fields: replayed, key: sink.signingKey, now: nowS(), seenNonce }).ok,
    replayed: verifyMailgunSignature({ fields: replayed, key: sink.signingKey, now: nowS(), seenNonce }).ok,
  })

  // The dialect through conduit's own order (FJS-D899): applied once, the re-signed retry a duplicate, a wrong key one 401,
  // a signed form that carries no mail ignored, and the mail arrives as ReceivedMail.
  const landed: unknown[] = []
  conduit.receive({
    provider: 'mailgun', path: '/mail/mailgun/mime', dialect: mailgunMailDialect, credential: 'MAILGUN_SIGNING_KEY',
    apply(ev) { landed.push({ id: ev.id, recipient: ev.payload.recipient, from: ev.payload.from, to: ev.payload.to, inReplyTo: ev.payload.headers['In-Reply-To'] ?? null, text: ev.payload.text?.trim() }); return 'applied' },
  })
  const delivery = (fields: Record<string, string>) => ({ method: 'POST', path: '/mail/mailgun/mime', query: '', route: {}, headers: {}, rawBody: '', body: fields })
  const mime = ['From: Ada <ada@example.org>', 'To: Support <support+t0k3n@inbound.shop.example>', 'Subject: Re: Help', 'Message-Id: <m2@example.org>', 'In-Reply-To: <sent-2@shop.example>', '', 'thanks'].join('\r\n')
  const fields = { recipient: 'support+t0k3n@inbound.shop.example', sender: 'ada@example.org', 'body-mime': mime }
  const first  = await conduit.accept('/mail/mailgun/mime', delivery(signed(fields)), nowS())
  const again  = await conduit.accept('/mail/mailgun/mime', delivery(signed(fields)), nowS())
  const wrong  = await conduit.accept('/mail/mailgun/mime', delivery(signed(fields, { key: 'key-somebody-else' })), nowS())
  const noMail = await conduit.accept('/mail/mailgun/mime', delivery(signed({ recipient: fields.recipient, sender: fields.sender })), nowS())
  t('dialect.conduitOrder', { first: first.result, again: again.result, wrong: wrong.status, noMail: noMail.result, landed: [...landed] })

  // No Message-ID: the bytes are the key, and a second recipient of the same bytes is its own delivery.
  const bare = { recipient: 'one@inbound.shop.example', sender: 'bob@example.org', 'body-mime': 'From: bob@example.org\r\nSubject: no id\r\n\r\nhi' }
  const b1 = await conduit.accept('/mail/mailgun/mime', delivery(signed(bare)), nowS())
  const b2 = await conduit.accept('/mail/mailgun/mime', delivery(signed(bare)), nowS())
  const b3 = await conduit.accept('/mail/mailgun/mime', delivery(signed({ ...bare, recipient: 'two@inbound.shop.example' })), nowS())
  t('dialect.noMessageIdKeysOnBytes', { first: b1.result, again: b2.result, otherRecipient: b3.result, idShape: /^sha256:[0-9a-f]{64}$/.test((landed.at(-1) as { id: string }).id) })

  const envelope = { recipient: 'x@inbound.shop.example' }
  const headerless = await fromMime('Subject: no from\r\n\r\nbody', { ...envelope, sender: 'bounce@example.org' })
  t('mime.whatIsNotAMail', {
    empty:          await fromMime('', envelope),
    noRecipient:    await fromMime('From: a@b.example\r\n\r\nx', { recipient: '' }),
    noSenderAtAll:  await fromMime('Subject: s\r\n\r\nx', envelope),
    envelopeSender: headerless?.from,
    toFallsBack:    headerless?.to,
  })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'send.succeeds':                       { ok: true, idShape: true, basic: true, contentType: 'application/x-www-form-urlencoded', to: 'a@example.com, b@example.com', replyTo: 'support+t0k3n@shop.example', header: '42', tag: 'kind:receipt', variables: ['receipt', '42'] },
  'send.badAddressIsRefused':            { kind: 'refused', message: "'to' parameter is not a valid address. please check documentation" },
  'send.unknownDomainIsGone':            { kind: 'gone' },
  'send.attachmentRefusedBeforeSend':    { refused: true, attempts: 4 },
  'lostResponse.notReplayed':            { kind: 'timeout', retryable: false, emailsSent: 1, attempts: 1 },
  'lostResponse.resolvedByEvents':       { landed: 1, variable: '77' },
  'rateLimited.handedToCaller':          { kind: 'rate_limited', retryAfterMs: 1000 },
  'imail.sendsAndThrowsReadably':        { sent: 'sent', thrownKind: 'refused' },
  'inbound.rawMimeDeliveredTwiceProcessedOnce': { deliveries: 2, answered: [200, 200], inbox: [{ subject: 'Ré: Help — ünïcode', from: '"Zoë, Customer" <zoe@example.org>', text: 'Merci — ça marche ✓\nligne deux', inReplyTo: '<sent-1@shop.example>',
    attachments: [{ filename: 'résumé.pdf', type: 'application/pdf', bytes: 3, cid: null }, { filename: 'logo.png', type: 'image/png', bytes: 2, cid: 'logo' }] }] },
  'verify.signature':                    { right: true, wrongKey: false, stale: false, unsigned: false, once: true, replayed: false },
  'dialect.conduitOrder':                { first: 'applied', again: 'duplicate', wrong: 401, noMail: 'ignored', landed: [{ id: '<m2@example.org>', recipient: 'support+t0k3n@inbound.shop.example', from: 'Ada <ada@example.org>', to: ['Support <support+t0k3n@inbound.shop.example>'], inReplyTo: '<sent-2@shop.example>', text: 'thanks' }] },
  'dialect.noMessageIdKeysOnBytes':      { first: 'applied', again: 'duplicate', otherRecipient: 'applied', idShape: true },
  'mime.whatIsNotAMail':                 { empty: null, noRecipient: null, noSenderAtAll: null, envelopeSender: 'bounce@example.org', toFallsBack: 'x@inbound.shop.example' },
}))
