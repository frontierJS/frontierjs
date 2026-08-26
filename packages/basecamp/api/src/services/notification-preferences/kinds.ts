// src/services/notification-preferences/kinds.ts
// What a person can be told about, what it means, and what happens when they
// have never said.
//
// ─── Why there is a table here at all ─────────────────────────────────────
//
// `NotificationPreference` holds a row only where somebody has CHOSEN. That is
// deliberate — the alternative, writing seven rows for every account at signup,
// makes the meaning of a missing row ambiguous the first time a kind is added.
// The cost is that *no row* has to resolve to something, and the something is
// here: a default per kind, which is what the delivery path reads when it finds
// no row.
//
// The kinds are a COPY of the `NotificationKind` enum in db/schema.lite, which
// is where the column gets its CHECK. A copy on purpose, for `hub.service.ts`'s
// reason: a caller sending an unknown kind must get a sentence naming what is
// allowed, not a SQLite constraint message from three layers down. What keeps
// the two in step is `db/test/schema.test.ts`, which imports this and asserts
// the two lists match in both directions.

export interface NotificationKindDef {
  /** The enum value — the column's own word. */
  kind:        string
  label:       string
  description: string
  /** What a person who has never opened the screen gets. */
  email:       boolean
  inApp:       boolean
}

/**
 * The defaults, and each one is a judgement rather than a shrug.
 *
 * The rule they follow: **in-app is cheap and email is an interruption**, so a
 * kind is emailed only where not knowing costs something — a failure, or
 * somebody joining who can now see the fleet. A success is in-app only.
 */
export const NOTIFICATION_KINDS: NotificationKindDef[] = [
  { kind: 'deploy_success', label: 'Deploy succeeded',
    description: 'A deployment reached its last step.',
    email: false, inApp: true },

  { kind: 'deploy_failed',  label: 'Deploy failed',
    description: 'A deployment stopped at a step that failed.',
    email: true,  inApp: true },

  { kind: 'alert_firing',   label: 'Alert firing',
    description: 'An alert rule crossed its threshold.',
    email: true,  inApp: true },

  { kind: 'alert_resolved', label: 'Alert resolved',
    description: 'A firing alert came back inside its threshold.',
    email: false, inApp: true },

  { kind: 'member_joined',  label: 'Member joined',
    description: 'Somebody accepted an invitation to a workspace you are in.',
    email: true,  inApp: false },

  { kind: 'job_failed',     label: 'Job failed',
    description: 'A scheduled or triggered job ended in failure.',
    email: true,  inApp: true },

  { kind: 'weekly_digest',  label: 'Weekly digest',
    description: 'A summary of the week — deploys, alerts and spend.',
    email: true,  inApp: false },
]

/** The enum's words, for validating what a caller sent. */
export const NOTIFICATION_KIND_NAMES = NOTIFICATION_KINDS.map(k => k.kind)

const BY_KIND = new Map(NOTIFICATION_KINDS.map(k => [k.kind, k]))

export function notificationKind(kind: string): NotificationKindDef | undefined {
  return BY_KIND.get(kind)
}
