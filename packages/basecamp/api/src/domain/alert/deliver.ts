// src/domain/alert/deliver.ts — how a fired alert reaches people, and how an
// open one is closed when its rule stops existing.
//
// Two callers close an alert: the evaluator when the number recovers, and the
// rule's service when the rule is switched off or deleted. Without the second,
// a page opened by a rule that is then deactivated stays open on the pager for
// ever, because the evaluator reads active rules only and the cascade removes
// the rule's channel links with the rule (`FJS-3874`).

import { fanOutToChannels } from '../notification/delivery.ts'
import { notifyPeople, workspaceMembers } from '../notification/notify.ts'
import { describeBreach } from './alerting.ts'
import type { Message }     from '../notification/delivery.ts'
import type { App }         from '@frontierjs/junction'

/**
 * Deliver one event to every channel the rule is attached to.
 *
 * A rule with no channels reaches nobody, and that is a legitimate state — the
 * event is still written, and the alerts screen says the rule delivers nowhere.
 * What is not legitimate is silence about a channel that REFUSED, so a failure
 * is logged per channel and the pass continues: one dead Slack webhook must not
 * cost every rule after it in the same run.
 */
export async function fanOutAlert(
  app:   App,
  db:    any,
  rule:  any,
  event: any,
  msg:   Omit<Message, 'dedupKey'>,
): Promise<void> {
  const links = await db.alertRuleChannel.findMany({
    where:   { ruleId: rule.id },
    include: { channel: true },
  })

  await fanOutToChannels(
    app,
    () => db,
    links.map((l: any) => l.channel),
    // The EVENT's id, not the rule's: it is stable across the trigger and the
    // resolve, which is what lets PagerDuty close the incident it opened
    // instead of opening a second one. A rule id would collapse two separate
    // firings of the same rule into one incident.
    { ...msg, dedupKey: `basecamp:alert:${event.id}` },
    `alert-evaluate ${rule.name}`,
  )
}

/**
 * Resolve every firing event of a rule and tell its channels and members.
 *
 * Called BEFORE the rule is deleted, while its channel links still exist.
 * Each event is closed on its own so one refusing channel cannot leave the
 * rest of the rule's events open.
 */
export async function closeOpenAlerts(
  app:    App,
  rule:   any,
  reason: string,
  now:    number = Date.now(),
): Promise<number> {
  const db   = (app.db as any).asSystem()
  const open = await db.alert.findMany({ where: { ruleId: rule.id, status: 'firing' } })
  let closed = 0

  for (const event of open) {
    try {
      await db.alert.update({
        where: { id: event.id },
        data:  { status: 'resolved', resolvedAt: new Date(now).toISOString() },
      })
      closed++
      const text = `${describeBreach(rule.metricName, rule, event.valueAtTrigger)} — ${reason}`
      await notifyPeople(app, 'AlertResolved',
        await workspaceMembers(app, rule.workspaceId), {
          eventId: event.id, ruleName: rule.name, severity: rule.severity, message: text,
        })
      await fanOutAlert(app, db, rule, event, {
        title:    `[resolved] ${rule.name}`,
        text,
        severity: rule.severity,
        action:   'resolve',
      })
    } catch (err) {
      console.error(`[alerts] closing ${rule.name} (${event.id}): ${(err as Error).message}`)
    }
  }
  return closed
}
