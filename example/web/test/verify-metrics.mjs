// web/test/verify-metrics.mjs — the readings that get kept.
//
// bun, no server, no browser and no seed: it makes its own tenant, writes its
// own points and drops it. Nothing here needs an HTTP request, and a drive that
// started a server would only be able to fail for reasons that are not about
// metrics.
//
// ─── The trap this file is arranged around ────────────────────────────────
//
// EVERY FAILURE HERE IS SILENT BY CONSTRUCTION. A rollup that loses a point
// draws a smoother graph. A counter differenced the naive way reports a
// negative number once a day and nobody is watching that minute. A store that
// stopped being written looks exactly like a value that stopped changing. None
// of it throws, none of it empties a screen, and all of it stays plausible.
//
// So every assertion below is PAIRED with its own wrong answer — the arithmetic
// somebody would write first, computed beside the right one and asserted to
// differ. A test that only checked the correct value would pass against the
// naive implementation too, which is the shape that lets this class of bug live
// for a year.

import { spawnSync } from 'node:child_process'

const HOUR   = 3_600_000
const hourOf = ms => Math.floor(ms / HOUR) * HOUR
const SHOP   = 'metricsdrive'

let pass = 0, fail = 0
const ok = (cond, msg) => { cond ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${msg}`)) : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${msg}`)) }
const section = t => console.log(`\n\x1b[1m${t}\x1b[0m`)

process.env.SHOP = SHOP

const { sys, db } = await import('../../api/src/core/db.ts')
// From the package, not from this app: the models are junction's
// (`db/metrics.lite`) and so is the reset rule that reads them. An app-local
// copy of either is the second spelling this drive exists to prevent.
const { counterIncrease, counterRate, isStale, metricsPlugin, seriesKey } = await import('@frontierjs/junction')

const iso = () => new Date().toISOString()

// The fold is the plugin's, and the plugin drives it on a timer. Rather than
// wait an hour or reach into a private, the drive builds a plugin whose rollup
// interval is immediate and boots it against a minimal app-shaped object — so
// what runs here is the SHIPPED pass and not a copy of it, which is the whole
// point of moving it into the package.
const plugin  = metricsPlugin()
const fakeApp = { db: { asSystem: () => sys }, logger: console, registerMetricsSource: () => {} }
plugin.register(fakeApp)
// `app.metrics.rollupNow()` — the operator's entry, which is also what makes
// the SHIPPED pass drivable here instead of reimplemented. No timer is ever
// started: boot() is never called, so the drive runs exactly one fold.
const foldNow = () => fakeApp.metrics.rollupNow()
const mkSeries = (key, type) => sys.metricSeries.upsert({
  where:  { labelsKey: key },
  create: { name: key, labelsKey: key, type, lastSeenAt: iso() },
  update: { type, lastSeenAt: iso() },
})
const put = (id, at, value) => sys.metricPoint.upsert({
  where: { seriesId: id, at }, create: { seriesId: id, at, value }, update: { value },
})

