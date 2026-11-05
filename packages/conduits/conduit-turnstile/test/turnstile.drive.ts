// test/turnstile.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: the secret is in the BODY and in no header; a
// token verifies once and is `spent` the second time unless the same
// idempotency key rides both; a lost response WITH a key is replayed and
// WITHOUT one is handed back; a token for another hostname is refused here.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startTurnstileSink } from '../sink.ts'
import { turnstileTarget, signers, bindSend, siteverify } from '../src/index.ts'

const { got, t } = results()
const sink = startTurnstileSink(), ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ TURNSTILE_SECRET: sink.secret, WRONG: 'nope' }), signers, ...DRIVE_RESILIENCE })
await conduit.register(turnstileTarget({ address: sink.url }))
await conduit.register(turnstileTarget({ address: sink.url, ref: 'WRONG', id: 'provider:turnstile:wrong' }))
const send = bindSend(conduit)
const seen = () => ctl.seen() as unknown as Promise<{ requests: { headers: Record<string, string>; body: string }[] }>

try {
  const ok = await siteverify(send, { token: 'tok-ok-shop', remoteip: '203.0.113.7', expectedHostname: 'shop.test' })
  const wire = (await seen()).requests[0]
  t('verify.secretInBodyNotHeader', { ok: !ok.error, hostname: ok.result?.hostname, bodyHasSecret: wire.body.includes(`secret=${encodeURIComponent(sink.secret)}`), bodyHasIp: wire.body.includes('remoteip=203.0.113.7'), anyAuthHeader: Object.keys(wire.headers).some(h => /authorization|secret/i.test(h)) })

  const again = await siteverify(send, { token: 'tok-ok-shop' })
  t('verify.secondUseIsSpent', { kind: again.error?.kind, codes: again.error?.codes, retryable: again.error?.retryable })

  const k1 = await siteverify(send, { token: 'tok-ok-blog', idempotencyKey: 'form-1' })
  const k2 = await siteverify(send, { token: 'tok-ok-blog', idempotencyKey: 'form-1' })
  const k3 = await siteverify(send, { token: 'tok-ok-blog', idempotencyKey: 'form-2' })
  t('verify.idempotencyKeyReverifies', { first: !k1.error, same: !k2.error, otherKey: k3.error?.kind })

  t('verify.hostnameMismatchRefusedLocally', { kind: (await siteverify(send, { token: 'tok-ok-news', expectedHostname: 'shop.test' })).error?.codes })
  t('verify.oldTokenIsSpent', { kind: (await siteverify(send, { token: 'tok-old' })).error?.kind })
  t('verify.garbageIsRefused', { kind: (await siteverify(send, { token: 'tok-nope' })).error?.kind, codes: (await siteverify(send, { token: 'tok-nope' })).error?.codes })
  t('verify.wrongSecretIsMisconfigured', { kind: (await siteverify(bindSend(conduit, 'provider:turnstile:wrong'), { token: 'tok-ok-shop' })).error?.kind })

  // The negative control: the same connector against a JSON target. The
  // signer refuses to put the secret inside a JSON string.
  const bare = createConduit({ credentials: createStaticResolver({ TURNSTILE_SECRET: sink.secret }), signers })
  const { encoding: _e, ...jsonTarget } = turnstileTarget({ address: sink.url })
  await bare.register(jsonTarget)
  const wrong = await siteverify(bindSend(bare), { token: 'tok-ok-a' })
  // A signer that throws is `auth_failed`: nothing left the process (FJS-2726).
  t('withoutFormEncoding.signerRefuses', { kind: wrong.error?.kind })
  await bare.destroy()

  await ctl.reset(); await ctl.arm({ failNext: true })
  const internal = await siteverify(send, { token: 'tok-ok-c' })
  t('internalErrorOn200.isRetryable', { kind: internal.error?.kind, retryable: internal.error?.retryable })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lostKeyed = await siteverify(send, { token: 'tok-ok-d', idempotencyKey: 'form-d' })
  t('lostResponse.keyedIsReplayed', { ok: !lostKeyed.error, attempts: (await seen()).requests.length })
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostBare = await siteverify(send, { token: 'tok-ok-e' })
  t('lostResponse.unkeyedHandedBack', { kind: lostBare.error?.kind, retryable: lostBare.error?.retryable, attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const rl = await siteverify(send, { token: 'tok-ok-f' })
  t('rateLimited.handedToCaller', { kind: rl.error?.kind, retryAfterMs: rl.error?.retryAfterMs })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); await conduit.destroy() }

process.exit(report(got, {
  'verify.secretInBodyNotHeader':        { ok: true, hostname: 'shop.test', bodyHasSecret: true, bodyHasIp: true, anyAuthHeader: false },
  'verify.secondUseIsSpent':             { kind: 'spent', codes: ['timeout-or-duplicate'], retryable: false },
  'verify.idempotencyKeyReverifies':     { first: true, same: true, otherKey: 'spent' },
  'verify.hostnameMismatchRefusedLocally': { kind: ['hostname-mismatch'] },
  'verify.oldTokenIsSpent':              { kind: 'spent' },
  'verify.garbageIsRefused':             { kind: 'refused', codes: ['invalid-input-response'] },
  'verify.wrongSecretIsMisconfigured':   { kind: 'misconfigured' },
  'withoutFormEncoding.signerRefuses':   { kind: 'auth_failed' },
  'internalErrorOn200.isRetryable':      { kind: 'server_error', retryable: true },
  'lostResponse.keyedIsReplayed':        { ok: true, attempts: 2 },
  'lostResponse.unkeyedHandedBack':      { kind: 'timeout', retryable: false, attempts: 1 },
  'rateLimited.handedToCaller':          { kind: 'rate_limited', retryAfterMs: 1000 },
}))
