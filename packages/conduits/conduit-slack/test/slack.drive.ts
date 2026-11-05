// test/slack.drive.ts — both targets through a real conduit against the sink.
//
// Run: `bun run drive`. Starts and stops its own sink and its own event
// receiver on ephemeral ports. No fixture: no conforming Slack exists to run.
//
// Two negative controls. `withoutValidate.isPlausibleWrongAnswer` sends the
// same `ok: false` with no validator and shows conduit hand it back as
// success, which is what C4 is for. `webhook.loopbackRefusedWithoutDestinations`
// registers the webhook target the way production does and shows conduit
// refuse the sink's own URL before anything leaves — the row after it passes
// `destinations` and lands.

import { createHmac } from 'node:crypto'
import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startSlackSink } from '../sink.ts'
import {
  slackTargets, bindSlack, postMessage, postWebhook, okEnvelope,
  section, header, divider, context, verifySlackSignature, retryOf,
} from '../src/index.ts'

const { got, t } = results()
const TOKEN = 'xoxb-dev', SIGNING = 'signing_dev'

// ── the receiving end: a raw route running the pure verifier ─────────────
const processed: string[] = []
const retriesSeen: number[] = []
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const v = verifySlackSignature({ rawBody: raw, headers: req.headers, secret: SIGNING, now: Math.floor(Date.now() / 1000) })
    if (!v.ok) return Response.json({ error: 'invalid signature' }, { status: 401 })
    if (v.challenge !== undefined) return new Response(v.challenge, { headers: { 'content-type': 'text/plain' } })
    const retry = retryOf(req.headers)
    if (retry) retriesSeen.push(retry.num)
    // A redelivery is answered 200 without a second processing; the id is the dedupe.
    if (!processed.includes(v.event.event_id)) processed.push(v.event.event_id)
    return new Response('', { status: 200 })
  },
})

