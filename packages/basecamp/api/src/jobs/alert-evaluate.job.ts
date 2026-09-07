// src/jobs/alert-evaluate.job.ts — the thing between a rule and an event.
//
// `AlertRule` declared a metric and a threshold, `NotificationChannel` really
// delivered, and `AlertRuleChannel` joined them. Nothing read the first,
// compared it, or reached the second — `AlertEvent` was a table written by
// nobody (`FJS-123`). This is that reader.
//
// It was not blocked on effort. A rule reading *above 80% for five minutes* has
// no window to read until something keeps a second reading, which is what
// `metricsPlugin` now does (`FJS-956`): `MetricSeries` × `MetricPoint`, minted
// by the scrape and kept at minute resolution for 48 hours. This job reads that
// tier and nothing else — the hourly fold is for charts, and an alert asking
// about the last five minutes cannot be answered by a row covering an hour.
//
// ─── The three answers that are not "the number is fine" ─────────────────
//
// A missed alert is the failure this chain exists to prevent, and every way of
// missing one looks like quiet from a dashboard. So the pass distinguishes:
//
//   no-data     nothing in the window. NOT a resolve — a scrape that stopped
//               and a value that came back inside its threshold draw the same
//               flat line, and closing an incident because the exporter died
//               is the single worst thing this file could do.
//   uncovered   breaching, but the streak is shorter than `forMinutes`. The
//               normal state of a rule that is about to fire.
//   recovered   a reading inside the threshold. The ONLY thing that resolves.
//
// ─── Two deliveries, and they are not the same thing ─────────────────────
//
// A fired event goes out TWICE, to two different addressees.
//
//   The rule's `NotificationChannel`s — Slack, PagerDuty, a webhook. This is
//   where the WORKSPACE is paged, it is configured per rule, and nobody can opt
//   out of it individually: that is what a pager is.
//
//   Every member, as a `Notification` — `alert_firing` / `alert_resolved`, two
//   of the seven kinds `NotificationPreference` lets one PERSON switch off for
//   themselves.
//
// Collapsing them would mean either a pager somebody can silence for everyone,
// or a bell menu nobody can turn down (`FJS-967`).

import { defineJob }        from '@frontierjs/caravan'
import { isStale }          from '@frontierjs/junction'
import { runsAsApp }        from './context.ts'
import { evaluateWindow, describeBreach } from '../core/alerting.ts'
import { deliverToChannel } from '../core/delivery.ts'
import { notifyPeople, workspaceMembers } from '../core/notify.ts'
import type { Message }     from '../core/delivery.ts'
import type { BasecampApp } from '../basecamp.types.ts'

/** How far back a rule with no duration still looks. A `forMinutes: 0` rule is
 *  about the newest reading, but "newest" has to be bounded or a series whose
 *  exporter died a week ago fires on the last number it ever wrote. Ten minutes
 *  is ten scrapes at the plugin's own interval. */
const MIN_WINDOW_MS = 10 * 60_000

/** What the last pass reported, so a steady state is silent. This job runs
 *  every minute: warning about the same broken rule 1,440 times a day is how a
 *  log stops being read, and *the set changed* is the only event an operator
 *  can act on. Module state rather than a row — it is a de-duplication of
 *  console output, and persisting it would make it a fact about the fleet. */
let lastReported = ''

/** Grace on top of `forMinutes`, so the window holds the point BEFORE the
 *  streak started as well as the streak. Without it a rule can never be
 *  covered: the oldest point read is the first breaching one, and the span
 *  from it is always a scrape short of the duration. */
const WINDOW_GRACE_MS = 2 * 60_000

