// test/zapier.drive.ts — the target through a real conduit against the sink.
//
// Run: `bun run drive`. No fixture: Zapier is hosted and a test Zap would be a
// real account's. What only this drive asks: a post is never replayed and a
// lost one is `indeterminate` with no read to resolve it; the reverse
// unsubscribe IS replayed; a 404 reads `off` and a 410 `gone`; and the
// negative control — the production target refuses the sink's loopback URL
// before anything leaves, the row slack's webhook target proves too.

import { createConduit, type ConduitError } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startZapierSink } from '../sink.ts'
import { zapierTarget, bindSend, postHook, unsubscribe, subscriptionFrom, hookEnvelope, translate, MAX_PAYLOAD_BYTES } from '../src/index.ts'

const { got, t } = results()
const sink = startZapierSink(), ctl = control(sink.url)
const conduit = createConduit({ ...DRIVE_RESILIENCE })
const target = zapierTarget({ destinations: { allowHttp: true, allowPrivate: true } })
await conduit.register(target)
const zapier = bindSend(conduit, target.id)

type Seen = { requests: { method: string; path: string; headers: Record<string, string>; body: string }[]; hooks: { hook: string; payload: unknown; silent: boolean }[]; subscribed: string[] }
const seen = () => ctl.seen<never>() as unknown as Promise<Seen>
const attempts = async () => (await seen()).requests.length

