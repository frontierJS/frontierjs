// src/release.js — the release surface of a schema, and the pivot between two of them
//
// A deploy replaces code; it does not replace the rows already written, and it
// does not replace the release that is still serving while it starts. So the
// question a deploy has to answer is not "is this migration reversible" but:
//
//   Can Release N-1 and Release N serve the same database at once?
//
// Where the answer is yes the change is an EXPAND — N-1 keeps working, so the
// deploy can be taken back. Where it is no the change is a CONTRACT, and the
// transition it sits in is a PIVOT: the point after which only forward recovery
// exists. Where we cannot tell, the answer is UNKNOWN and counts as a contract,
// because a wrong "reversible" is the only answer that costs anything.
//
// Every generic deployer sees an opaque image and therefore cannot ask this at
// all. We read it off a file the developer already wrote.
//
// Two consumers, one derivation — the same shape `access.js` uses:
//   deriveReleaseSurface(schema)          → structured, for a classifier
//   renderReleaseSnapshot(surface)        → markdown, committed and diffed in git
//   classifyPivot(before, after)          → the verdict, and why
//   classifyAccess(before, after)         → the same comparison, read the other way
//
// ── One comparison, two readings ─────────────────────────────────────────────
//
// A deploy asks *can N-1 and N serve one database*. A reviewer asks *who may now
// do what they could not*. Those are different axes and they routinely disagree:
// removing a `@@gate` is an EXPAND — nothing N-1 does starts failing — and it is
// the widest thing a schema change can do to permissions; adding an `@@allow` is
// a CONTRACT, and it takes access away. A reviewer handed the deploy severity
// reads green on exactly the change that should stop them.
//
// So a finding carries both: `severity` for the deploy, and — where it is about
// who may do what — an `access` direction of `widens` / `narrows` / `unknown`.
// One walk, because two walks over the same declarations is how two answers to
// one question drift apart.
//
// The snapshot holds the SURFACE and never the verdict. A verdict is a fact
// about two schemas and the file describes one, so writing it in would make the
// file depend on its own previous contents — which is not a fixed point, and a
// snapshot that cannot be regenerated twice to the same bytes is not a snapshot.
//
// Never imported by production code.

import { deriveAccess, levelLabel } from './access.js'
import { modelToTableName, columnDefaultExpr, isSoftDelete, isSoftDeleteCascade } from './core/ddl.js'

const OPS = ['read', 'create', 'update', 'delete']

// ─── deriveReleaseSurface ─────────────────────────────────────────────────────
//
// schema → {
//   databases: [{ name, driver }],
//   enums:     [{ name, values: [...] }],
//   models: [{
//     name, db, table, external, softDelete, gate, gateSource,
//     fields:      [{ name, kind, type, optional, unique, id, default, writeRequired, protection, allows }],
//     uniques:     [[col, ...]],   indexes: [[col, ...]],
//     policies:    { <op>: { allows: [expr], denies: [expr] } },
//     transitions: [{ field, name, from, to, gate }],
//   }]
// }
//
// Sorted throughout, for the reason `access.js` sorts: a model inserted mid-file
// otherwise shifts every row below it and the diff stops naming what moved.

