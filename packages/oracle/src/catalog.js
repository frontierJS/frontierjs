// ─── catalog.js — the canonical entities, stated once ─────────────────────────
//
// Lifted from `mockup/oracle.jsx`, where the same collapses were stated twice:
// once as data and again in ~1,300 lines of prompt text, and the two drifted.
// Here they are data only. `brief.js` renders this file for a model and
// `emit.js` reads it for a schema, so a third statement has nowhere to live.
//
// What changed in the lift, because an emitter needs it and prose did not:
//
// FIELDS ARE TYPED. The mockup's `props` were bare names (`total`, `dueAt`), a
// list a person reads. An emitter needs a type, whether the column is
// required, and who writes it, so each field is one line of the spec read by
// `field()` below.
//
// LIFECYCLES NAME THEIR MOVES. The mockup's transitions carried a trigger
// sentence (`crew marks done`). A move in `@@transitions` is called by name, so
// each edge has one, and the spec reads the way `.lite` does.
//
// LINKS ARE ADVICE, NOT OUTPUT. A catalog entry says what it usually points at
// (`Task.assignee -> User`, performer). The emitter never adds a link the
// answer did not declare: whether this app's Task has an assignee is the
// answer's to say, and absence implies nothing.
//
// `User` and `Notification` are in the catalog and RESERVED: every app the
// scaffold writes already declares both, so an answer names people through
// actors and a link to User, and never declares either again.
//
// Zero dependencies, plain ESM.

// ─── field spec ───────────────────────────────────────────────────────────────
//
//   '<name> <type>[!] [unique] [system] [=default]'
//   'priority enum(low,normal,high,urgent) =normal'
//
// `!` is required. `system` is a column the application writes and the caller
// does not (`@system`). The types are `TYPES` in emit.js; `checkAnswer` refuses
// any other word.

/** @typedef {{ name: string, type: string, required?: boolean, unique?: boolean, system?: boolean, values?: string[], default?: string|number|boolean, why?: string }} Field */

const FIELD = /^(\w+)\s+(\w+)(?:\(([^)]*)\))?(!)?((?:\s+(?:unique|system|=\S+))*)\s*$/

/** @param {string} spec @returns {Field} */
export function field(spec) {
  const m = FIELD.exec(spec)
  if (!m) throw new Error(`catalog: unreadable field spec '${spec}'`)
  const [, name, type, args, bang, flags] = m
  /** @type {Field} */
  const f = { name, type }
  if (args) f.values = args.split(',').map(s => s.trim())
  if (bang) f.required = true
  for (const flag of flags.trim().split(/\s+/).filter(Boolean)) {
    if (flag === 'unique') f.unique = true
    else if (flag === 'system') f.system = true
    else {
      const raw = flag.slice(1)
      f.default = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw
    }
  }
  return f
}

// ─── lifecycle spec ───────────────────────────────────────────────────────────
//
//   'submit: draft -> submitted; reject: [submitted, under_review] -> rejected system'
//
// The first state named is the one a row is created at. `system` marks a move
// the application makes rather than a person (`@system` on the move).

/** @typedef {{ name: string, from: string[], to: string, by?: 'system' }} Move */
/** @typedef {{ field: string, states: string[], initial: string, moves: Move[] }} Lifecycle */

const MOVE = /^\s*(\w+)\s*:\s*(\[[^\]]*\]|\w+)\s*->\s*(\w+)(\s+system)?\s*$/

/** @param {string} spec @param {string} [fieldName] @returns {Lifecycle} */
export function lifecycle(spec, fieldName = 'status') {
  /** @type {Move[]} */
  const moves = []
  const states = []
  const see = (s) => { if (!states.includes(s)) states.push(s) }
  for (const part of spec.split(';')) {
    const m = MOVE.exec(part)
    if (!m) throw new Error(`catalog: unreadable move '${part.trim()}'`)
    const [, name, fromRaw, to, sys] = m
    const from = fromRaw.startsWith('[') ? fromRaw.slice(1, -1).split(',').map(s => s.trim()) : [fromRaw]
    from.forEach(see)
    see(to)
    moves.push({ name, from, to, ...(sys ? { by: 'system' } : {}) })
  }
  return { field: fieldName, states, initial: states[0], moves }
}