try {
  // ── a Catch Hook: the shape on the wire ─────────────────────────────────
  const first = await postHook(zapier, sink.catchUrl, { lead: 'Ada', email: 'ada@example.com' })
  const req0 = (await seen()).requests[0]
  t('postHook.succeeds', { ok: !first.error, status: first.result?.status, silent: first.result?.silent, hasId: typeof first.result?.id === 'string', hasRequestId: typeof first.result?.requestId === 'string',
    path: req0.path, contentType: req0.headers['content-type'].split(';')[0], noAuthHeader: !('authorization' in req0.headers), arrived: (await seen()).hooks.at(-1)?.payload })

  const silent = await postHook(zapier, sink.silentUrl, { n: 1 })
  t('postHook.silentIsEmpty200', { ok: !silent.error, status: silent.result?.status, silent: silent.result?.silent, id: silent.result?.id })

  const multi = await postHook(zapier, sink.multiUrl, [{ a: 1 }, { a: 2 }])
  t('postHook.multiZapUrlAndArrayPayload', { ok: !multi.error, path: (await seen()).requests.at(-1)?.path, arrived: (await seen()).hooks.at(-1)?.payload })

  await ctl.reset()
  const off = await postHook(zapier, sink.offUrl, { n: 1 })
  t('postHook.zapOffIs404Off', { kind: off.error?.kind, retryable: off.error?.retryable, attempts: await attempts() })

  // ── a REST Hook target_url and the reverse unsubscribe ─────────────────
  await ctl.reset()
  const std = await postHook(zapier, sink.standardUrl, { event: 'lead.created', id: 7 })
  t('postHook.restHookDelivers', { ok: !std.error, hook: (await seen()).hooks.at(-1)?.hook })
  const un = await unsubscribe(zapier, sink.standardUrl)
  t('unsubscribe.pausesTheZap', { ok: !un.error, already: un.result?.already, method: (await seen()).requests.at(-1)?.method, subscribed: (await seen()).subscribed })
  const gone = await postHook(zapier, sink.standardUrl, { n: 2 })
  t('postHook.unsubscribedIs410Gone', { kind: gone.error?.kind, retryable: gone.error?.retryable })
  const again = await unsubscribe(zapier, sink.standardUrl)
  t('unsubscribe.alreadyGoneIsTheStateAsked', { ok: !again.error, already: again.result?.already })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const lostUn = await unsubscribe(zapier, sink.standardUrlFor('second'))
  t('unsubscribe.lostIsReplayedAndFindsItGone', { ok: !lostUn.error, already: lostUn.result?.already, attempts: await attempts(), subscribed: (await seen()).subscribed })

  // ── chaos on a post: handed back, never replayed ───────────────────────
  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 30 } })
  const t0 = Date.now()
  const limited = await postHook(zapier, sink.catchUrl, { n: 3 })
  t('rateLimited.handedBackWithRetryAfter', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, attempts: await attempts(), waited: Date.now() - t0 >= 30_000 })

  await ctl.reset()
  await ctl.arm({ failNext: true })
  const five = await postHook(zapier, sink.catchUrl, { n: 4 })
  t('serverError.handedBackNotReplayed', { kind: five.error?.kind, retryable: five.error?.retryable, indeterminate: five.error?.indeterminate, attempts: await attempts() })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const before = (await seen()).hooks.length
  const lost = await postHook(zapier, sink.catchUrl, { n: 5 })
  t('lostResponse.isIndeterminateNoRead', { kind: lost.error?.kind, indeterminate: lost.error?.indeterminate, retryable: lost.error?.retryable, attempts: await attempts(), landedAtZapier: (await seen()).hooks.length - before })

  // ── refused before the send ────────────────────────────────────────────
  await ctl.reset()
  const refusals = await Promise.all([
    postHook(zapier, '/hooks/catch/1/x/', { n: 1 }),
    postHook(zapier, 'ftp://hooks.zapier.com/hooks/catch/1/x/', { n: 1 }),
    postHook(zapier, 'https://u:p@hooks.zapier.com/hooks/catch/1/x/', { n: 1 }),
    postHook(zapier, sink.catchUrl, 'text' as never),
    postHook(zapier, sink.catchUrl, { big: 'x'.repeat(MAX_PAYLOAD_BYTES) }),
    unsubscribe(zapier, 'not a url'),
  ])
  t('local.refusals', { kinds: refusals.map(r => r.error?.kind), sent: await attempts() })

  // ── negative control: production's target refuses the loopback URL ────
  const prod = createConduit({ ...DRIVE_RESILIENCE })
  const prodTarget = zapierTarget({ id: 'provider:zapier:prod' })
  await prod.register(prodTarget)
  const refused = await postHook(bindSend(prod, prodTarget.id), sink.catchUrl, { n: 1 })
  await prod.destroy()
  t('destinations.loopbackRefusedWithoutThem', { kind: refused.error?.kind, namesTheRefusal: /refused to send/i.test(refused.error?.message ?? ''), reachedSink: await attempts() })

  // ── the pure parts ─────────────────────────────────────────────────────
  t('hookEnvelope.table', {
    empty:   hookEnvelope.validate(null).ok,
    success: hookEnvelope.validate({ status: 'success', id: 'x' }).ok,
    bare:    hookEnvelope.validate({}).ok,
    other:   hookEnvelope.validate({ status: 'error' }).ok,
    text:    hookEnvelope.validate('ok').ok,
    list:    hookEnvelope.validate([]).ok,
  })
  const err = (kind: ConduitError['kind'], status?: number, extra: Partial<ConduitError> = {}) =>
    translate({ kind, target: 't', protocol: 'http', message: 'm', retryable: false, ...extra }, status)
  const limitedT = err('rate_limited', 429, { retryable: true, retry_after_ms: 5000, raw: { status: 'error', error: 'rate limit exceeded' } })
  t('translate.table', {
    off: err('client_error', 404).kind, gone: err('client_error', 410).kind, refused: err('client_error', 400).kind,
    limited: { kind: limitedT.kind, retryable: limitedT.retryable, retryAfterMs: limitedT.retryAfterMs, message: limitedT.message },
    server: err('server_error', 500, { retryable: true }).kind,
    lost: err('timeout', undefined, { indeterminate: true }).indeterminate,
    authKept: err('auth_failed', 403).kind,
  })
  t('subscriptionFrom.table', {
    camel:     subscriptionFrom({ targetUrl: 'https://hooks.zapier.com/hooks/standard/1/k/', event: 'lead.created' }),
    snake:     subscriptionFrom({ target_url: 'https://hooks.zapier.com/hooks/standard/1/k/' }).ok,
    lan:       subscriptionFrom({ target_url: 'https://10.0.0.5/hooks/standard/1/k/' }),
    foreign:   subscriptionFrom({ target_url: 'https://evil.example/hooks/standard/1/k/' }).ok,
    http:      subscriptionFrom({ target_url: 'http://hooks.zapier.com/hooks/standard/1/k/' }).ok,
    userinfo:  subscriptionFrom({ target_url: 'https://a:b@hooks.zapier.com/hooks/standard/1/k/' }).ok,
    missing:   subscriptionFrom({ event: 'x' }).ok,
    notObject: subscriptionFrom('x').ok,
    sink:      subscriptionFrom({ targetUrl: sink.standardUrl }, { hosts: [sink.host] }).ok,
  })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); await conduit.destroy()
}

