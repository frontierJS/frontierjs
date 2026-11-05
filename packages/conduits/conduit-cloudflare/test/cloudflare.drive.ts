// test/cloudflare.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: a 200 whose envelope says it failed is a
// failure; a batch is all or nothing; a lost response on a batch is
// indeterminate and the zone re-read shows the write landed; the same batch
// sent twice makes two records, because Cloudflare honors no key.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startCfSink, EMPTY_TOKEN, BROKEN_ZONE } from '../sink.ts'
import { cloudflareTarget, bindSend, verify, zones, zone, records, batch, setRecords, CloudflareError } from '../src/index.ts'

const { got, t } = results()
const sink = startCfSink()
const ctl = control(sink.url.replace(/\/client\/v4$/, ''))
const conduit = createConduit({ credentials: createStaticResolver({ CF: 'cfat_devtoken', CF_EMPTY: EMPTY_TOKEN, CF_BAD: 'nope' }), ...DRIVE_RESILIENCE })
for (const [accountId, ref] of [['a', 'CF'], ['empty', 'CF_EMPTY'], ['bad', 'CF_BAD']]) await conduit.register(cloudflareTarget({ accountId, ref, address: sink.url }))
const send = bindSend(conduit, 'provider:cloudflare:a')
const seen = () => ctl.seen() as unknown as Promise<{ requests: { method: string; path: string; status: number }[] }>
const failure = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (e) { return e instanceof CloudflareError ? { kind: e.failure.kind, code: e.failure.code, retryable: e.failure.retryable, retryAfterMs: e.failure.retryAfterMs } : { threw: String(e) } } }
const owns = (r: { comment: string | null }) => (r.comment ?? '').startsWith('app:')

try {
  t('verify.threeTokens', { good: await verify(send), empty: await verify(bindSend(conduit, 'provider:cloudflare:empty')), bad: await verify(bindSend(conduit, 'provider:cloudflare:bad')) })

  await ctl.reset()
  const zs = await zones(send)
  t('zones.walksPages', { count: zs.length, pagesFetched: (await seen()).requests.length, names: zs.map(z => z.name) })
  t('zone.missing', await failure(() => zone(send, 'zone-nope')))

  t('records.200ThatIsAFailure', await failure(() => records(send, BROKEN_ZONE)))

  await ctl.reset(); await ctl.arm({ lyingPages: true })
  t('records.lyingTotalPagesIsCapped', { ...(await failure(() => records(send, 'zone-example'))), pages: (await seen()).requests.length })

  // setRecords: a set holding somebody else's record is refused before any send.
  await ctl.reset()
  const foreign = await failure(() => setRecords(send, 'zone-shop', [{ type: 'A', name: 'www.shop.test', content: '192.0.2.99', comment: 'app:domain:d9' }], owns))
  t('setRecords.unownedSetRefusedBeforeSending', { ...foreign, batchesSent: (await seen()).requests.filter(r => r.path.endsWith('/batch')).length })

  const set1 = await setRecords(send, 'zone-example', [{ type: 'CNAME', name: 'example.test', content: 'ingress-1.fleet.test', proxied: true, comment: 'app:domain:dom-1' }], owns)
  await ctl.reset()
  const set2 = await setRecords(send, 'zone-example', [{ type: 'CNAME', name: 'example.test', content: 'ingress-2.fleet.test', proxied: true, comment: 'app:domain:dom-1' }], owns)
  t('setRecords.unchangedIsNoRequestChangedIsOneBatch', { keptId: set1[0]?.id, replaced: set2[0]?.content, batches: (await seen()).requests.filter(r => r.path.endsWith('/batch')).length })

  // A batch is all or nothing: a clash on the second post leaves the first unmade.
  const before = (await records(send, 'zone-shop')).length
  const clash = await failure(() => batch(send, 'zone-shop', { posts: [{ type: 'TXT', name: 'shop.test', content: 'x' }, { type: 'CNAME', name: 'www.shop.test', content: 'elsewhere.test' }] }))
  t('batch.allOrNothing', { ...clash, after: (await records(send, 'zone-shop')).length - before })

  // Lost response: indeterminate, and the zone shows the write landed.
  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await failure(() => batch(send, 'zone-pending', { posts: [{ type: 'TXT', name: 'pending.test', content: 'lost' }] }))
  const landed = (await records(send, 'zone-pending')).filter(r => r.content === 'lost').length
  t('batch.lostResponseIsIndeterminateAndLanded', { ...lost, landed, attempts: (await seen()).requests.filter(r => r.path.endsWith('/batch')).length })

  // The same batch twice is two records. Cloudflare ignores a key, so the
  // connector sends none and the drive asserts none went out.
  await ctl.reset()
  await batch(send, 'zone-pending', { posts: [{ type: 'TXT', name: 'pending.test', content: 'dup' }] })
  await batch(send, 'zone-pending', { posts: [{ type: 'TXT', name: 'pending.test', content: 'dup' }] })
  t('batch.duplicateMakesTwo', { dups: (await records(send, 'zone-pending')).filter(r => r.content === 'dup').length })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const t0 = Date.now(); const z2 = await zones(send)
  t('rateLimited.getIsReplayedAfterWait', { ok: z2.length > 0, waited: Date.now() - t0 >= 1000 })
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  t('rateLimited.batchIsHandedToCaller', await failure(() => batch(send, 'zone-pending', { posts: [{ type: 'TXT', name: 'pending.test', content: 'rl' }] })))
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); await conduit.destroy() }

process.exit(report(got, {
  'verify.threeTokens':                 { good: true, empty: false, bad: false },
  'zones.walksPages':                   { count: 4, pagesFetched: 2, names: ['example.test', 'shop.test', 'pending.test', 'broken.test'] },
  'zone.missing':                       { kind: 'missing', code: 7003, retryable: false },
  'records.200ThatIsAFailure':          { kind: 'refused', code: 1000, retryable: false },
  'records.lyingTotalPagesIsCapped':    { kind: 'refused', retryable: false, pages: 100 },
  'setRecords.unownedSetRefusedBeforeSending': { kind: 'refused', retryable: false, batchesSent: 0 },
  'setRecords.unchangedIsNoRequestChangedIsOneBatch': { keptId: 'rec-apex', replaced: 'ingress-2.fleet.test', batches: 1 },
  'batch.allOrNothing':                 { kind: 'conflict', code: 81053, retryable: false, after: 0 },
  'batch.lostResponseIsIndeterminateAndLanded': { kind: 'timeout', retryable: false, landed: 1, attempts: 1 },
  'batch.duplicateMakesTwo':            { dups: 2 },
  'rateLimited.getIsReplayedAfterWait': { ok: true, waited: true },
  'rateLimited.batchIsHandedToCaller':  { kind: 'rate_limited', code: 10000, retryable: true, retryAfterMs: 1000 },
}))