export default defineJob(
  'alert-evaluate',
  async (ctx) => {
    const { app, db } = runsAsApp(ctx, 'alert-evaluate')
    const now  = Date.now()

    // Every workspace's rules in one pass. `asSystem()` is what crosses them —
    // the row tenancy this app declares scopes to one workspace, and a cron has
    // none. What that costs is stated rather than assumed: nothing below reads
    // a rule's workspace to decide anything, because a rule already carries
    // everything the evaluation needs.
    const rules = await db.alertRule.findMany({ where: { isActive: true } })

    let fired = 0, resolved = 0
    const missing: string[] = []
    const stale:   string[] = []

    for (const rule of rules) {
      // A series is MINTED by the first scrape that sees it, so a rule
      // legitimately names one that does not exist yet. What it must not do is
      // be silent about it: a rule watching a metric nobody writes can never
      // fire, and looks exactly like a rule whose threshold is never crossed.
      const series = await db.metricSeries.findFirst({ where: { labelsKey: rule.metricName } })
      if (!series) { missing.push(`${rule.name} → ${rule.metricName}`); continue }
      if (isStale(series.lastSeenAt, now)) stale.push(`${rule.name} → ${rule.metricName}`)

      const windowMs = Math.max(rule.forMinutes * 60_000 + WINDOW_GRACE_MS, MIN_WINDOW_MS)
      const points   = await db.metricPoint.findMany({
        where:   { seriesId: series.id, at: { gte: now - windowMs } },
        orderBy: { at: 'asc' },
      })

      const verdict = evaluateWindow(points, rule)
      // The newest event that is still open. Ordered, because a rule that fired
      // twice before anything resolved it would otherwise be closed in the
      // order sqlite happened to return.
      const open = await db.alertEvent.findFirst({
        where:   { ruleId: rule.id, status: 'firing' },
        orderBy: { firedAt: 'desc' },
      })

      if (verdict.breached && !open) {
        const message = describeBreach(rule.metricName, rule, verdict.value)
        const event   = await db.alertEvent.create({
          data: {
            ruleId:         rule.id,
            status:         'firing',
            severity:       rule.severity,
            // A metric series is neither a server nor a volume. Calling it one
            // would page whoever owns the machine for a number about this
            // process — which is why `AlertSubject` gained a third value rather
            // than the nearest one being borrowed.
            subjectType:    'series',
            subjectId:      series.id,
            valueAtTrigger: verdict.value,
            message,
            firedAt:        new Date(now).toISOString(),
          },
        })
        fired++
        await notifyPeople(app, 'alert_firing',
          await workspaceMembers(app, rule.workspaceId), {
            eventId: event.id, ruleName: rule.name, severity: rule.severity, message,
          })
        await fanOut(app, db, rule, event, {
          title:    `[${rule.severity}] ${rule.name}`,
          text:     message,
          severity: rule.severity,
          action:   'trigger',
        })

      } else if (open && verdict.reason === 'recovered') {
        await db.alertEvent.update({
          where: { id: open.id },
          data:  { status: 'resolved', resolvedAt: new Date(now).toISOString() },
        })
        resolved++
        const recovered = describeBreach(rule.metricName, rule, verdict.value)
        await notifyPeople(app, 'alert_resolved',
          await workspaceMembers(app, rule.workspaceId), {
            eventId: open.id, ruleName: rule.name, severity: rule.severity, message: recovered,
          })
        await fanOut(app, db, rule, open, {
          title:    `[resolved] ${rule.name}`,
          text:     recovered,
          severity: rule.severity,
          action:   'resolve',
        })
      }
    }

    // A pass that changed nothing is silent, and so is a pass that reports the
    // same broken rules as the one before it. Each of these is a rule that
    // CANNOT fire — the state an alerting system has no other way of telling
    // anybody about, and the alerts screen says it per rule; this is the
    // operator's copy, so it fires when the SET moves.
    const report = JSON.stringify([missing, stale])
    if (report !== lastReported) {
      lastReported = report
      if (missing.length)
        console.warn(`[alert-evaluate] ${missing.length} rule(s) name a series nothing has written: ${missing.join(', ')}`)
      if (stale.length)
        console.warn(`[alert-evaluate] ${stale.length} rule(s) watch a series nothing is writing any more: ${stale.join(', ')}`)
    }
    if (fired || resolved)
      console.log(`[alert-evaluate] ${fired} fired, ${resolved} resolved, over ${rules.length} active rule(s)`)
  },
  // Every minute — the scrape's own interval. A slower evaluator would add its
  // period to every rule's `forMinutes` without saying so.
  { cron: '* * * * *' },
)

/**
 * Deliver one event to every channel the rule is attached to.
 *
 * A rule with no channels reaches nobody, and that is a legitimate state — the
 * event is still written, and the alerts screen says the rule delivers nowhere.
 * What is not legitimate is silence about a channel that REFUSED, so a failure
 * is logged per channel and the pass continues: one dead Slack webhook must not
 * cost every rule after it in the same run.
 */
async function fanOut(
  app:   BasecampApp,
  db:    any,
  rule:  any,
  event: any,
  msg:   Omit<Message, 'dedupKey'>,
): Promise<void> {
  const links = await db.alertRuleChannel.findMany({
    where:   { ruleId: rule.id },
    include: { channel: true },
  })

  for (const link of links) {
    const channel = link.channel
    // `deletedAt` is checked by hand because this read is `asSystem()`, which
    // bypasses `@@softDelete` along with everything else — a retired channel
    // would otherwise still be paged through, and the join row survives it.
    if (!channel || channel.isActive === false || channel.deletedAt) continue

    const res = await deliverToChannel(
      { conduit: app.conduit as never, sys: () => db },
      channel,
      // The EVENT's id, not the rule's: it is stable across the trigger and the
      // resolve, which is what lets PagerDuty close the incident it opened
      // instead of opening a second one. A rule id would collapse two separate
      // firings of the same rule into one incident.
      { ...msg, dedupKey: `basecamp:alert:${event.id}` },
    )

    if (!res.ok) {
      console.error(`[alert-evaluate] ${rule.name} → channel '${channel.name}': ${res.error}`)
      continue
    }
    // The stamp means something arrived, which is the only reason it is written
    // after the send rather than beside it.
    await db.notificationChannel.update({
      where: { id: channel.id },
      data:  { lastDeliveryAt: new Date().toISOString(), version: channel.version },
    })
  }
}