try {

// ─── 1. a counter that restarted ──────────────────────────────────────────
section('a counter that restarted')
{
  // Climbs 0→100, the process restarts, climbs 0→40. True increase is 140.
  const readings = [0, 50, 100, 0, 20, 40].map((value, i) => ({ at: i * 60_000, value }))

  const naiveDelta  = readings.at(-1).value - readings[0].value   // 40  — the first thing anybody writes
  const naiveClamp  = Math.max(0, naiveDelta)                     // 40  — the patch anybody reaches for second
  const answer      = counterIncrease(readings)

  ok(answer === 140, `increase across a reset is 140, got ${answer}`)
  ok(naiveDelta !== answer, `last − first (${naiveDelta}) disagrees — the naive answer is wrong, so this row is doing work`)
  ok(naiveClamp !== answer, `Math.max(0, …) (${naiveClamp}) disagrees too — clamping discards the whole first climb`)

  // The negative control: with no reset the naive answer must AGREE, or the
  // reset handling is firing on ordinary data and inventing increase.
  const clean = [0, 50, 100].map((value, i) => ({ at: i * 60_000, value }))
  ok(counterIncrease(clean) === 100, 'a counter that did NOT reset increases by last − first')
  ok(counterIncrease(clean) === clean.at(-1).value - clean[0].value, 'and the naive answer AGREES there — no phantom resets')

  // THE CASE THAT SEPARATES THE TWO PLAUSIBLE IMPLEMENTATIONS, and it is not
  // the one above. Clamping each delta at zero gives the RIGHT answer whenever
  // a counter resets to exactly 0 — the dropped delta was going to be discarded
  // anyway — so the reset above cannot tell the two apart. They diverge only
  // when the counter is scraped AFTER it has already climbed off zero: the
  // clamp throws that climb away, Prometheus's rule counts it.
  const offZero = [0, 50, 100, 30].map((value, i) => ({ at: i * 60_000, value }))
  const perDeltaClamp = offZero.slice(1).reduce((t, r, i) => t + Math.max(0, r.value - offZero[i].value), 0)
  ok(counterIncrease(offZero) === 130, `a reset caught mid-climb counts the 30, got ${counterIncrease(offZero)}`)
  ok(perDeltaClamp === 100, `and the per-delta clamp reports ${perDeltaClamp} — it discards the climb`)
  ok(perDeltaClamp !== counterIncrease(offZero), 'so this row is the one that grades reset handling at all')

  ok(counterIncrease([{ at: 0, value: 7 }]) === 0, 'one reading alone cannot show an increase')
  ok(counterRate([]) === null, 'a rate needs two readings')
  // Two readings stamped the same millisecond — which a cron firing twice in
  // one minute really produces. This is the row that reaches the span guard;
  // the empty-array row above returns early and grades nothing.
  ok(counterRate([{ at: 5, value: 1 }, { at: 5, value: 9 }]) === null,
     'a rate over ZERO elapsed time is null, not 0 — a 0 here is a threshold that silently never fires')
  const rate = counterRate(readings)
  ok(Math.abs(rate - 140 / 300) < 1e-9, `rate is the reset-aware increase over the span, got ${rate}`)
}

// ─── 2. a scrape that stopped ─────────────────────────────────────────────
section('a scrape that stopped, told apart from a value that is not moving')
{
  const now = Date.parse('2026-09-06T12:00:00Z')
  ok(isStale(new Date(now - 20 * 60_000).toISOString(), now), 'a series last written 20 minutes ago is stale')
  ok(!isStale(new Date(now - 60_000).toISOString(), now), 'a series written a minute ago is NOT stale — a late cron is not an outage')
  ok(isStale('not a date', now), 'an unparseable timestamp is stale rather than fresh — fail closed')
}

// ─── 3. the fold, and the prune it guards ─────────────────────────────────
section('the fold preserves what it replaces')
{
  const g = await mkSeries('drive.gaugeReading', 'gauge')
  const OLD = hourOf(Date.now()) - 100 * HOUR      // past the 48h raw window
  const NEW = hourOf(Date.now()) - 5   * HOUR      // inside it
  for (const base of [OLD, NEW]) for (let i = 0; i < 60; i++) await put(g.id, base + i * 60_000, i)
  ok(await sys.metricPoint.count({ where: { seriesId: g.id } }) === 120, '120 raw points across two hours')

  await foldNow()
  const hours = await sys.metricHour.findMany({ where: { seriesId: g.id }, orderBy: { hour: 'asc' } })
  ok(hours.length === 2, `both complete hours folded, got ${hours.length}`)
  ok(hours.every(h => h.count === 60), 'every fold kept the count')
  ok(hours.every(h => Math.abs(h.sum - 1770) < 1e-6), 'every fold kept the sum (0..59 = 1770)')
  ok(hours.every(h => h.min === 0 && h.max === 59), 'every fold kept min and max')
  ok(hours.every(h => h.increase === null), 'a GAUGE gets no increase — summing or differencing one measures nothing')

  const left = await sys.metricPoint.count({ where: { seriesId: g.id } })
  ok(left === 60, `only the hour past the 48h window was pruned (${left} raw left)`)
  const recent = await sys.metricPoint.count({ where: { seriesId: g.id, at: { gte: NEW } } })
  ok(recent === 60, 'the survivors are the RECENT hour — folded AND kept, which is the design')
}

// ─── 4. the increase survives the prune ───────────────────────────────────
section('a counter is folded reset-aware, because after the prune it cannot be')
{
  const c = await mkSeries('drive.counterTotal', 'counter')
  const OLD = hourOf(Date.now()) - 200 * HOUR
  // 0→100 over 30 minutes, restart, 0→40 over the next 30. Increase 140, last−first 40.
  const vals = [...Array(30).keys()].map(i => i * (100 / 29)).concat([...Array(30).keys()].map(i => i * (40 / 29)))
  for (let i = 0; i < 60; i++) await put(c.id, OLD + i * 60_000, vals[i])

  await foldNow()
  const h = await sys.metricHour.findFirst({ where: { seriesId: c.id, hour: OLD } })
  ok(h != null, 'the counter hour was folded')
  ok(Math.abs(h.increase - 140) < 1e-6, `increase is reset-aware: ${h?.increase?.toFixed(3)} ≈ 140`)
  ok(Math.abs((h.max - h.min) - 140) > 1, `max − min (${(h.max - h.min).toFixed(1)}) does NOT equal it — the stored figure is not recoverable from the other four`)
  ok(await sys.metricPoint.count({ where: { seriesId: c.id } }) === 0, 'and the raw is gone, so nothing could recompute it now')
}

// ─── 5. re-scraping, and the gate ─────────────────────────────────────────
// ─── a reading the APP measured, pushed rather than scraped ──────────────
//
// The scrape reads `/metrics`, which is everything the PROCESS knows about
// itself. Anything an app measures about something ELSE — a machine it manages,
// a queue it watches — arrives on that thing's own schedule, so it is pushed:
// `app.metrics.record()`.
//
// It goes through the plugin and not the tables, and that is the whole point of
// the method. `labelsKey` is `@unique` and IS the series' identity, so a caller
// building the key itself mints a second series under the same name — after
// which each holds half the readings and the graph has a step in it that
// nothing explains.
section('a reading the app pushed, and the label that makes it a different series')
{
  const box = 'srv-' + Math.random().toString(36).slice(2, 8)
  const at  = Date.now()

  await fakeApp.metrics.record('server.cpuPercent', 41, { labels: { serverId: box }, unit: 'percent', at })

  const key = seriesKey('server.cpuPercent', { serverId: box })
  const s   = await sys.metricSeries.findFirst({ where: { labelsKey: key } })
  ok(!!s, 'the reading minted a series under the canonical key')
  ok(s?.name === 'server.cpuPercent', '…whose NAME is the bare metric, so two servers share one name')
  ok(s?.labels?.serverId === box, '…and whose labels say which machine it is about')
  ok(s?.unit === 'percent', '…with the unit the caller stated')

  // The same minute, a new number. A point is keyed on (series, MINUTE), so
  // this must UPDATE — a heartbeat every thirty seconds otherwise doubles the
  // row count for a store designed around one point a minute.
  await fakeApp.metrics.record('server.cpuPercent', 55, { labels: { serverId: box }, at })
  const pts = await sys.metricPoint.findMany({ where: { seriesId: s.id } })
  ok(pts.length === 1, 'a second reading in the same minute updates the point rather than adding one')
  ok(pts[0]?.value === 55, '…and the later number is what is kept')

  // A second machine under the same NAME is a second series. Without the label
  // in the key it would be the same row, and one box would overwrite the other
  // every minute — two flat lines that are each half of the truth.
  const other = 'srv-' + Math.random().toString(36).slice(2, 8)
  await fakeApp.metrics.record('server.cpuPercent', 9, { labels: { serverId: other }, at })
  const both = await sys.metricSeries.findMany({ where: { name: 'server.cpuPercent' } })
  ok(both.length >= 2, 'two machines reporting one metric are two series, not one row they fight over')

  // A value that is not a number is refused rather than stored. `undefined`
  // reaching the column would be a reading of nothing, and NaN sorts and folds
  // as a number all the way to a chart.
  await fakeApp.metrics.record('server.cpuPercent', Number.NaN, { labels: { serverId: box }, at: at + 60_000 })
  ok((await sys.metricPoint.count({ where: { seriesId: s.id } })) === 1,
     'a reading that is not a number is not written')
}

section('a cron that fires twice, and who may write')
{
  const s = await mkSeries('drive.idempotent', 'gauge')
  const at = hourOf(Date.now()) - 3 * HOUR
  await put(s.id, at, 1); await put(s.id, at, 1); await put(s.id, at, 2)
  const n = await sys.metricPoint.count({ where: { seriesId: s.id } })
  ok(n === 1, `three writes to one minute leave one row, got ${n} — the composite key IS the idempotency`)
  const row = await sys.metricPoint.findFirst({ where: { seriesId: s.id, at } })
  ok(row.value === 2, 'and it holds the latest value, not the first')

  const again = await mkSeries('drive.idempotent', 'gauge')
  ok(again.id === s.id, 'a second sight of one name does not fork the series')

  let denied = false
  try { await db.metricSeries.create({ data: { name: 'x', labelsKey: 'x', type: 'gauge' } }) } catch { denied = true }
  ok(denied, 'a caller below the ladder cannot mint a series')
  let deniedPoint = false
  try { await db.metricPoint.create({ data: { seriesId: s.id, at: 1, value: 1 } }) } catch { deniedPoint = true }
  ok(deniedPoint, 'nor write a point — both halves are system-only, not just the series')
}

} finally {
  // The tenant is this drive's own and goes with it. Left behind it would be
  // read by the next `fli check`, the atlas and the jobs snapshot as a shop —
  // and the run after this one dies on `UNIQUE constraint failed: tenants.id`
  // before a single assertion, which is how this was found.
  //
  // THE REGISTRY KEYS ON `id`, NOT ON A SLUG. The first version of this block
  // deleted `WHERE slug = ?` — a column that does not exist — inside a bare
  // `catch {}`, so it threw, said nothing, and left the row every time. A
  // cleanup that cannot fail loudly is a cleanup that does not run.
  try {
    const { Database } = await import('bun:sqlite')
    const reg = new Database(new URL('../../db/shops-registry.db', import.meta.url).pathname)
    reg.run('DELETE FROM tenants WHERE id = ?', SHOP)
    reg.close()
  } catch (err) {
    console.error(`\n  cleanup FAILED — remove tenant "${SHOP}" by hand or the next run cannot start:\n  ${err.message}`)
  }
  spawnSync('sh', ['-c', `rm -f "${new URL('../../db/shops/', import.meta.url).pathname}${SHOP}".db*`])
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
