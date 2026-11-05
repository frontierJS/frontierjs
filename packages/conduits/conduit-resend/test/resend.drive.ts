// test/resend.drive.ts — the connector through a real conduit against the sink.
//
// What only this drive asks: that a LOST RESPONSE on a send is not replayed —
// a retry is a second email — and comes back indeterminate; that a bounce
// arriving signed under a rotating secret still writes a suppression; and that
// the `IMail` adapter throws what a job can read `retryable` off.

import { createHmac } from 'node:crypto'
import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startResendSink } from '../sink.ts'
import { resendTarget, bindSend, sendEmail, sendBatch, createResendMailer, toResendPayload, verifyResendSignature, suppressionFor } from '../src/index.ts'

const { got, t } = results()
const KEY = 're_dev'

const suppressed: { email: string; reason: string }[] = []
const seenIds: string[] = []
let sinkSecret = ''
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const v = verifyResendSignature({ rawBody: raw, headers: { 'svix-id': req.headers.get('svix-id'), 'svix-timestamp': req.headers.get('svix-timestamp'), 'svix-signature': req.headers.get('svix-signature') }, secret: sinkSecret, now: Math.floor(Date.now() / 1000) })
    if (!v.ok) return Response.json({ error: v.reason }, { status: 401 })
    const svixId = req.headers.get('svix-id')!
    if (!seenIds.includes(svixId)) { seenIds.push(svixId); const s = suppressionFor(v.event); if (s) suppressed.push({ email: s.email, reason: s.reason }) }
    return Response.json({ received: true })
  },
})
const sink = startResendSink({ key: KEY, hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/resend` })
sinkSecret = sink.secret
const ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ RESEND_API_KEY: KEY }), ...DRIVE_RESILIENCE })
await conduit.register(resendTarget({ address: sink.url }))
const send = bindSend(conduit)
const seen = () => ctl.seen() as unknown as Promise<{ requests: { headers: Record<string, string>; body: string }[]; sent: { id: string; to: string[]; attachments: { content_id?: string }[] }[]; events: { type: string; status: number | null }[] }>

try {
  const payload = toResendPayload({ to: 'a@example.com', subject: 'Hi', html: '<img src="cid:chart">', attachments: [{ filename: 'c.png', content: new Uint8Array([1, 2, 3]), type: 'image/png', cid: 'chart' }], tags: { k: 'v' } }, { from: 'Shop <no-reply@example.com>' })
  const one = await sendEmail(send, payload)
  const s1 = await seen()
  t('send.succeeds', { ok: !one.error, id: one.id, jsonOnWire: s1.requests[0].headers['content-type'], contentId: s1.sent[0].attachments[0]?.content_id, tags: JSON.parse(s1.requests[0].body).tags })

  let threw = ''
  try { toResendPayload({ to: 'a@example.com\r\nBcc: x@evil', subject: 'x', text: 'y' }, { from: 'f@e.com' }) } catch (e) { threw = (e as Error).message }
  t('crlf.refusedBeforeSending', /line break/.test(threw))

  const bad = await sendEmail(send, { ...payload, to: [] })
  t('validation.isRefused', { kind: bad.error?.kind, name: bad.error?.name, retryable: bad.error?.retryable })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  // Unkeyed POST: conduit will not replay it, 429 or not — the caller gets the
  // wait and decides. Stripe's intent is `replayable`; a mail send is not.
  const limited = await sendEmail(send, payload)
  t('rateLimited.handedToCaller', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, attempts: (await seen()).requests.length })

  await ctl.arm({ quota: true })
  const quota = await sendEmail(send, payload)
  t('dailyQuota.isNotRetryable', { kind: quota.error?.kind, retryable: quota.error?.retryable })

  // A lost response: the sink SENT the mail and never answered. Unkeyed,
  // unreplayable — conduit must not try again, and the caller sees indeterminate.
  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await sendEmail(send, payload)
  const after = await seen()
  t('lostResponse.notReplayed', { kind: lost.error?.kind, retryable: lost.error?.retryable, emailsSent: after.sent.length, attempts: after.requests.length })

  await ctl.arm({ failNext: true })
  const flaky = await sendEmail(send, payload)
  t('serverError.notReplayedEither', { kind: flaky.error?.kind, retryable: flaky.error?.retryable })

  // The IMail adapter: a throw a job can read.
  const mailer = createResendMailer(send, { from: 'no-reply@example.com' })
  const r = await mailer.send({ to: 'b@example.com', subject: 's', text: 't' })
  await ctl.arm({ quota: true })
  let thrown: { kind?: string; retryable?: boolean } = {}
  try { await mailer.send({ to: 'b@example.com', subject: 's', text: 't' }) } catch (e) { thrown = e as typeof thrown }
  t('imail.sendsAndThrowsReadably', { sent: r.message, thrownKind: thrown.kind, retryable: thrown.retryable })

  const batch = await sendBatch(send, [payload, { ...payload, to: ['c@example.com'] }])
  t('batch.answersEveryId', { count: batch.ids?.length })

  // Inbound: a bounce under a rotated secret, delivered twice, suppressed once.
  await ctl.reset(); await ctl.arm({ rotatedSecret: true, deliverTwice: true })
  await sendEmail(send, { ...payload, to: ['gone@bounce.example'] })
  const ev = (await seen()).events.filter(e => e.type === 'email.bounced')
  t('bounce.rotatedSecretDeliveredTwiceSuppressedOnce', { deliveries: ev.length, answered: ev.map(e => e.status), suppressed })

  // The verifier with the clock moved.
  const body = JSON.stringify({ type: 'email.delivered', created_at: 'x', data: { email_id: 'e', to: ['a'], from: 'f', subject: 's' } })
  const now = 1_700_000_000
  const sig = (ts: number, secret = sink.secret) => `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`m.${ts}.${body}`).digest('base64')}`
  const v = (ts: number, s?: string) => verifyResendSignature({ rawBody: body, headers: { 'svix-id': 'm', 'svix-timestamp': String(ts), 'svix-signature': s ?? sig(ts) }, secret: sink.secret, now: now }).ok
  t('verify.movedClock', { fresh: v(now), past: v(now - 400), future: v(now + 400) })
  t('verify.forged', v(now, sig(now, `whsec_${Buffer.from('nope').toString('base64')}`)))
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'send.succeeds':                { ok: true, id: 'email-0001', jsonOnWire: 'application/json', contentId: 'chart', tags: [{ name: 'k', value: 'v' }] },
  'crlf.refusedBeforeSending':    true,
  'validation.isRefused':         { kind: 'refused', name: 'validation_error', retryable: false },
  'rateLimited.handedToCaller':   { kind: 'rate_limited', retryable: true, retryAfterMs: 1000, attempts: 1 },
  'dailyQuota.isNotRetryable':    { kind: 'quota', retryable: false },
  'lostResponse.notReplayed':     { kind: 'timeout', retryable: false, emailsSent: 1, attempts: 1 },
  'serverError.notReplayedEither': { kind: 'server_error', retryable: false },
  'imail.sendsAndThrowsReadably': { sent: 'sent', thrownKind: 'quota', retryable: false },
  'batch.answersEveryId':         { count: 2 },
  'bounce.rotatedSecretDeliveredTwiceSuppressedOnce': { deliveries: 2, answered: [200, 200], suppressed: [{ email: 'gone@bounce.example', reason: 'bounce' }] },
  'verify.movedClock':            { fresh: true, past: false, future: false },
  'verify.forged':                false,
}))
