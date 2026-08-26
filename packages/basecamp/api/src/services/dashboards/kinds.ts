// src/services/dashboards/kinds.ts
// The widget vocabulary — what each kind of widget needs to be placed.
//
// `enum WidgetKind` in db/schema.lite is the seed: it gives the column its
// CHECK constraint and reaches the browser as a `$def`, so a picker cannot
// offer a kind the column would refuse. What the schema cannot say is that
// `app_status` is meaningless without an App and `server_fleet` takes no
// subject at all — that rule lives here, once, and both the service and the
// Add-widget screen read it from this file rather than restating it.
//
// db/test/schema.test.ts holds the two together in both directions: every enum
// member has an entry here, and every entry names a member. A kind added to
// the schema with no entry would be placeable and unconfigurable; an entry with
// no enum member would be offered by the picker and refused by the column.
//
// `needs` is the sentence the card prints when the data behind it is thin. It
// is not a disabled state — every kind here reads something real — it is the
// difference between what the mock draws and what this app can actually
// answer, said on the card instead of drawn as a plausible line.

/** Which model a widget's subject points at. `null` = the whole workspace. */
export type WidgetSubject = 'server' | 'app' | null

export interface WidgetKindSpec {
  /** Matches a member of `enum WidgetKind`. */
  kind:        string
  label:       string
  description: string
  subject:     WidgetSubject
  /** A subject the widget cannot be placed without. `deploy_feed` reads the
   *  whole workspace when no app is named, so its subject is optional. */
  required:    boolean
  /** Config keys this kind accepts. Anything else is refused at the boundary —
   *  `config` is knobs, and a key nothing reads is a key that looks like it
   *  works. */
  config:      string[]
  /** Thirds of a row this kind wants by default. */
  cols:        number
  /** What the card cannot show, and why. Empty when there is nothing to say. */
  needs:       string
}

/**
 * The sources `stat_counter` may count.
 *
 * Each names a service this app already mounts, and the count is that
 * service's own `total` — so the number is whatever the caller may see, and a
 * viewer who cannot read servers gets a refusal rather than a fleet size.
 * Declared rather than free-form for the same reason the kinds are: a counter
 * carrying `{ where: … }` is a stored query wearing a smaller hat.
 */
export const STAT_SOURCES = ['servers', 'apps', 'deployments', 'jobs', 'volumes', 'alerts'] as const

export const WIDGET_KINDS: WidgetKindSpec[] = [
  {
    kind:        'server_fleet',
    label:       'Server fleet',
    description: 'Every server in the workspace with its status.',
    subject:     null,
    required:    false,
    config:      [],
    cols:        3,
    needs:       '',
  },
  {
    kind:        'server_health',
    label:       'Server health',
    description: 'CPU, memory and disk for one server, as its outpost last reported them.',
    subject:     'server',
    required:    true,
    config:      [],
    cols:        1,
    // The heartbeat writes `Server.health` as a snapshot, so the bars are real
    // and the mock's sparkline is not: there is nowhere a second reading is
    // kept.
    needs:       'a metric store — this is the last reading, not a trend',
  },
  {
    kind:        'app_status',
    label:       'App status',
    description: 'One app — status, environment and its last release.',
    subject:     'app',
    required:    true,
    config:      [],
    cols:        1,
    needs:       '',
  },
  {
    kind:        'deploy_feed',
    label:       'Deploy feed',
    description: 'Recent deployments, for one app or the whole workspace.',
    // The mock filters by PROJECT. A deployment belongs to an app and carries
    // no project id, so scoping one to a project would be a join this read does
    // not do — the subject is the app, which is the filter that exists.
    subject:     'app',
    required:    false,
    config:      [],
    cols:        2,
    needs:       '',
  },
  {
    kind:        'job_history',
    label:       'Job history',
    description: 'Scheduled and one-shot jobs with their last outcome.',
    subject:     null,
    required:    false,
    config:      [],
    cols:        2,
    needs:       '',
  },
  {
    kind:        'activity_feed',
    label:       'Activity feed',
    description: 'The workspace audit trail, most recent first.',
    subject:     null,
    required:    false,
    config:      [],
    cols:        1,
    needs:       '',
  },
  {
    kind:        'alert_status',
    label:       'Alert rules',
    description: 'Alert rules and whether anything has fired against them.',
    subject:     null,
    required:    false,
    config:      [],
    cols:        1,
    needs:       'an evaluator — nothing measures a threshold yet (FJS-123)',
  },
  {
    kind:        'service_health',
    label:       'Service health',
    description: 'One shared provider, pinged live.',
    subject:     null,
    required:    false,
    // Not a relation: a portal entry is an adapter this app configures, not a
    // row. The id is validated against the portal registry all the same.
    config:      ['serviceId'],
    cols:        1,
    needs:       'latency history — the ping answers now, and nothing keeps it',
  },
  {
    kind:        'stat_counter',
    label:       'Counter',
    description: 'A single number — how many of one thing this workspace has.',
    subject:     null,
    required:    false,
    // `label` is the caller's own wording for the number. `source` decides what
    // is counted and is a member of STAT_SOURCES, never a query.
    config:      ['source', 'label'],
    cols:        1,
    needs:       '',
  },
]

export const WIDGET_KIND_BY_NAME: Record<string, WidgetKindSpec> =
  Object.fromEntries(WIDGET_KINDS.map(k => [k.kind, k]))