const sink = startSlackSink({ token: TOKEN, signingSecret: SIGNING, hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/slack` })
const ctl  = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ SLACK_BOT_TOKEN: TOKEN }), ...DRIVE_RESILIENCE })
const targets = slackTargets({ address: sink.url, webhookDestinations: { allowHttp: true, allowPrivate: true } })
await conduit.register(targets.api)
await conduit.register(targets.webhook)
const slack = bindSlack(conduit, targets)

type Seen = { requests: { path: string; headers: Record<string, string>; body: string }[]; messages: { channel: string; via: string }[]; events: { id: string; type: string; retry: number | null; status: number | null; echoed?: string }[] }
const seen = () => ctl.seen<never>() as unknown as Promise<Seen>

try {
  // ── bot token: the shape on the wire ───────────────────────────────────
  const posted = await postMessage(slack, { channel: '#ops', text: 'deploy done', thread_ts: '1700000000.000100' })
  const first = (await seen()).requests[0]
  t('postMessage.succeeds', { ok: !posted.error, channel: posted.posted?.channel, hasTs: typeof posted.posted?.ts === 'string', threaded: posted.posted?.message?.thread_ts,
    bearerOnWire: first.headers.authorization === `Bearer ${TOKEN}`, contentType: first.headers['content-type'].split(';')[0], path: first.path })

  const blocks = [header('Release 1.2'), section('*42* services, *0* failed'), divider(), context('by fli', 'main')]
  const rich = await postMessage(slack, { channel: '#ops', text: 'Release 1.2', blocks })
  t('postMessage.blocksOnWire', { ok: !rich.error, types: (JSON.parse((await seen()).requests[1].body).blocks as { type: string }[]).map(b => b.type) })

  // ── a 200 that is a failure ────────────────────────────────────────────
  const missing = await postMessage(slack, { channel: '#missing', text: 'hi' })
  t('okFalse.channelNotFound', { kind: missing.error?.kind, code: missing.error?.code, retryable: missing.error?.retryable })
  const locked = await postMessage(slack, { channel: '#locked', text: 'hi' })
  t('okFalse.notInChannel', { kind: locked.error?.kind, code: locked.error?.code })
  const long = await postMessage(slack, { channel: '#ops', text: 'x'.repeat(4001) })
  t('okFalse.msgTooLong', { kind: long.error?.kind, code: long.error?.code, retryable: long.error?.retryable })

  const wrongKey = createConduit({ credentials: createStaticResolver({ SLACK_BOT_TOKEN: 'xoxb-revoked' }) })
  await wrongKey.register(targets.api)
  const unauth = await postMessage(bindSlack(wrongKey, targets), { channel: '#ops', text: 'hi' })
  await wrongKey.destroy()
  t('okFalse.invalidAuth', { kind: unauth.error?.kind, code: unauth.error?.code, retryable: unauth.error?.retryable })

  // ── negative control: the same answer with no validator is a success ──
  const bare = await slack.api<{ ok: boolean; error?: string }>({ method: 'POST', path: '/api/chat.postMessage', body: { channel: '#missing', text: 'hi' } })
  t('withoutValidate.isPlausibleWrongAnswer', { conduitSaysOk: bare.error === null, bodySaysOk: bare.data?.ok, status: bare.meta.status })
  const checked = await slack.api({ method: 'POST', path: '/api/chat.postMessage', body: { channel: '#missing', text: 'hi' }, validate: okEnvelope })
  t('withValidate.isInvalidResponse', { kind: checked.error?.kind, status: checked.meta.status })

  // ── chaos: handed back, never replayed ─────────────────────────────────
  await ctl.reset()
  await ctl.arm({ failNext: true })
  const fatal = await postMessage(slack, { channel: '#ops', text: 'hi' })
  t('fatalError.retryableHandedBack', { kind: fatal.error?.kind, code: fatal.error?.code, retryable: fatal.error?.retryable, attempts: (await seen()).requests.length })

  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 30 } })
  const t0 = Date.now()
  const limited = await postMessage(slack, { channel: '#ops', text: 'hi' })
  t('rateLimited.handedBackWithRetryAfter', { kind: limited.error?.kind, code: limited.error?.code, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs,
    attempts: (await seen()).requests.length, waited: Date.now() - t0 >= 30_000 })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const before = (await seen()).messages.length
  const lost = await postMessage(slack, { channel: '#ops', text: 'did this land' })
  // Reset keeps the messages, as Slack would: the row counts what this post added.
  t('lostResponse.isIndeterminate', { kind: lost.error?.kind, retryable: lost.error?.retryable, attempts: (await seen()).requests.length, landedAtSlack: (await seen()).messages.length - before })

  // ── refused before the send ────────────────────────────────────────────
  const threw = async (fn: () => Promise<unknown>) => { try { await fn(); return false } catch { return true } }
  t('local.refusals', {
    noChannel: await threw(() => postMessage(slack, { channel: '', text: 'x' })),
    nothingToSay: await threw(() => postMessage(slack, { channel: '#ops' })),
    tooManyBlocks: await threw(() => postMessage(slack, { channel: '#ops', blocks: Array.from({ length: 51 }, () => divider()) })),
    longHeader: await threw(async () => header('h'.repeat(151))),
    relativeWebhook: await threw(() => postWebhook(slack, '/services/T000/B000/live', { text: 'x' })),
  })

  // ── incoming webhook ───────────────────────────────────────────────────
  await ctl.reset()
  const ok = await postWebhook(slack, sink.webhookUrl, { text: 'from the row', blocks: [section('hello')] })
  const wreq = (await seen()).requests[0]
  t('webhook.succeeds', { ok: ok.ok, path: wreq.path, noAuthHeader: !('authorization' in wreq.headers), via: (await seen()).messages.at(-1)?.via })
  const dead = await postWebhook(slack, sink.deletedWebhookUrl, { text: 'x' })
  t('webhook.deletedIsGone', { ok: dead.ok, kind: dead.error?.kind, code: dead.error?.code, retryable: dead.error?.retryable })
  const bad = await slack.webhook<string>({ method: 'POST', address: sink.webhookUrl, body: { nothing: true } })
  t('webhook.invalidPayloadIsRefused', { kind: bad.error?.kind, status: bad.meta.status, raw: bad.error?.raw })
  const badT = await postWebhook(slack, sink.webhookUrl, { text: 'x'.repeat(4001) })
  t('webhook.tooLongIsRefusedByVendor', { kind: badT.error?.kind, code: badT.error?.code })

  // ── negative control: production's target refuses the loopback URL ────
  await ctl.reset()
  const prod = createConduit({ ...DRIVE_RESILIENCE })
  const prodTargets = slackTargets()
  await prod.register(prodTargets.webhook)
  const refused = await postWebhook(bindSlack(prod, prodTargets), sink.webhookUrl, { text: 'x' })
  await prod.destroy()
  t('webhook.loopbackRefusedWithoutDestinations', { ok: refused.ok, kind: refused.error?.kind, namesTheRefusal: /refused to send/i.test(refused.error?.message ?? ''), reachedSink: (await seen()).requests.length })

  // ── inbound: real signed events over a real socket ─────────────────────
  await ctl.reset()
  await fetch(`${sink.url}/_sink/event`, { method: 'POST', body: JSON.stringify({ type: 'url_verification', challenge: 'c0ffee' }) })
  const verification = (await seen()).events[0]
  t('event.urlVerificationEchoed', { status: verification.status, echoed: verification.echoed })

  await ctl.arm({ deliverTwice: true })
  await fetch(`${sink.url}/_sink/event`, { method: 'POST', body: JSON.stringify({ type: 'event_callback', event_id: 'Ev001', event: { type: 'app_mention', text: '<@U0> hi' } }) })
  const deliveries = (await seen()).events.filter(e => e.id === 'Ev001')
  t('event.duplicateProcessedOnce', { deliveries: deliveries.length, answered: deliveries.map(e => e.status), retryNums: retriesSeen, processed: processed.filter(id => id === 'Ev001').length })

  // ── the refusals, against the pure function with the clock moved ───────
  const body = JSON.stringify({ type: 'event_callback', team_id: 'T000', event_id: 'Ev9', event_time: 1, event: {} })
  const now  = 1_700_000_000
  const sig  = (at: number, secret = SIGNING) => 'v0=' + createHmac('sha256', secret).update(`v0:${at}:${body}`).digest('hex')
  const v = (at: number, signature: string | null, raw = body, clock = now) =>
    verifySlackSignature({ rawBody: raw, headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': String(at) }, secret: SIGNING, now: clock }).ok
  t('verify.genuine',     v(now, sig(now)))
  t('verify.forged',      v(now, sig(now, 'wrong')))
  t('verify.swappedBody', v(now, sig(now), body + ' '))
  t('verify.movedClock',  { past: v(now - 400, sig(now - 400)), future: v(now + 400, sig(now + 400)), edge: v(now - 300, sig(now - 300)) })
  t('verify.unsigned',    v(now, null))
  t('verify.wrongVersion', v(now, sig(now).replace('v0=', 'v1=')))
  t('verify.retryOf', { first: retryOf({ 'x-slack-retry-num': null }), again: retryOf({ 'x-slack-retry-num': '2', 'x-slack-retry-reason': 'http_timeout' }) })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); receiver.stop(true); await conduit.destroy()
}

process.exit(report(got, {
  'postMessage.succeeds':                 { ok: true, channel: '#ops', hasTs: true, threaded: '1700000000.000100', bearerOnWire: true, contentType: 'application/json', path: '/api/chat.postMessage' },
  'postMessage.blocksOnWire':             { ok: true, types: ['header', 'section', 'divider', 'context'] },
  'okFalse.channelNotFound':              { kind: 'refused', code: 'channel_not_found', retryable: false },
  'okFalse.notInChannel':                 { kind: 'refused', code: 'not_in_channel' },
  'okFalse.msgTooLong':                   { kind: 'too_long', code: 'msg_too_long', retryable: false },
  'okFalse.invalidAuth':                  { kind: 'auth_failed', code: 'invalid_auth', retryable: false },
  'withoutValidate.isPlausibleWrongAnswer': { conduitSaysOk: true, bodySaysOk: false, status: 200 },
  'withValidate.isInvalidResponse':       { kind: 'invalid_response', status: 200 },
  'fatalError.retryableHandedBack':       { kind: 'server_error', code: 'fatal_error', retryable: true, attempts: 1 },
  'rateLimited.handedBackWithRetryAfter': { kind: 'rate_limited', code: 'ratelimited', retryable: true, retryAfterMs: 30_000, attempts: 1, waited: false },
  'lostResponse.isIndeterminate':         { kind: 'timeout', retryable: false, attempts: 1, landedAtSlack: 1 },
  'local.refusals':                       { noChannel: true, nothingToSay: true, tooManyBlocks: true, longHeader: true, relativeWebhook: true },
  'webhook.succeeds':                     { ok: true, path: '/services/T000/B000/live', noAuthHeader: true, via: 'webhook' },
  'webhook.deletedIsGone':                { ok: false, kind: 'gone', code: 'no_service', retryable: false },
  'webhook.invalidPayloadIsRefused':      { kind: 'client_error', status: 400, raw: 'invalid_payload' },
  'webhook.tooLongIsRefusedByVendor':     { kind: 'too_long', code: 'msg_too_long' },
  'webhook.loopbackRefusedWithoutDestinations': { ok: false, kind: 'invalid_request', namesTheRefusal: true, reachedSink: 0 },
  'event.urlVerificationEchoed':          { status: 200, echoed: 'c0ffee' },
  'event.duplicateProcessedOnce':         { deliveries: 2, answered: [200, 200], retryNums: [1], processed: 1 },
  'verify.genuine':      true,
  'verify.forged':       false,
  'verify.swappedBody':  false,
  'verify.movedClock':   { past: false, future: false, edge: true },
  'verify.unsigned':     false,
  'verify.wrongVersion': false,
  'verify.retryOf':      { first: null, again: { num: 2, reason: 'http_timeout' } },
}))