// ─── actors ───────────────────────────────────────────────────────────────────
//
// An actor is how a person reaches a row, and `may` is what the reach grants.
// This table IS the access derivation: a link to User marked `owner` emits a
// read, create, update and delete policy on that column, and one marked
// `observer` emits a read. A gate is per model and never per row, so a row a
// person may touch is always named by one of these, a parent it inherits from,
// or a membership — `checkAnswer` refuses an entity with none.

export const ACTORS = {
  owner:       { desc: 'who is accountable for it',                  may: ['read', 'create', 'update', 'delete'] },
  author:      { desc: 'who created or originated it',               may: ['read', 'create', 'update', 'delete'] },
  coordinator: { desc: 'who arranges or assigns it',                 may: ['read', 'create', 'update'] },
  performer:   { desc: 'who does the work',                          may: ['read', 'update'] },
  subject:     { desc: 'who the thing exists for',                   may: ['read'] },
  observer:    { desc: 'who watches without acting',                 may: ['read'] },
  system:      { desc: 'a non-human actor: a schedule, an integration, the application itself', may: [] },
}

// ─── categories ───────────────────────────────────────────────────────────────

export const CATEGORIES = {
  identity_access:    { tier: 'core',   name: 'Identity & access',     desc: 'Actors with system access and the containers they belong to' },
  capture:            { tier: 'core',   name: 'Capture',               desc: 'Captured records — structured intake, freeform annotation, and people-as-data' },
  communication:      { tier: 'core',   name: 'Communication',         desc: 'How messages move between system and people, person-to-person, and via registered routing' },
  integration:        { tier: 'core',   name: 'Integration',           desc: 'External system connections — outbound config and inbound payloads' },
  read_surfaces:      { tier: 'core',   name: 'Read surfaces',         desc: 'Aggregated, live, and projected read-only outputs' },
  operations:         { tier: 'core',   name: 'Operations',            desc: 'Temporal machinery — what can fire (Action), what fired (Event), how stages progress (Flow)' },
  meta:               { tier: 'core',   name: 'Meta',                  desc: 'Reusable scaffolds and orthogonal classifiers that apply across the catalog' },
  service_scheduling: { tier: 'domain', name: 'Service & scheduling',  desc: 'Service-business primitives — bookable time, places, work, owned equipment' },
  commerce_value:     { tier: 'domain', name: 'Commerce & value',      desc: 'Transactional primitives — offers, artifacts, value transfer' },
  content_public:     { tier: 'domain', name: 'Content & public',      desc: 'Anything addressable on the open web' },
}

// ─── entities ─────────────────────────────────────────────────────────────────

/**
 * @typedef {{ name: string, to: string, actor?: string, required?: boolean, why?: string }} Link
 * @typedef {{
 *   name: string, category: string, desc: string, rules: string[],
 *   kinds?: string[], fields: Field[], links: Link[],
 *   lifecycle?: Lifecycle, lifecycles?: Record<string, Lifecycle>,
 *   reserved?: string,
 * }} Entity
 */

const F = (...specs) => specs.map(field)