process.exit(report(got, {
  // Conduit drops the trailing slash Zapier's URLs carry; the sink answers both spellings.
  'postHook.succeeds':                       { ok: true, status: 200, silent: false, hasId: true, hasRequestId: true, path: '/hooks/catch/123456/zbB61', contentType: 'application/json', noAuthHeader: true, arrived: { lead: 'Ada', email: 'ada@example.com' } },
  'postHook.silentIsEmpty200':               { ok: true, status: 200, silent: true, id: undefined },
  'postHook.multiZapUrlAndArrayPayload':     { ok: true, path: '/hooks/catch/123456/zbB61,kzXC4', arrived: [{ a: 1 }, { a: 2 }] },
  'postHook.zapOffIs404Off':                 { kind: 'off', retryable: false, attempts: 1 },
  'postHook.restHookDelivers':               { ok: true, hook: 'standard:stdkey' },
  'unsubscribe.pausesTheZap':                { ok: true, already: false, method: 'DELETE', subscribed: ['second'] },
  'postHook.unsubscribedIs410Gone':          { kind: 'gone', retryable: false },
  'unsubscribe.alreadyGoneIsTheStateAsked':  { ok: true, already: true },
  // The first DELETE applies and hangs; the replay finds the hook gone, which is the state asked for.
  'unsubscribe.lostIsReplayedAndFindsItGone': { ok: true, already: true, attempts: 2, subscribed: [] },
  'rateLimited.handedBackWithRetryAfter':    { kind: 'rate_limited', retryable: true, retryAfterMs: 30_000, attempts: 1, waited: false },
  // Conduit's `retryable` is "safe to send again", false for an unkeyed POST whatever the status, and a 5xx may have run the Zap first; Zapier names no 5xx that was refused before running.
  'serverError.handedBackNotReplayed':       { kind: 'server_error', retryable: false, indeterminate: true, attempts: 1 },
  'lostResponse.isIndeterminateNoRead':      { kind: 'timeout', indeterminate: true, retryable: false, attempts: 1, landedAtZapier: 1 },
  'local.refusals':                          { kinds: ['refused', 'refused', 'refused', 'refused', 'refused', 'refused'], sent: 0 },
  'destinations.loopbackRefusedWithoutThem': { kind: 'invalid_request', namesTheRefusal: true, reachedSink: 0 },
  'hookEnvelope.table':                      { empty: true, success: true, bare: true, other: false, text: false, list: false },
  'translate.table':                         { off: 'off', gone: 'gone', refused: 'refused', limited: { kind: 'rate_limited', retryable: true, retryAfterMs: 5000, message: 'Zapier: rate limit exceeded' }, server: 'server_error', lost: true, authKept: 'auth_failed' },
  'subscriptionFrom.table':                  { camel: { ok: true, subscription: { targetUrl: 'https://hooks.zapier.com/hooks/standard/1/k/', event: 'lead.created' } }, snake: true, lan: { ok: false, reason: "target_url host 10.0.0.5 is not Zapier's" }, foreign: false, http: false, userinfo: false, missing: false, notObject: false, sink: true },
}))
