// test/plausible.drive.ts — the connector against the sink. A Plausible CE
// fixture exists (docker, postgres + clickhouse) and is unproved here; the
// drive takes FIXTURE_URL, FIXTURE_KEY, FIXTURE_SITE for the read rows.
// What only this drive asks: a POST that READS is replayed by conduit on a
// lost response and on a 429 with Retry-After, where every send-shaped
// connector hands those back; a 429 with no header is the hourly quota.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startPlausibleSink } from '../sink.ts'
import { plausibleTarget, bindSend, query, queryAll } from '../src/index.ts'

const { got, t } = results()
const sink = startPlausibleSink(), ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ PLAUSIBLE_API_KEY: sink.key, FX: process.env.FIXTURE_KEY ?? '' }), ...DRIVE_RESILIENCE })
await conduit.register(plausibleTarget({ address: sink.url }))
const send = bindSend(conduit)
const seen = () => ctl.seen() as unknown as Promise<{ requests: unknown[] }>
const base = { site_id: 'shop.test', metrics: ['visitors', 'pageviews'], date_range: '7d' as const, dimensions: ['event:page'] }

try {
  const one = await query(send, { ...base, pagination: { limit: 10 } })
  t('query.readsAPage', { ok: !one.error, rows: one.result?.results.length, total: one.result?.meta.total_rows })
  await ctl.reset()
  const all = await queryAll(send, base, { pageSize: 10 })
  t('queryAll.walksOffsets', { rows: all.rows?.length, pages: all.pages, requests: (await seen()).requests.length })
  t('query.unknownSite', { kind: (await query(send, { ...base, site_id: 'nope.test' })).error?.kind })
  t('query.emptyMetricsRefusedLocally', { kind: (await query(send, { ...base, metrics: [] })).error?.kind, sent: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await query(send, base)
  t('lostResponse.readIsReplayed', { ok: !lost.error, attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const t0 = Date.now(); const rl = await query(send, base)
  t('rateLimited.burstIsReplayedAfterWait', { ok: !rl.error, waited: Date.now() - t0 >= 1000, attempts: (await seen()).requests.length })

  // No Retry-After: conduit backs off on its own schedule and retries the
  // read. An hourly budget does not clear in that time, so every attempt is
  // 429 and the caller finally sees `quota`.
  await ctl.reset(); await ctl.arm({ quota: 3 })
  const q = await query(send, base)
  t('rateLimited.noHeaderIsQuotaAfterRetries', { kind: q.error?.kind, retryable: q.error?.retryable, attempts: (await seen()).requests.length })

  await ctl.arm({ failNext: true })
  t('serverError.readIsReplayed', { ok: !(await query(send, base)).error })

  if (process.env.FIXTURE_URL) {
    await conduit.register(plausibleTarget({ address: process.env.FIXTURE_URL, ref: 'FX', id: 'provider:plausible:fixture' }))
    const fx = await query(bindSend(conduit, 'provider:plausible:fixture'), { site_id: process.env.FIXTURE_SITE ?? 'shop.test', metrics: ['visitors'], date_range: '7d' })
    t('fixture.readsAPage', { ok: !fx.error, hasResults: Array.isArray(fx.result?.results) })
  } else console.log('  skip  fixture rows — FIXTURE_URL is not set (unproved against a real server)')
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); await conduit.destroy() }

process.exit(report(got, {
  'query.readsAPage':                 { ok: true, rows: 10, total: 25 },
  'queryAll.walksOffsets':            { rows: 25, pages: 3, requests: 3 },
  'query.unknownSite':                { kind: 'unknown_site' },
  'query.emptyMetricsRefusedLocally': { kind: 'refused', sent: 4 },
  'lostResponse.readIsReplayed':      { ok: true, attempts: 2 },
  'rateLimited.burstIsReplayedAfterWait': { ok: true, waited: true, attempts: 2 },
  'rateLimited.noHeaderIsQuotaAfterRetries': { kind: 'quota', retryable: false, attempts: 3 },
  'serverError.readIsReplayed':       { ok: true },
  ...(process.env.FIXTURE_URL ? { 'fixture.readsAPage': { ok: true, hasResults: true } } : {}),
}))