/** @type {Entity[]} */
export const ENTITIES = [
  // ── capture ──
  {
    name: 'Form', category: 'capture',
    desc: 'A structured input template defining what to collect',
    rules: ['Must have at least one field', 'Owner controls visibility'],
    fields: F('title text!', 'description longtext', 'questions json!', 'isPublished bool =false'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },
  {
    name: 'Submission', category: 'capture',
    desc: 'An instance of a Form filled out at a specific time',
    rules: ['Cannot be edited after submission', 'Validated against Form schema'],
    fields: F('answers json!', 'submittedAt datetime system'),
    links: [
      { name: 'form', to: 'Form', required: true },
      { name: 'submitter', to: 'User', actor: 'author' },
    ],
    lifecycle: lifecycle('submit: draft -> submitted; pickUp: submitted -> under_review; approve: under_review -> approved; reject: under_review -> rejected'),
  },
  {
    name: 'Note', category: 'capture',
    desc: 'Free-form captured text, often informal. It annotates one thing, and the link to that thing is declared, never a polymorphic pair',
    rules: ['Author can edit, others read-only'],
    fields: F('body longtext!'),
    links: [{ name: 'author', to: 'User', actor: 'author', required: true }],
  },
  {
    name: 'Contact', category: 'capture', kinds: ['customer', 'lead', 'prospect'],
    desc: 'A descriptive record of a person — captured for CRM, communication, or transaction, with no access to the system itself. A person who signs in is a User; a person the app keeps a record about is a Contact',
    rules: ['No authenticated access by default', 'May be linked to a User if they later sign up'],
    fields: F('name text!', 'email email', 'phone phone', 'source text', 'tags tags'),
    links: [
      { name: 'owner', to: 'User', actor: 'owner', required: true, why: 'whose book of business the record is in' },
      { name: 'organization', to: 'Organization' },
    ],
    lifecycle: lifecycle('qualify: fresh -> qualified; activate: qualified -> active; lapse: active -> inactive system; churn: [active, inactive] -> churned; block: [fresh, qualified, active, inactive] -> blocked'),
  },

  // ── commerce & value ──
  {
    name: 'Document', category: 'commerce_value', kinds: ['estimate', 'quote', 'invoice', 'order', 'contract', 'receipt', 'nda'],
    desc: 'A formal artifact capturing terms, agreements, or transactional state — proposals, demands, contracts, receipts. The kind determines its lifecycle; an invoice and a quote are both Documents',
    rules: [
      'The kind determines lifecycle and binding semantics',
      'Cannot be modified after reaching a binding state (accepted, paid, executed)',
      'Contains line items — Offers chosen, or inline charges (fees, taxes, discounts) with no entity behind them',
      'Multi-party Documents (contracts) require all parties to reach the binding state',
    ],
    fields: F('number text unique system', 'title text', 'total money system =0', 'issuedAt datetime system', 'validUntil date', 'dueAt date', 'file file'),
    links: [
      { name: 'recipient', to: 'Contact', actor: 'subject', why: 'who the document is addressed to' },
      { name: 'author', to: 'User', actor: 'author', required: true },
    ],
    lifecycles: {
      quote:    lifecycle('send: draft -> sent; view: sent -> viewed system; accept: [sent, viewed] -> accepted; decline: [sent, viewed] -> declined; expire: [sent, viewed] -> expired system'),
      estimate: lifecycle('send: draft -> sent; view: sent -> viewed system; accept: [sent, viewed] -> accepted; decline: [sent, viewed] -> declined; expire: [sent, viewed] -> expired system'),
      invoice:  lifecycle('send: draft -> sent; pay: [sent, overdue] -> paid; lapse: sent -> overdue system; escalate: overdue -> in_collections; refund: paid -> refunded'),
      contract: lifecycle('send: draft -> sent; view: sent -> viewed system; execute: [sent, viewed] -> executed; decline: [sent, viewed] -> declined; terminate: executed -> terminated'),
      order:    lifecycle('place: draft -> placed; fulfill: placed -> fulfilled; cancel: [draft, placed] -> cancelled'),
    },
  },
  {
    name: 'Offer', category: 'commerce_value',
    desc: 'What is sold to a customer — a service, product, or package they CHOOSE. Imposed charges (cancellation fees, late fees, taxes, discounts) are not Offers: they are inline line items on a Document',
    rules: ['Pricing mode determines required fields', 'Packages compose child offers via a parent link'],
    fields: F('name text!', 'description longtext', 'price money', 'unit text', 'mode enum(flat,hourly,per_unit) =flat', 'isActive bool =true'),
    links: [
      { name: 'owner', to: 'User', actor: 'owner', required: true },
      { name: 'parent', to: 'Offer', why: 'the package this offer is part of' },
    ],
  },
  {
    name: 'Payment', category: 'commerce_value',
    desc: 'A transfer of value with a timestamp',
    rules: ['Irreversible without explicit refund', 'Auditable always'],
    fields: F('amount money!', 'method enum(card,bank_transfer,cash,other) =card', 'paidAt datetime system', 'externalRef text system'),
    links: [
      { name: 'document', to: 'Document', why: 'what it settles' },
      { name: 'payer', to: 'Contact', actor: 'subject' },
    ],
    lifecycle: lifecycle('process: initiated -> processing system; succeed: processing -> succeeded system; fail: processing -> failed system; refund: succeeded -> refunded; dispute: succeeded -> disputed system'),
  },

  // ── service & scheduling ──
  {
    name: 'Schedule', category: 'service_scheduling',
    desc: 'A plan describing when things happen, often recurring. It generates Visits or Tasks; it is not one',
    rules: ['Cannot overlap conflicting resources', 'Owner can modify'],
    fields: F('rule text!', 'startsOn date!', 'endsOn date', 'timezone text'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },
  {
    name: 'Visit', category: 'service_scheduling',
    desc: 'A bounded interaction period with a status — an appointment, a booking, a shift, a session. Time-and-place bounded, where a Task is outcome-bounded',
    rules: ['Cannot be scheduled in the past', 'Must have at least one Performer', 'Only Coordinator can reassign'],
    fields: F('scheduledAt datetime!', 'durationMinutes count', 'notes longtext'),
    links: [
      { name: 'performer', to: 'User', actor: 'performer' },
      { name: 'coordinator', to: 'User', actor: 'coordinator' },
      { name: 'customer', to: 'Contact', actor: 'subject' },
      { name: 'location', to: 'Location' },
      { name: 'resource', to: 'Resource' },
    ],
    lifecycle: lifecycle('confirm: scheduled -> confirmed; start: confirmed -> in_progress; complete: in_progress -> complete; cancel: [scheduled, confirmed] -> cancelled; markNoShow: confirmed -> no_show'),
  },
  {
    name: 'Task', category: 'service_scheduling',
    desc: 'A discrete unit of work assigned to a performer — outcome-bounded (done by X), where a Visit is time-and-place bounded. Not a cron or queue job: those are the recurring pattern acting on Events',
    rules: ['Must have an assignee', 'Status follows defined transitions', 'Outcome-bounded by dueAt, not a time slot'],
    fields: F('title text!', 'description longtext', 'priority enum(low,normal,high,urgent) =normal', 'dueAt datetime'),
    links: [
      { name: 'assignee', to: 'User', actor: 'performer' },
      { name: 'coordinator', to: 'User', actor: 'coordinator' },
    ],
    lifecycle: lifecycle('assign: backlog -> assigned; accept: assigned -> accepted; decline: assigned -> backlog; start: accepted -> in_progress; complete: in_progress -> completed; cancel: [backlog, assigned, accepted, in_progress] -> cancelled'),
  },
  {
    name: 'Resource', category: 'service_scheduling',
    desc: 'A bookable or assignable thing with capacity — a room, a vehicle, a seat, a machine',
    rules: ['Capacity is finite', 'Conflicts must be detected'],
    fields: F('name text!', 'type text', 'capacity count =1'),
    links: [{ name: 'location', to: 'Location' }],
  },
  {
    name: 'Location', category: 'service_scheduling',
    desc: 'A place where things happen',
    rules: ['Geocoded for mapping'],
    fields: F('name text!', 'address longtext', 'lat number', 'lng number', 'timezone text'),
    links: [],
  },
  {
    name: 'Asset', category: 'service_scheduling',
    desc: 'An owned or tracked item with provenance and lifecycle — equipment, vehicles, inventory, digital files. Distinct from Resource by ownership and tracking over coordination',
    rules: ['Has an owner', 'Tracked over time with audit history', 'May also be a Resource if bookable'],
    fields: F('name text!', 'type text', 'serialNumber text unique', 'acquiredOn date', 'value money', 'condition enum(new,good,fair,poor) =good'),
    links: [
      { name: 'owner', to: 'User', actor: 'owner', required: true },
      { name: 'location', to: 'Location' },
    ],
    lifecycle: lifecycle('deploy: acquired -> in_service; service: in_service -> maintenance; restore: maintenance -> in_service; retire: in_service -> retired; dispose: [acquired, in_service, maintenance, retired] -> disposed'),
  },

  // ── communication ──
  {
    name: 'Message', category: 'communication',
    desc: 'A single piece of communication, point-to-point or broadcast. A conversation is a chain of Messages through a parent link, not a separate entity',
    rules: ['Has a sender and recipient(s)', 'Channel-specific format', 'Threading is a parent link; no Thread entity'],
    fields: F('subject text', 'body longtext!', 'channel enum(in_app,email,sms) =in_app', 'sentAt datetime system'),
    links: [
      { name: 'sender', to: 'User', actor: 'author', required: true },
      { name: 'recipient', to: 'User', actor: 'subject' },
      { name: 'parent', to: 'Message', why: 'the message this one replies to' },
    ],
  },
  {
    name: 'Notification', category: 'communication', reserved: 'the scaffold declares Notification in every app — what the app tells a person is sent through it, never declared again',
    desc: 'A system-generated alert or update to a recipient',
    rules: ['Has a recipient', 'Generated by an Event, not a human'],
    fields: [], links: [],
  },
  {
    name: 'Listener', category: 'communication',
    desc: 'A registered interest in a topic or event stream — the durable record routing future events to a recipient or an endpoint. A subscription',
    rules: ['Can be deactivated (unsubscribed)', 'Active state required for delivery', 'Endpoint or actor required'],
    fields: F('topic text!', 'endpoint url', 'isActive bool =true'),
    links: [{ name: 'subscriber', to: 'User', actor: 'owner' }],
  },

  // ── read surfaces ──
  {
    name: 'Report', category: 'read_surfaces',
    desc: 'A generated snapshot of data for human consumption',
    rules: ['Reflects data at time of generation', 'May be parameterized'],
    fields: F('title text!', 'parameters json', 'body json system', 'generatedAt datetime system'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },
  {
    name: 'Dashboard', category: 'read_surfaces',
    desc: 'A live aggregated view for decision-making. Its numbers are read from other rows; the row holds the layout',
    rules: ['Updates on refresh or schedule'],
    fields: F('name text!', 'widgets json!', 'filters json', 'refreshSeconds count'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },
  {
    name: 'View', category: 'read_surfaces',
    desc: 'A persisted way of looking at a slice of data — a saved filter',
    rules: ['Scoped by owner permissions'],
    fields: F('name text!', 'filter json', 'sort json', 'columns json'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },

  // ── integration ──
  {
    name: 'Webhook', category: 'integration',
    desc: 'An inbound payload from another system, kept so it can be processed and replayed',
    rules: ['Source must be authenticated', 'Idempotency expected'],
    fields: F('source text!', 'deliveryId text unique', 'payload json!', 'receivedAt datetime system'),
    links: [{ name: 'integration', to: 'Integration' }],
  },
  {
    name: 'Integration', category: 'integration',
    desc: 'A bridge between two systems — owns auth, field mappings, and sync cadence',
    rules: ['Auth credentials are scoped', 'Failure modes must be observable', 'Field mappings versioned with the integration'],
    fields: F('name text!', 'system text!', 'credentials secret', 'fieldMappings json', 'cadence text', 'lastRunAt datetime system'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
    lifecycle: lifecycle('pause: active -> paused; resume: paused -> active; fail: active -> failing system; recover: failing -> active'),
  },

  // ── identity & access ──
  {
    name: 'User', category: 'identity_access', reserved: 'the scaffold declares User in every app — a person who signs in is reached through an actor and a link to User',
    desc: 'A human (or service account) granted authenticated access',
    rules: ['Unique email'], fields: [], links: [],
  },
  {
    name: 'Organization', category: 'identity_access',
    desc: 'A multi-person container or tenant — a workspace, a company, an account. Its people are a membership entity linking it to User',
    rules: ['Has at least one Owner', 'Settings cascade to members'],
    fields: F('name text!', 'planTier text'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },
  {
    name: 'Role', category: 'identity_access',
    desc: 'A permission set assignable to a person. Most apps need a role COLUMN on a membership, not this entity',
    rules: ['Permissions are explicit', 'System roles cannot be deleted'],
    fields: F('name text!', 'permissions tags', 'isSystem bool =false system'),
    links: [{ name: 'organization', to: 'Organization' }],
  },
  {
    name: 'Group', category: 'identity_access',
    desc: 'A named collection of members — Users (a team), Contacts (a segment), or both. A stable recipient set or scope boundary. Distinct from Organization (the tenant), Tag (a flat label) and Listener (one interest per row)',
    rules: ['Has a name and an owner', 'Membership may be static or rule-driven', 'Visibility scoped (private, shared, public)'],
    fields: F('name text!', 'visibility enum(private,shared,public) =private'),
    links: [
      { name: 'owner', to: 'User', actor: 'owner', required: true },
      { name: 'organization', to: 'Organization' },
    ],
    lifecycle: lifecycle('activate: draft -> active; pause: active -> inactive; reactivate: inactive -> active; archive: [draft, active, inactive] -> archived'),
  },

  // ── meta ──
  {
    name: 'Tag', category: 'meta',
    desc: 'A classification applied to rows. A single label column is a `tags` field; a Tag entity is earned when tags are managed (renamed, colored, counted)',
    rules: ['Scope determines applicability'],
    fields: F('name text!', 'color color'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },
  {
    name: 'Template', category: 'meta',
    desc: 'A reusable starting pattern — an email body, a document skeleton',
    rules: ['Variables must resolve at instantiation'],
    fields: F('name text!', 'body longtext!', 'variables tags'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },

  // ── operations ──
  {
    name: 'Event', category: 'operations', kinds: ['domain', 'audit'],
    desc: 'A point-in-time occurrence, recorded for downstream reaction and for traceability. There is no separate AuditLog entity — an audit trail is Events with an actor and retention. Earned only where the description asks for something retained; every write already announces itself',
    rules: ['Immutable once written', 'Has a timestamp', 'An audit trail is append-only and retained per policy'],
    fields: F('type text!', 'occurredAt datetime! system', 'payload json', 'severity enum(info,warning,critical) =info'),
    links: [{ name: 'actor', to: 'User', actor: 'subject', why: 'who caused it, when a person did' }],
  },
  {
    name: 'Flow', category: 'operations',
    desc: 'The DEFINITION of a stage progression that instances move through — a pipeline, a workflow. Rows move through it by a link to the current stage or by a lifecycle; this row holds the stages',
    rules: ['Transitions follow rules', 'Owner controls stage definitions'],
    fields: F('name text!', 'stages json!'),
    links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }],
  },
  {
    name: 'Action', category: 'operations',
    desc: 'An invokable, scheduled, or executing operation with intent, timing, retries and execution state. Action is what the system can DO; Event is what HAS happened',
    rules: ['Has a type and a target', 'Schedulable via executeAt; retryable per policy', 'Cancellable before completion'],
    fields: F('name text!', 'type text!', 'executeAt datetime', 'attempts count =0 system', 'data json'),
    links: [{ name: 'author', to: 'User', actor: 'author' }],
    lifecycle: lifecycle('schedule: pending -> scheduled; run: scheduled -> running system; succeed: running -> success system; fail: running -> error system; retry: error -> scheduled system; pause: running -> paused; resume: paused -> running; cancel: [pending, scheduled, running, paused] -> cancelled'),
  },

  // ── content & public ──
  {
    name: 'Site', category: 'content_public',
    desc: 'A web-addressable boundary — domain, branding, configuration, and the Pages it contains',
    rules: ['Has a unique domain', 'Owned by an Organization or a User', 'Contains Pages'],
    fields: F('name text!', 'domain text unique', 'branding json', 'configuration json'),
    links: [
      { name: 'owner', to: 'User', actor: 'owner', required: true },
      { name: 'organization', to: 'Organization' },
    ],
    lifecycle: lifecycle('launch: draft -> published; takeDown: published -> maintenance; restore: maintenance -> published; archive: [draft, published, maintenance] -> archived'),
  },
  {
    name: 'Page', category: 'content_public',
    desc: 'Addressable content within a Site — a post, an article, a presented view at a URL',
    rules: ['Belongs to a Site', 'Has a slug unique within the Site', 'Can be draft or published'],
    fields: F('slug slug!', 'title text!', 'body markdown', 'publishedAt datetime system'),
    links: [
      { name: 'site', to: 'Site', required: true },
      { name: 'author', to: 'User', actor: 'author', required: true },
    ],
    lifecycle: lifecycle('publish: [draft, unpublished] -> published; unpublish: published -> unpublished; archive: [draft, published, unpublished] -> archived'),
  },
]

export const ENTITY = Object.fromEntries(ENTITIES.map(e => [e.name, e]))

// ─── patterns ─────────────────────────────────────────────────────────────────
//
// A trigger × verb-home grid of behavior. Nothing here emits a column: a
// pattern is an API fact (a hook, a job, a notification), so an answer cites
// one to say WHY a lifecycle or a link exists, and the emitter writes the
// citation as a comment beside the model it names.

export const TRIGGERS = {
  user:     'a person acts (submit, click, request)',
  time:     'a schedule, deadline, or cadence fires',
  state:    'a state change inside the system fires',
  external: 'a third-party system or signal arrives',
}

export const VERBS = {
  capture:     'get information into the system',
  communicate: 'move information between actors',
  transform:   'automatic data shape changes',
  surface:     'make information visible for decisions',
  other:       'coordination of work, value movement, permission and identity boundaries',
}

export const PATTERNS = [
  { id: 'submission',      trigger: 'user',     verb: 'capture',     grammar: 'Author submits [Form] → creates [Submission]', desc: 'An author fills out a structured input and the system creates a record' },
  { id: 'booking',         trigger: 'user',     verb: 'other',       grammar: 'Subject books → creates [Visit] referencing [Resource] and [Schedule]', desc: 'A subject reserves a resource for a time period, producing a scheduled interaction' },
  { id: 'assignment',      trigger: 'user',     verb: 'other',       grammar: 'Coordinator sets the assignee on [Task] or [Visit] → notifies the Performer', desc: 'A coordinator routes work to a performer' },
  { id: 'outreach',        trigger: 'user',     verb: 'communicate', grammar: 'Author sends [Message] to a Contact → replies chain through the parent link', desc: 'An actor starts direct communication with a recipient outside the system' },
  { id: 'checkout',        trigger: 'user',     verb: 'other',       grammar: 'Subject accepts [Document:quote] → creates [Document:invoice] → creates [Payment]', desc: 'A user commits to a value exchange' },
  { id: 'search',          trigger: 'user',     verb: 'surface',     grammar: 'Subject reads matching rows with filters', desc: 'A user requests a filtered view of data on demand' },
  { id: 'approval',        trigger: 'user',     verb: 'other',       grammar: 'Author submits [Submission] → Coordinator approves or rejects → notifies the Author', desc: 'An author submits something for review; a coordinator approves or rejects' },
  { id: 'recurring',       trigger: 'time',     verb: 'other',       grammar: '[Schedule] creates [Visit] or [Task] on a cadence', desc: 'A schedule generates instances on a cadence' },
  { id: 'digest',          trigger: 'time',     verb: 'communicate', grammar: '[Schedule] fires → reads [Event] history → notifies each [Listener]', desc: 'A scheduled rollup of recent activity delivered to subscribers' },
  { id: 'renewal',         trigger: 'time',     verb: 'other',       grammar: '[Schedule] fires at renewal → creates [Document:invoice] → creates [Payment]', desc: 'A time-bound commitment cycles to its next period, generating a new charge' },
  { id: 'batch_sync',      trigger: 'time',     verb: 'transform',   grammar: '[Schedule] fires → [Integration] syncs data via its field mappings', desc: 'A scheduled job aligns data between sources on a cadence' },
  { id: 'escalation',      trigger: 'time',     verb: 'other',       grammar: '[Task] or [Visit] goes stale → notifies the Coordinator → reassigns', desc: 'Time elapses without action and escalates to a higher-tier actor' },
  { id: 'cascade',         trigger: 'state',    verb: 'other',       grammar: '[Entity] moves to a state → updates related rows → notifies', desc: 'A state change drives a chain of downstream coordination' },
  { id: 'notification',    trigger: 'state',    verb: 'communicate', grammar: 'A row changes → matching [Listener] → notifies', desc: 'A state change produces a delivered message to interested actors' },
  { id: 'settlement',      trigger: 'state',    verb: 'other',       grammar: '[Entity] reaches a settlement state → creates [Document:invoice] → creates [Payment]', desc: 'A state change drives value movement — billing, refund, credit' },
  { id: 'projection',      trigger: 'state',    verb: 'transform',   grammar: 'A row changes → rebuilds [View] or [Dashboard]', desc: 'State changes rebuild a derived view' },
  { id: 'audit',           trigger: 'state',    verb: 'other',       grammar: 'Any change to [Entity] → creates [Event:audit]', desc: 'Every meaningful action is recorded as an immutable Event with actor and target' },
  { id: 'webhook_ingress', trigger: 'external', verb: 'transform',   grammar: '[Integration] receives a payload → creates [Webhook] → updates a row', desc: 'An external system sends an event; it is processed and reflected internally' },
]

export const PATTERN = Object.fromEntries(PATTERNS.map(p => [p.id, p]))

export const MODIFIERS = [
  { id: 'listener',     appliesTo: ['notification', 'digest'],                         desc: 'Fan-out through a registered-interest list' },
  { id: 'cancellation', appliesTo: ['cascade', 'settlement'],                          desc: 'Reverse a prior commitment, often with a refund and a notification' },
  { id: 'idempotency',  appliesTo: ['webhook_ingress', 'cascade', 'settlement'],       desc: 'Applying the same trigger N times produces the same end state' },
  { id: 'compensation', appliesTo: ['cascade', 'settlement'],                          desc: 'When a downstream step fails, prior steps are undone' },
  { id: 'async',        appliesTo: ['cascade', 'notification', 'settlement', 'projection'], desc: 'Effects run later on a worker, not in the request' },
]