export function deriveReleaseSurface(schema, { pluralize = false } = {}) {
  const access = deriveAccess(schema)
  const byName = new Map(access.models.map(m => [m.name, m]))

  const models = [...(schema.models ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(model => describeModel(model, byName.get(model.name), pluralize))

  const enums = [...(schema.enums ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => ({ name: e.name, values: enumValues(e).sort() }))

  const databases = (schema.databases?.length ? schema.databases : [{ name: 'main', driver: 'sqlite' }])
    .map(d => ({ name: d.name, driver: d.driver ?? 'sqlite' }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { databases, enums, models }
}

// An enum member is a bare name or a name with a mapped value, depending on how
// it was written. Both spell the same thing on the wire, which is what N-1 binds
// to, so only the name is carried.
function enumValues(e) {
  return (e.values ?? []).map(v => (typeof v === 'string' ? v : v?.name ?? String(v)))
}

function describeModel(model, access, pluralize) {
  const attrs = model.attributes ?? []

  const fields = (model.fields ?? [])
    .map(f => describeField(f, access))
    .sort((a, b) => a.name.localeCompare(b.name))

  const uniques = attrs
    .filter(a => a.kind === 'uniqueIndex')
    .map(a => [...a.fields].sort())
    .sort(cmpCols)

  const indexes = attrs
    .filter(a => a.kind === 'index')
    .map(a => [...a.fields])          // an index is ordered — the column order IS the index
    .sort(cmpCols)

  const policies = {}
  for (const [op, entry] of Object.entries(access?.policies ?? {})) {
    policies[op] = {
      allows: entry.allows.map(a => a.expr).sort(),
      denies: entry.denies.map(a => a.expr).sort(),
    }
  }

  return {
    name:        model.name,
    db:          attrs.find(a => a.kind === 'db')?.name ?? 'main',
    table:       modelToTableName(model, pluralize),
    external:    attrs.some(a => a.kind === 'external'),
    softDelete:  isSoftDelete(model) ? (isSoftDeleteCascade(model) ? 'cascade' : true) : false,
    gate:        access?.gateSource ?? null,
    fields,
    uniques,
    indexes,
    policies,
    transitions: [...(access?.transitions ?? [])]
      .map(t => ({ field: t.field, name: t.name, from: states(t.from), to: states(t.to), gate: t.gate ?? null }))
      .sort((a, b) => `${a.field}.${a.name}`.localeCompare(`${b.field}.${b.name}`)),
  }
}

// A field is described by what N-1 binds to, which is wider than what SQLite
// stores: a `@computed` value is in the answer a service returns, so removing
// one breaks the previous release exactly as removing a column does.
function describeField(field, access) {
  const attrs  = field.attributes ?? []
  const has    = (kind) => attrs.some(a => a.kind === kind)
  const array  = !!field.type?.array
  const kind   = fieldKind(field, attrs)
  const column = kind === 'column'
  const rules  = access?.fields?.find(f => f.name === field.name) ?? null

  // A relation, a computed value and an @edge have no column, so they have no
  // nullability and no default. Asking columnDefaultExpr about one answers for
  // a column that does not exist — a `Tag[]` relation reads back as an array
  // with DEFAULT '[]'.
  const dflt = column ? columnDefaultExpr(field) : null

  return {
    name:       field.name,
    kind,
    type:       `${field.type?.name ?? '?'}${array ? '[]' : ''}`,
    optional:   column ? (!!field.type?.optional && !array) : null,
    id:         has('id'),
    unique:     has('unique'),
    default:    dflt,
    // Can Release N-1 still INSERT a row without knowing this field exists?
    // NOT NULL with no SQL DEFAULT is the one shape where it cannot — and it is
    // also the shape whose correct plan is expand → backfill → contract.
    writeRequired: column && !array && !field.type?.optional && !dflt &&
                   !has('id') && !has('generated') && !has('funcCall'),
    protection: rules?.protection ?? null,
    // A field-level `@allow` is an access rule like any other and N-1 binds to
    // its absence: adding one takes the column out of the answers the previous
    // release reads, or refuses the writes it makes. It is also where the
    // sharpest columns in this repo are guarded — `isSystemAdmin`, `role`,
    // `emailVerified` — so a comparison that could not see it would be silent
    // on the one change a reviewer most needs to be shown.
    allows: (rules?.allows ?? [])
      .map(a => `${[...(a.operations ?? [])].sort().join(',') || 'all'}: ${a.expr}`)
      .sort(),
  }
}

function fieldKind(field, attrs) {
  if (field.type?.kind === 'relation')    return 'relation'
  if (field.type?.kind === 'implicitM2M') return 'm2m'
  if (attrs.some(a => a.kind === 'computed'))  return 'computed'
  if (attrs.some(a => a.kind === 'transient')) return 'transient'
  if (attrs.some(a => a.kind === 'from'))     return 'from'
  if (attrs.some(a => a.kind === 'edge'))     return 'edge'
  return 'column'
}

const cmpCols = (a, b) => a.join(',').localeCompare(b.join(','))

// A transition's `from` is a SET of source states and arrives as an array, so
// comparing two of them by identity says every transition changed. Sorted and
// joined: one string, order-independent, and it renders as it compares.
function states(v) {
  return Array.isArray(v) ? [...v].sort().join(', ') : String(v)
}

// ─── classifyPivot ────────────────────────────────────────────────────────────
//
//   classifyPivot(before, after) → { verdict, findings, counts }
//
// `verdict` is the worst severity present: contract > unknown > expand >
// unchanged. Each finding says what moved and why N-1 does or does not survive
// it; a finding that has a supported split carries the three steps.
//
// The rule every line below is an application of: a change is an EXPAND when
// the previous release keeps working against the new database unchanged — it
// may write nothing new and read nothing new, but nothing it does now fails.

const EXPAND = 'expand', CONTRACT = 'contract', UNKNOWN = 'unknown'
const RANK   = { unchanged: 0, [EXPAND]: 1, [UNKNOWN]: 2, [CONTRACT]: 3 }

// The other axis. Ranked the same way RANK is — the answer that costs something
// sits highest, so the verdict is the worst thing present rather than the last
// thing found. `unknown` is shared: a predicate whose text moved is undecidable
// on both axes, for the same reason.
const WIDENS = 'widens', NARROWS = 'narrows'
const ARANK  = { unchanged: 0, [NARROWS]: 1, [UNKNOWN]: 2, [WIDENS]: 3 }

export function classifyPivot(before, after) {
  const f = []

  compareDatabases(before, after, f)
  compareEnums(before, after, f)
  compareModels(before, after, f)

  const counts = {
    expand:   f.filter(x => x.severity === EXPAND).length,
    unknown:  f.filter(x => x.severity === UNKNOWN).length,
    contract: f.filter(x => x.severity === CONTRACT).length,
  }

  const verdict = f.reduce((worst, x) => (RANK[x.severity] > RANK[worst] ? x.severity : worst), 'unchanged')

  f.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.subject.localeCompare(b.subject))

  return { verdict, findings: f, counts }
}

/** The three-step plan a contract on a required column is offered instead of. */
function split(model, field) {
  return [
    `expand:   declare \`${field}\` optional on \`${model}\` and deploy — N-1 keeps serving`,
    `backfill: fill \`${field}\` for the rows that predate it`,
    `contract: declare it required and deploy again — this deploy is the pivot`,
  ]
}

const add = (f, severity, subject, detail, extra = {}) => f.push({ severity, subject, detail, ...extra })

// ─── databases ────────────────────────────────────────────────────────────────

function compareDatabases(before, after, f) {
  const was = new Map(before.databases.map(d => [d.name, d]))
  const now = new Map(after.databases.map(d => [d.name, d]))

  for (const [name, d] of now)
    if (!was.has(name))
      add(f, EXPAND, `database ${name}`, `declared (${d.driver}) — nothing served it before`)

  for (const [name] of was)
    if (!now.has(name))
      add(f, CONTRACT, `database ${name}`, 'no longer declared — N-1 opens a database this release does not know about')

  for (const [name, d] of now) {
    const b = was.get(name)
    if (b && b.driver !== d.driver)
      add(f, UNKNOWN, `database ${name}`, `driver ${b.driver} → ${d.driver} — a stored form changed and nothing here can compare the two`)
  }
}

// ─── enums ────────────────────────────────────────────────────────────────────
//
// Enum membership is a CHECK constraint, so removing a member is a write that
// starts failing. Adding one widens the constraint and never fails a write —
// but N-1 will READ a value it has no branch for, which is why it is reported
// rather than passed over in silence.

function compareEnums(before, after, f) {
  const was = new Map(before.enums.map(e => [e.name, e]))
  const now = new Map(after.enums.map(e => [e.name, e]))

  for (const [name, e] of now) {
    if (!was.has(name)) { add(f, EXPAND, `enum ${name}`, `declared — ${e.values.length} member(s)`); continue }

    const b       = was.get(name)
    const added   = e.values.filter(v => !b.values.includes(v))
    const removed = b.values.filter(v => !e.values.includes(v))

    if (added.length)
      add(f, EXPAND, `enum ${name}`, `gains ${added.map(q).join(', ')} — N-1 keeps writing, and will read a value it has no branch for`)
    if (removed.length)
      add(f, CONTRACT, `enum ${name}`, `loses ${removed.map(q).join(', ')} — every N-1 write of one is refused by the CHECK, and rows already holding it fail their next write`)
  }

  for (const [name] of was)
    if (!now.has(name))
      add(f, CONTRACT, `enum ${name}`, 'no longer declared')
}

// ─── models ───────────────────────────────────────────────────────────────────

function compareModels(before, after, f) {
  const was = new Map(before.models.map(m => [m.name, m]))
  const now = new Map(after.models.map(m => [m.name, m]))

  for (const [name, m] of now)
    if (!was.has(name))
      add(f, EXPAND, `model ${name}`, `declared as \`${m.table}\` — N-1 never reads it`)

  for (const [name, m] of was)
    if (!now.has(name))
      add(f, CONTRACT, `model ${name}`, `removed — N-1 still reads \`${m.table}\``)

  for (const [name, m] of now) {
    const b = was.get(name)
    if (!b) continue
    compareModelShape(b, m, f)
    compareFields(b, m, f)
    compareConstraints(b, m, f)
    compareAccess(b, m, f)
  }
}

function compareModelShape(b, m, f) {
  const at = `model ${m.name}`

  if (b.table !== m.table)
    add(f, CONTRACT, at, `table \`${b.table}\` → \`${m.table}\` — N-1 binds to the old name and this release renames it under it`)

  if (b.db !== m.db)
    add(f, CONTRACT, at, `moves from database \`${b.db}\` to \`${m.db}\``)

  if (b.external !== m.external)
    add(f, UNKNOWN, at, `@@external ${b.external ? 'removed' : 'added'} — who owns this table changed, and nothing here can see what the other owner does`)

  if (b.softDelete !== m.softDelete) {
    // Both directions are a pivot. Turning it on makes an N-1 delete a hard one
    // against rows this release expects to keep; turning it off makes rows N-1
    // hid visible to every read.
    add(f, CONTRACT, at, `@@softDelete ${describeSoft(b.softDelete)} → ${describeSoft(m.softDelete)} — delete means something different in the two releases`)
  }
}

const describeSoft = (v) => (v === false ? 'off' : v === 'cascade' ? 'on (cascade)' : 'on')

function compareFields(b, m, f) {
  const was = new Map(b.fields.map(x => [x.name, x]))
  const now = new Map(m.fields.map(x => [x.name, x]))

  for (const [name, field] of now) {
    const at  = `${m.name}.${name}`
    const old = was.get(name)

    if (!old) {
      if (field.writeRequired)
        add(f, CONTRACT, at, `added as required \`${field.type}\` with no default — every N-1 write to \`${m.table}\` omits it and is refused`,
            { split: split(m.name, name) })
      else
        add(f, EXPAND, at, `added as ${field.optional ? 'optional' : 'defaulted'} \`${field.type}\` — N-1 writes without it`)
      continue
    }

    if (old.kind !== field.kind) {
      add(f, UNKNOWN, at, `${old.kind} → ${field.kind} — where the value lives changed`)
      continue
    }

    if (old.type !== field.type)
      add(f, CONTRACT, at, `\`${old.type}\` → \`${field.type}\` — N-1 reads and writes the old type`)

    if (!old.optional && field.optional)
      add(f, CONTRACT, at, 'required → optional — this release may write a NULL that N-1 has no case for')

    if (old.optional && !field.optional)
      add(f, CONTRACT, at, 'optional → required — N-1 writes omit it and existing NULLs fail the constraint',
          { split: split(m.name, name) })

    if (!old.unique && field.unique)
      add(f, CONTRACT, at, '@unique added — an N-1 write that duplicates an existing value is now refused')
    if (old.unique && !field.unique)
      add(f, EXPAND, at, '@unique removed')

    if (old.default && !field.default && !field.optional)
      add(f, CONTRACT, at, 'default removed from a required field — an N-1 write that omitted it is now refused')
    else if (!old.default && field.default)
      add(f, EXPAND, at, `default ${field.default} added`)
    else if (old.default && field.default && old.default !== field.default)
      add(f, EXPAND, at, `default ${old.default} → ${field.default}`)

    if (old.protection !== field.protection) {
      // A protection added takes the column out of every answer N-1 already
      // reads; @encrypted also changes the stored form under rows that are
      // already plaintext.
      if (field.protection && !old.protection)
        // @system is the one protection that leaves reads alone: it locks the
        // write and nothing else, so saying "the column leaves every answer"
        // would name the wrong half of a change that is still a pivot.
        add(f, CONTRACT, at, field.protection === '@system'
          ? '@system added — N-1 writes of this column are refused by name; its reads are unchanged'
          : `${field.protection} added — the column leaves every answer N-1 reads`,
          { access: NARROWS })
      else if (old.protection && !field.protection)
        add(f, EXPAND, at, `${old.protection} removed — the column is in answers it was absent from`,
            { access: WIDENS })
      else
        add(f, UNKNOWN, at, `${old.protection} → ${field.protection}`, { access: UNKNOWN })
    }

    compareFieldAllows(old, field, at, f)
  }

  for (const [name, field] of was)
    if (!now.has(name))
      add(f, CONTRACT, `${m.name}.${name}`, `removed — N-1 ${field.kind === 'column' ? 'reads and writes' : 'reads'} it`)
}

// A field-level `@allow` is a predicate, so only its PRESENCE is decidable here
// — the same limit `@@allow` has one level up, and grouped the same way, by the
// operations it names. Gaining the first rule for an operation restricts a
// column nothing restricted; losing the last one hands it back; a predicate
// whose text moved could be either.
function compareFieldAllows(old, field, at, f) {
  const byOps = (rules) => {
    const out = new Map()
    for (const rule of rules ?? []) {
      const i = rule.indexOf(': ')
      const ops = i === -1 ? 'all' : rule.slice(0, i)
      out.set(ops, [...(out.get(ops) ?? []), i === -1 ? rule : rule.slice(i + 2)])
    }
    return out
  }

  const was = byOps(old.allows), now = byOps(field.allows)

  for (const [ops, exprs] of now) {
    const before = was.get(ops)
    if (!before)
      add(f, CONTRACT, at, `@allow('${ops}') added — the column is refused to callers the predicate does not admit`, { access: NARROWS })
    else if (before.join(' | ') !== exprs.join(' | '))
      add(f, UNKNOWN, at, `@allow('${ops}') predicate changed — whether that widens or narrows is not decidable from the text`, { access: UNKNOWN })
  }

  for (const [ops] of was)
    if (!now.has(ops))
      add(f, EXPAND, at, `@allow('${ops}') removed — nothing at the field refuses this column now`, { access: WIDENS })
}

function compareConstraints(b, m, f) {
  diffSets(b.uniques.map(k), m.uniques.map(k), {
    added:   (cols) => add(f, CONTRACT, `model ${m.name}`, `@@unique(${cols}) added — an N-1 write that duplicates an existing pair is now refused`),
    removed: (cols) => add(f, EXPAND,   `model ${m.name}`, `@@unique(${cols}) removed`),
  })

  // An index changes how long a query takes and nothing else about what it
  // answers, so neither direction can break N-1.
  diffSets(b.indexes.map(k), m.indexes.map(k), {
    added:   (cols) => add(f, EXPAND, `model ${m.name}`, `@@index(${cols}) added`),
    removed: (cols) => add(f, EXPAND, `model ${m.name}`, `@@index(${cols}) removed`),
  })
}

const k = (cols) => cols.join(', ')

function diffSets(was, now, { added, removed }) {
  for (const x of now) if (!was.includes(x)) added(x)
  for (const x of was) if (!now.includes(x)) removed(x)
}

// ─── access ───────────────────────────────────────────────────────────────────
//
// An authorization change is a compatibility change, which is the half no
// generic deployer can see: raising a gate takes reads away from a release that
// is still serving them, and adding a row policy empties a screen with a 200.
// The comparison is possible here only because the rule is declared.

function compareAccess(b, m, f) {
  const at = `model ${m.name}`

  if (b.gate !== m.gate) {
    const was = levels(b.gate), now = levels(m.gate)
    if (!b.gate)      add(f, CONTRACT, at, `@@gate("${m.gate}") added — every N-1 caller below the level is refused`, { access: NARROWS })
    else if (!m.gate) add(f, EXPAND,   at, `@@gate("${b.gate}") removed — nothing at the Data boundary refuses this model now`, { access: WIDENS })
    else {
      const raised = OPS.filter((_, i) => now[i] > was[i])
      const eased  = OPS.filter((_, i) => now[i] < was[i])
      if (raised.length)
        add(f, CONTRACT, at, `gate "${b.gate}" → "${m.gate}" — ${raised.map(o => `${o} needs ${levelLabel(now[OPS.indexOf(o)])}`).join(', ')}, and N-1 callers below it are refused`,
            { access: NARROWS })
      if (eased.length)
        add(f, EXPAND, at, `gate "${b.gate}" → "${m.gate}" — ${eased.map(o => `${o} drops to ${levelLabel(now[OPS.indexOf(o)])}`).join(', ')}`,
            { access: WIDENS })
    }
  }

  // Grouped by what happened rather than by operation. `@@allow('all', …)` is
  // one line in the schema and five operations in the policy map, so a per-op
  // finding says the same sentence five times — and a tenancy predicate added
  // across fifteen models is then seventy rows nobody reads.
  for (const kind of ['allows', 'denies']) {
    const ops     = [...new Set([...Object.keys(b.policies), ...Object.keys(m.policies)])].sort()
    const added   = [], removed = [], moved = []

    for (const op of ops) {
      const was = (b.policies[op] ?? {})[kind] ?? []
      const now = (m.policies[op] ?? {})[kind] ?? []
      if      (!was.length && now.length) added.push(op)
      else if (was.length && !now.length) removed.push(op)
      else if (was.join(' | ') !== now.join(' | ')) moved.push(op)
    }

    const decl = kind === 'allows' ? '@@allow' : '@@deny'

    // Adding a predicate narrows what a caller reaches; removing one widens it.
    // Where both sides have one and the text moved, nothing here can say which
    // way — a policy is an expression, and comparing two of them is the thing
    // this module deliberately does not pretend to do.
    if (added.length)
      add(f, CONTRACT, at, `${decl}(${added.map(q).join(', ')}) added — ${narrows(added)}`, { access: NARROWS })
    if (removed.length)
      add(f, EXPAND, at, `${decl}(${removed.map(q).join(', ')}) removed — nothing declared refuses those operations now`, { access: WIDENS })
    if (moved.length)
      add(f, UNKNOWN, at, `${decl}(${moved.map(q).join(', ')}) predicate changed — whether that widens or narrows is not decidable from the text`,
          { access: UNKNOWN })
  }

  const wasT = new Map(b.transitions.map(t => [`${t.field}.${t.name}`, t]))
  const nowT = new Map(m.transitions.map(t => [`${t.field}.${t.name}`, t]))

  // A `@@transitions` declaration is enforced at the Data boundary like a gate,
  // so it is on the access axis — but its direction depends on whether the FIELD
  // was constrained at all. The first transition on a free enum column refuses
  // every other move; the second one permits one more. Counted per field rather
  // than assumed, because the two read identically as a single added row.
  const perField = (list) => {
    const n = new Map()
    for (const t of list) n.set(t.field, (n.get(t.field) ?? 0) + 1)
    return n
  }
  const wasN = perField(b.transitions), nowN = perField(m.transitions)

  for (const [key, t] of nowT) {
    const old = wasT.get(key)
    if (!old) {
      add(f, EXPAND, at, `transition \`${key}\` added (${t.from} → ${t.to})`,
          { access: wasN.has(t.field) ? WIDENS : NARROWS })
      continue
    }
    if (old.from !== t.from || old.to !== t.to)
      add(f, CONTRACT, at, `transition \`${key}\` ${old.from} → ${old.to} becomes ${t.from} → ${t.to}`, { access: UNKNOWN })
    if (old.gate !== t.gate)
      add(f, (t.gate && (!old.gate || t.gate > old.gate)) ? CONTRACT : EXPAND, at,
          `transition \`${key}\` gate ${old.gate ?? 'none'} → ${t.gate ?? 'none'}`,
          { access: (t.gate && (!old.gate || t.gate > old.gate)) ? NARROWS : WIDENS })
  }

  for (const [key, t] of wasT)
    if (!nowT.has(key))
      add(f, CONTRACT, at, `transition \`${key}\` removed — an N-1 caller still asks for it`,
          { access: nowN.has(t.field) ? NARROWS : WIDENS })
}

// What a newly declared policy costs the release still serving. A read policy
// is the one that does not raise — it compiles into the WHERE, so N-1 gets a
// 200 and fewer rows, which is the failure nobody sees.
function narrows(ops) {
  const read  = ops.includes('read')
  const write = ops.some(o => o !== 'read')
  if (read && write) return 'rows N-1 reads are filtered out with a 200, and writes that do not satisfy it are refused'
  if (read)          return 'rows N-1 reads are filtered out, with a 200 and no error'
  return 'N-1 writes that do not satisfy it are refused'
}

/** "4.4.4.5" → [4,4,4,5]. A gate is always four levels by the time it is here. */
function levels(gate) {
  return String(gate ?? '').split('.').map(n => Number(n))
}

const q = (s) => `\`${s}\``

// ─── classifyAccess ───────────────────────────────────────────────────────────
//
//   classifyAccess(before, after) → { verdict, findings, counts }
//
// The same walk, kept to the findings that carry a direction and graded on the
// other axis. `widens` is the answer that costs something, so it is the verdict
// whenever it is present — a change that narrows nine models and widens one is a
// widening, and a reviewer shown "narrows" would stop reading.
//
// What it deliberately cannot answer: whether a predicate that changed admits
// more or fewer rows. Two expressions are not comparable by their text, and a
// guess in this direction is the one that ships.

export function classifyAccess(before, after) {
  const findings = classifyPivot(before, after).findings
    .filter(x => x.access)
    .sort((a, b) => ARANK[b.access] - ARANK[a.access] || a.subject.localeCompare(b.subject))

  const counts = {
    widens:  findings.filter(x => x.access === WIDENS).length,
    unknown: findings.filter(x => x.access === UNKNOWN).length,
    narrows: findings.filter(x => x.access === NARROWS).length,
  }

  const verdict = findings.reduce((worst, x) => (ARANK[x.access] > ARANK[worst] ? x.access : worst), 'unchanged')

  return { verdict, findings, counts }
}

const ACCESS_HEADLINE = {
  unchanged: 'no change to who may do what',
  narrows:   'NARROWS — every declared change here takes access away',
  unknown:   'UNKNOWN — a predicate moved, and which way is not decidable from its text',
  widens:    'WIDENS — this change hands callers access they did not have',
}

export function formatAccessDiff({ verdict, findings, counts }, { baseline = 'the previous release' } = {}) {
  const out = [ACCESS_HEADLINE[verdict], '']

  if (verdict === 'unchanged') {
    out.push(`Nothing declared about access moved since ${baseline}.`)
    return out
  }

  out.push(`Against ${baseline} — ${counts.widens} widen · ${counts.unknown} undecidable · ${counts.narrows} narrow`)
  out.push('')

  for (const x of findings) {
    out.push(`  ${x.access.padEnd(8)} ${x.subject}`)
    out.push(`           ${x.detail}`)
  }

  return out
}

// ─── renderReleaseSnapshot ────────────────────────────────────────────────────
//
// The committed artefact. It holds the surface and nothing derived from a
// previous version of itself, so two runs over one tree produce one file.

export function renderReleaseSnapshot(surface, { source = 'schema.lite' } = {}) {
  const out = []
  const { models, enums, databases } = surface

  out.push('# Release surface')
  out.push('')
  out.push(`<!-- generated by: litestone release --schema ${source} -->`)
  out.push('')
  out.push(`Generated from \`${source}\` by \`fli release:check\`. **Do not edit.**`)
  out.push('')
  out.push('Every line below is something the release that is currently serving binds to.')
  out.push('The diff of this file between two releases is what `fli release:check`')
  out.push('classifies: a change N-1 survives is an **expand** and the deploy can be taken')
  out.push('back; a change it does not is a **contract**, and that deploy is the pivot.')
  out.push('')
  out.push('```')
  out.push(`${models.length} model(s) · ${enums.length} enum(s) · ${databases.length} database(s)`)
  out.push(`${databases.map(d => `${d.name} → ${d.driver}`).join(' · ')}`)
  out.push('```')
  out.push('')

  if (enums.length) {
    out.push('## Enums')
    out.push('')
    out.push('A member is a CHECK constraint. Removing one refuses every write of it.')
    out.push('')
    out.push('| Enum | Members |')
    out.push('| --- | --- |')
    for (const e of enums) out.push(`| \`${e.name}\` | ${e.values.map(q).join(' · ') || '—'} |`)
    out.push('')
  }

  out.push('## Models')
  out.push('')

  for (const m of models) {
    const facts = [
      `table \`${m.table}\``,
      `db \`${m.db}\``,
      m.gate ? `gate \`${m.gate}\`` : 'no gate',
      m.softDelete ? `@@softDelete${m.softDelete === 'cascade' ? '(cascade)' : ''}` : null,
      m.external ? '@@external' : null,
    ].filter(Boolean)

    out.push(`### \`${m.name}\``)
    out.push('')
    out.push(facts.join(' · '))
    out.push('')

    if (m.fields.length) {
      out.push('| Field | Type | Null | Default | Notes |')
      out.push('| --- | --- | --- | --- | --- |')
      for (const x of m.fields) {
        const notes = [
          x.id ? 'id' : null,
          x.unique ? 'unique' : null,
          x.kind === 'column' ? null : x.kind,
          x.protection,
          // A policy expression legitimately contains `||`, which ends the cell
          // and silently drops the rest of the row.
          ...x.allows.map(a => `\`@allow(${a.replace(/\|/g, '\\|')})\``),
          x.writeRequired ? '**required on write**' : null,
        ].filter(Boolean)
        const nullable = x.optional === null ? '—' : x.optional ? 'yes' : 'no'
        out.push(`| \`${x.name}\` | \`${x.type}\` | ${nullable} | ${x.default ? `\`${x.default}\`` : '—'} | ${notes.join(' · ') || '—'} |`)
      }
      out.push('')
    }

    const extra = []
    for (const cols of m.uniques) extra.push(`@@unique(${k(cols)})`)
    for (const cols of m.indexes) extra.push(`@@index(${k(cols)})`)
    for (const [op, p] of Object.entries(m.policies).sort()) {
      for (const e of p.allows) extra.push(`@@allow('${op}', ${e})`)
      for (const e of p.denies) extra.push(`@@deny('${op}', ${e})`)
    }
    for (const t of m.transitions)
      extra.push(`transition ${t.field}.${t.name}: ${t.from} → ${t.to}${t.gate ? ` @gate(${t.gate})` : ''}`)

    if (extra.length) {
      out.push('```')
      for (const line of extra) out.push(line)
      out.push('```')
      out.push('')
    }
  }

  return out.join('\n').replace(/\n+$/, '\n')
}

// ─── formatVerdict ────────────────────────────────────────────────────────────
//
// The terminal half. Printed rather than committed — see the note at the top of
// this file about why the verdict is not in the snapshot.

const VERDICT_HEADLINE = {
  unchanged: 'no change to the release surface',
  expand:    'EXPAND — N-1 keeps serving, so this deploy can be taken back',
  unknown:   'UNKNOWN — counts as a contract, because a wrong "reversible" is the only answer that costs anything',
  contract:  'CONTRACT — this deploy is the pivot: after it, only forward',
}

export function formatVerdict({ verdict, findings, counts }, { baseline = 'the previous release' } = {}) {
  const out = [`${VERDICT_HEADLINE[verdict]}`, '']

  if (verdict === 'unchanged') {
    out.push(`Nothing in the release surface moved since ${baseline}.`)
    return out
  }

  out.push(`Against ${baseline} — ${counts.contract} contract · ${counts.unknown} unknown · ${counts.expand} expand`)
  out.push('')

  for (const x of findings) {
    out.push(`  ${x.severity.padEnd(8)} ${x.subject}`)
    out.push(`           ${x.detail}`)
    if (x.split) for (const step of x.split) out.push(`           · ${step}`)
  }

  return out
}
