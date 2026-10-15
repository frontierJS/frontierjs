// ─── emit.js — a graded answer, written as db/schema.lite ─────────────────────
//
// The step the mockup never took: it ended at a paragraph. This ends at the
// seed. `emit(answer, { scaffold })` grades the answer with `checkAnswer`, and
// only a plan with nothing refused is written. A plan is written the same way
// every time, so a schema that fails to parse here is an emitter defect, never
// the model's, and is fixed here once for every app.
//
// ── Access is derived, never written ──────────────────────────────────────────
//
// Each op's policy is assembled from what the answer said about who reaches a
// row, and from nothing else:
//
//   read    any of: an actor link to User, `check(via)`, a membership row,
//           a `publicWhen` condition. Under a parent with a public read it is
//           `check(via, 'update')`, so the parent's public clause stays its own
//   create  the caller IS the owner/author/coordinator the row names, AND may
//           read the parent it hangs under. Both, because either alone lets a
//           caller attach a row to a parent they cannot see, or file one
//           under somebody else's name. A row naming no caller asks the same
//           of the parent as its read does
//   update  any of: an owner/author/coordinator/performer link, or whoever may
//           change the parent
//   delete  any of: an owner/author link, or whoever may change the parent
//
// A container's update is its members holding a role `roles.update` names,
// and its membership's writes delegate to that update; with no such role the
// membership's writes are the application's.
//
// An op nobody holds is raised to gate 8 rather than left at a signed-in
// level with no policy, which is the shape that read every tenant's rows in
// the freehand run. `shared` and `public` are the two ways to say otherwise,
// and `checkAnswer` lists each as a finding. `shared` says it of the read
// alone: the writes follow the links above, and one nobody holds is level 5's.
//
// The first owner/author/coordinator column is stamped `@default(auth().id)`,
// so a create through the API names its caller without being told — except
// under a public create, where the caller may be a visitor with no id to
// stamp. There the column is the caller's to name, as any other link is.

import { camel, pascal, pluralize } from '@frontierjs/toolbelt/inflect'
import { ACTORS } from './catalog.js'
import { an, checkAnswer } from './answer.js'
import { TYPES } from './types.js'

const STAMPS = ['owner', 'author', 'coordinator']
const WIDTH = 96

/**
 * @param {any} answer
 * @param {{ scaffold?: string }} [opts]  the app's db/schema.lite as `fli new`
 *   wrote it. The emitted models are appended to it; User and Notification
 *   stay the scaffold's.
 * @returns {{ ok: boolean, text: string|null, models: string[], document: { operations: import('./answer.js').Operation[] }|null, onRegistered: string|null, refusals: import('./answer.js').Finding[], findings: import('./answer.js').Finding[] }}
 *   `document` is what `litestone migrate create --operations` reads, or null
 *   when the answer asks to keep nothing. The schema alone carries no history,
 *   so a rename reaches the database only through this (`FJS-D603`).
 *   `onRegistered` is the source of a module exporting the hook
 *   `createLitestoneAuth` takes, or null when no container needs one
 *   (`FJS-D886`).
 */
export function emit(answer, { scaffold = '' } = {}) {
  const graded = checkAnswer(answer)
  if (!graded.ok) return { ok: false, text: null, models: [], document: null, onRegistered: null, refusals: graded.refusals, findings: graded.findings }
  const plan = /** @type {import('./answer.js').Plan} */ (graded.plan)
  const hook = onboarding(plan)
  const section = emitPlan(plan)
  const head = scaffold.trimEnd()
  return {
    ok: true,
    text: `${head}${head ? '\n\n\n' : ''}${section}`,
    models: plan.models.map(m => m.name),
    document: plan.operations.length ? { operations: plan.operations } : null,
    onRegistered: hook,
    refusals: [],
    findings: graded.findings,
  }
}

/** @param {import('./answer.js').Plan} plan */
function emitPlan(plan) {
  const backs = backFields(plan.models)
  const currency = plan.currency
  const declares = declarers(plan.models)
  const access = accessTable(plan.models, backs)
  const out = []

  out.push('// ─── Oracle ' + '─'.repeat(WIDTH - 11))
  out.push('//')
  out.push(...comment(`Written by @frontierjs/oracle from a graded answer. ${plan.summary}`))
  if (plan.actors.length) {
    out.push('//')
    out.push('// Actors:')
    for (const a of plan.actors) out.push(...comment(`  ${a.name} — ${a.archetype}${a.who ? `: ${a.who}` : ''}`))
  }
  if (plan.findings.length) {
    out.push('//')
    out.push('// Access, stated first because it is what a wrong answer costs most:')
    for (const f of plan.findings) out.push(...comment(`  ${f.at}: ${f.message}`))
  }
  if (plan.open.length) {
    out.push('//')
    out.push('// Open — asked, not answered, and so not in the schema:')
    for (const q of plan.open) out.push(...comment(`  ${q}`))
  }

  for (const m of plan.models) {
    out.push('')
    out.push(...emitModel(m, backs.get(m.name) ?? [], access.get(m.name), currency, declares))
  }
  return `${out.join('\n')}\n`
}

// ─── back-relations ───────────────────────────────────────────────────────────
//
// A link to another entity gets its list on the far side, because a
// membership test (`members.some(...)`) is written against that list. A link
// to User gets none: User is the scaffold's, and an emitter editing it would
// own a model it did not write.

function relationName(m, l) {
  const same = m.links.filter(x => x.to === l.to).length > 1
  return same || l.to === m.name ? `${m.name}${pascal(l.name)}` : null
}

function backFields(models) {
  /** @type {Map<string, { name: string, source: string, relation: string|null, link: string }[]>} */
  const backs = new Map()
  const taken = new Map(models.map(m => [m.name, new Set(columnNames(m))]))
  for (const m of models) {
    for (const l of m.links) {
      if (l.to === 'User') continue
      const rel = relationName(m, l)
      const plural = pluralize(m.name)
      let name = rel ? `${l.name}${pascal(plural)}` : camel(plural)
      const used = taken.get(l.to)
      if (used.has(name)) name = `${l.name}${pascal(plural)}`
      for (let n = 2; used.has(name); n++) name = `${camel(plural)}${n}`
      used.add(name)
      if (!backs.has(l.to)) backs.set(l.to, [])
      backs.get(l.to).push({ name, source: m.name, relation: rel, link: l.name })
    }
  }
  return backs
}

function columnNames(m) {
  return ['id', 'createdAt', 'updatedAt',
    ...(m.kinds.length > 1 ? ['kind'] : []),
    ...(m.softDelete ? ['deletedAt'] : []), ...(m.extensible ? ['customFields'] : []), ...(m.currency ? [m.currency] : []),
    ...(m.lifecycle ? [m.lifecycle.field] : []),
    ...m.fields.map(f => f.name),
    ...m.links.flatMap(l => [l.name, `${l.name}Id`])]
}

// ─── declared fields ──────────────────────────────────────────────────────────
//
// An entity's custom fields are another entity's rows. Where both hang `via`
// the same link to the same parent — the company a tenant's records live
// under — the declarations are that parent's, so two companies each declare a
// `tier` and neither sees the other's. Otherwise a key is the installation's.

function declarers(models) {
  const byName = new Map(models.map(m => [m.name, m]))
  /** @type {Map<string, { scope: string|null }>} */
  const out = new Map()
  for (const m of models) {
    if (!m.extensible) continue
    const d = byName.get(m.extensible)
    const parent = (x) => x.access.via ? `${x.access.via}:${x.links.find(l => l.name === x.access.via).to}` : null
    const shared = parent(m) && parent(m) === parent(d)
    // Every entity a declarer serves must agree, or one of them reads the
    // other's keys; disagreeing falls back to the installation-wide key.
    const scope = shared ? `${m.access.via}Id` : null
    const was = out.get(d.name)
    out.set(d.name, { scope: was && was.scope !== scope ? null : scope })
  }
  return out
}

// ─── one model ────────────────────────────────────────────────────────────────

/**
 * @param {import('./answer.js').Model} m
 * @param {string[]} currency  the answer's codes; a row with money picks one when there are several
 * @param {Map<string, { scope: string|null }>} declares  each declaring entity, and the parent its keys are unique under
 */
function emitModel(m, backs, access, currency, declares) {
  const out = []
  const enums = []
  /** @type {[string, string, string][]} */
  const rows = []

  out.push(...comment(`${m.name} — ${m.from ? `${m.from}${m.kinds.length === 1 ? `:${m.kinds[0]}` : ''}, ${m.rung}` : m.rung}. ${m.why}`))
  if (m.cost) out.push(...comment(`Cost: ${m.cost}`))
  if (m.escape) out.push(...comment(`Escape: ${m.escape}`))
  if (m.patterns.length) out.push(...comment(`Patterns: ${m.patterns.join(', ')}.`))

  rows.push(['id', 'Int', '@id @default(autoincrement())'])

  if (m.kinds.length > 1) {
    enums.push(enumBlock(`${m.name}Kind`, m.kinds))
    rows.push(['kind', `${m.name}Kind`, ''])
  }

  for (const f of m.fields) {
    const enumName = `${m.name}${pascal(f.name)}`
    if (f.type === 'enum') enums.push(enumBlock(enumName, f.values))
    const row = TYPES[f.type]
    const { type, attrs } = row.lite(f, enumName, m.currency ? { field: m.currency } : currency[0])
    const optional = !f.required && !row.array && !row.alwaysSet && f.default == null
    const extra = [...attrs]
    if (f.unique) extra.push('@unique')
    if (f.default != null) extra.push(`@default(${literal(f)})`)
    else if (row.alwaysSet) extra.push('@default(false)')
    else if (row.array) extra.push('@default([])')
    if (f.system) extra.push('@system')
    rows.push([f.name, `${type}${optional ? '?' : ''}`, extra.join(' ')])
  }

  // A visitor has no auth().id, so a stamp under a create gate of 0 filled a
  // required column with NULL and every anonymous create answered 500 on NOT
  // NULL (FJS-1793).
  const stamp = m.access.system || m.container || access.gate[1] === 0 ? null
    : m.links.find(l => l.to === 'User' && STAMPS.includes(l.actor))
  const indexes = []
  for (const l of m.links) {
    const fk = `${l.name}Id`
    const keyType = l.to === 'User' ? 'String' : 'Int'
    const rel = relationName(m, l)
    rows.push([fk, `${keyType}${l.required ? '' : '?'}`, l === stamp ? '@default(auth().id)' : ''])
    rows.push([l.name, `${l.to}${l.required ? '' : '?'}`,
      `@relation(${rel ? `"${rel}", ` : ''}fields: [${fk}], references: [id], onDelete: ${l.required ? 'Cascade' : 'SetNull'})`])
    // A relator indexes both relata itself; a hand-written one is refused.
    if (!(m.container && [m.container.link, m.container.user].includes(l.name))) indexes.push(fk)
  }

  if (m.lifecycle) {
    const name = `${m.name}${pascal(m.lifecycle.field)}`
    enums.push(enumBlock(name, m.lifecycle.states))
    rows.push([m.lifecycle.field, name, `@default(${m.lifecycle.initial})`])
  }

  // The currency a row's amounts are in, from the answer's list: the first
  // is the default, and the database refuses one the answer did not name.
  if (m.currency) rows.push([m.currency, 'String', `@default("${currency[0]}") @check("${m.currency} IN (${currency.map(c => `'${c}'`).join(', ')})")`])
  // Fields a tenant adds with no deploy; the declarations are another entity's rows.
  if (m.extensible) rows.push(['customFields', 'Json', '@default("{}")'])

  for (const b of backs) rows.push([b.name, `${b.source}[]`, b.relation ? `@relation("${b.relation}")` : ''])

  rows.push(['createdAt', 'DateTime', '@default(now())'])
  rows.push(['updatedAt', 'DateTime', '@default(now()) @updatedAt'])
  // remove() stamps it and restore() clears it; every read skips a stamped row.
  if (m.softDelete) rows.push(['deletedAt', 'DateTime?', ''])

  const w0 = Math.max(...rows.map(r => r[0].length))
  const w1 = Math.max(...rows.map(r => r[1].length))
  const body = rows.map(([n, t, a]) => `  ${n.padEnd(w0)}  ${a ? `${t.padEnd(w1)}  ${a}` : t}`.trimEnd())

  const attrs = []
  // A @@fts model is refused without @@label (FJS-D970), so a searched entity
  // with no caption column takes its first searched column as the title.
  const label = labelField(m) ?? (m.fts.length ? m.fts[0] : null)
  if (label) attrs.push(`@@label(${label})`)
  for (const fk of indexes) attrs.push(`@@index([${fk}])`)
  // A person is a member once, and the row IS the pair: `@@relator(…, once)`
  // says so and gets the reverse index the switcher's *which containers am I
  // in* needs. A relator refuses an optional relatum, and a membership whose
  // person is optional is an invitation waiting for a sign-up, so that one
  // keeps a unique that holds every pending row distinct.
  if (m.container) {
    const optional = !m.links.find(l => l.name === m.container.user)?.required
    attrs.push(optional
      ? `@@unique([${m.container.link}Id, ${m.container.user}Id], nullsDistinct: true)`
      : `@@relator([${m.container.link}Id, ${m.container.user}Id], once)`)
  }
  if (m.patterns.includes('audit')) attrs.push('@@trail(audit)')
  if (m.softDelete) attrs.push('@@softDelete')
  if (m.fts.length) attrs.push(`@@fts([${m.fts.join(', ')}])`)
  if (m.extensible) {
    const scope = declares.get(m.extensible).scope
    attrs.push(`@@extensible(customFields, declaredBy: ${m.extensible}${scope ? `, scope: ${scope}` : ''})`)
  }
  // A key is declared once per entity, or once per parent when the
  // declarations hang under the tenant's container.
  if (declares.has(m.name)) attrs.push(`@@unique([${declares.get(m.name).scope ?? 'model'}, key])`)

  attrs.push(`@@gate("${access.gate.join('.')}")`)
  if (m.lifecycle) attrs.push(transitions(m.lifecycle))
  const opWidth = Math.max(0, ...access.policies.map(([op]) => op.length + 3))
  for (const [op, expr] of access.policies) attrs.push(`@@allow(${`'${op}',`.padEnd(opWidth)} ${expr})`)

  for (const e of enums) out.push(...e, '')
  out.push(`model ${m.name} {`, ...body, '', ...attrs.flatMap(a => a.split('\n').map(line => `  ${line}`)), '}')
  return out
}

function enumBlock(name, values) {
  return [`enum ${name} {`, ...values.map(v => `  ${v}`), '}']
}

function literal(f) {
  if (f.type === 'enum') return String(f.default)
  if (typeof f.default === 'string') return JSON.stringify(f.default)
  return String(f.default)
}

function labelField(m) {
  const pick = ['name', 'title', 'subject', 'number', 'label', 'slug', 'topic', 'email']
    .find(n => m.fields.some(f => f.name === n && f.required))
  return pick ?? m.fields.find(f => f.required && ['text', 'email', 'slug'].includes(f.type))?.name ?? null
}

function transitions(life) {
  const moves = life.moves.map(mv => {
    const from = mv.from.length === 1 ? mv.from[0] : `[${mv.from.join(', ')}]`
    return `${mv.name}: ${from} -> ${mv.to}${mv.by === 'system' ? ' @system' : ''}`
  })
  return `@@transitions(${life.field},\n${moves.map((s, i) => `  ${s}${i < moves.length - 1 ? ',' : ')'}`).join('\n')}`
}

// ─── access ───────────────────────────────────────────────────────────────────

const OPS = ['read', 'create', 'update', 'delete']

/**
 * Every model's gate and policies, keyed by name. Memoized and computed
 * parent-first, because a delegation may only name an op the parent holds a
 * POLICY for: litestone compiles `check(parent, 'update')` against a parent
 * held only by a gate as no restriction at all, so a membership delegating
 * to a container with no update policy let any signed-in caller add
 * themselves to any container.
 *
 * @param {import('./answer.js').Model[]} models
 * @param {Map<string, { name: string, source: string, link: string }[]>} backs
 */
function accessTable(models, backs) {
  const byName = new Map(models.map(m => [m.name, m]))
  /** @type {Map<string, { gate: number[], policies: [string, string][] }>} */
  const memo = new Map()
  const of = (name) => {
    if (!memo.has(name)) memo.set(name, accessFor(byName.get(name), of, backs.get(name) ?? []))
    return memo.get(name)
  }
  for (const m of models) of(m.name)
  return memo
}

/**
 * @param {import('./answer.js').Model} m
 * @param {(name: string) => { gate: number[], policies: [string, string][] }} of
 * @param {{ name: string, source: string, link: string }[]} backs  this model's back-relation lists
 * @returns {{ gate: number[], policies: [string, string][] }}
 */
function accessFor(m, of, backs) {
  const a = m.access
  const pub = a.public ?? []

  // A parent read at gate 0 carries its public clause through `check(parent)`,
  // so a child of a published shop is read by everybody who reads the shop.
  // Its private rows are reached through whoever may change it instead, and
  // with no update rule there is nobody to delegate to.
  const open = (parent) => of(parent).gate[0] === 0
  // The op a change on this row delegates to: the parent's own update rule
  // where it has one, and otherwise whoever may read the parent.
  const changeOp = (parent) => of(parent).policies.some(([op]) => op === 'update') ? 'update' : open(parent) ? null : 'read'
  const readOp = (parent) => open(parent) ? changeOp(parent) : 'read'
  const delegate = (link, op) => op ? [`check(${link}, '${op}')`] : []
  const reader = (link, parent) => readOp(parent) === 'read' ? [`check(${link})`] : delegate(link, readOp(parent))

  const self = (op) => m.links.filter(l => l.to === 'User' && ACTORS[l.actor].may.includes(op)).map(l => `${l.name}Id == auth().id`)
  const terms = { read: self('read'), create: [], update: self('update'), delete: self('delete') }
  let createParent = null

  if (m.container) {
    // A membership row: its person reads it, and whoever administers the
    // container decides who is in it. With no administering role there is
    // nobody to delegate to, and the writes are the application's.
    const c = m.container
    const change = c.admins ? delegate(c.link, changeOp(c.model)) : []
    terms.read = [`${c.user}Id == auth().id`, ...reader(c.link, c.model)]
    terms.create = [...change]
    terms.update = [...change]
    terms.delete = [...change]
  } else {
    terms.create = self('create')
    if (a.via) {
      const parent = m.links.find(l => l.name === a.via).to
      const change = delegate(a.via, changeOp(parent))
      terms.read.push(...reader(a.via, parent))
      // A caller who names themselves may file under a parent they only read
      // publicly, as a buyer orders from a published shop; a row naming nobody
      // is filed only by those who reach the parent's private rows.
      const into = terms.create.length ? 'read' : readOp(parent)
      if (into) createParent = `check(${a.via}, '${into}')`
      terms.update.push(...change)
      terms.delete.push(...change)
    }
    // A member reads the container, and a member holding an administering
    // role changes it. The membership's writes delegate to this update, so a
    // member test with no role in it let any member re-role themselves admin.
    if (m.members) {
      const list = backs.find(b => b.source === m.members.model && b.link === m.members.link).name
      const id = `${m.members.user}Id == auth().id`
      const roles = (m.members.admins ?? []).map(r => `role == '${r}'`)
      const role = roles.length > 1 ? ` && (${roles.join(' || ')})` : roles.length ? ` && ${roles[0]}` : ''
      terms.read.push(`${list}.some(${id})`)
      terms.update.push(`${list}.some(${id}${role})`)
    }
    // One term, every entry holding: checkAnswer's finding reads the entries
    // with *and*, and that sentence is what the person approves. Under a
    // parent with a public read the condition also needs that parent read:
    // standing alone it made an active listing public inside a draft shop.
    if (a.publicWhen) {
      const when = Object.entries(a.publicWhen).map(([k, v]) => `${k} == ${typeof v === 'string' ? `'${v}'` : v}`)
      const own = when.length > 1 ? `(${when.join(' && ')})` : when[0]
      const parent = a.via && m.links.find(l => l.name === a.via).to
      terms.read.push(parent && open(parent) ? `(check(${a.via}) && ${own})` : own)
    }
  }

  const gate = []
  const policies = []
  for (const op of OPS) {
    // `shared` opens the read to every signed-in caller and nothing else: a
    // write stays with the actor links that hold it, and one no link holds is
    // an administrator's. It once returned before the links were read, so an
    // instructor could not post the class every member reads.
    if (a.shared && op === 'read') { gate.push(4); continue }
    // On a container, `system` is the onboarding that creates it and the
    // teardown that deletes it; renaming it stays with its members.
    const system = a.system && op !== 'read' && !(m.members && op === 'update')
    const open = pub.includes(op) && !(op === 'read' && a.publicWhen)
    let expr = null
    if (!system && !open) {
      const or = terms[op].length > 1 ? terms[op].join(' || ') : terms[op][0] ?? null
      if (op === 'create' && createParent) expr = or ? `${createParent} && (${or})` : createParent
      else expr = or
    }
    gate.push(system ? 8 : pub.includes(op) ? 0 : expr ? 4 : a.shared ? 5 : 8)
    if (expr) policies.push([op, expr])
  }
  return { gate, policies }
}

// ─── onboarding ───────────────────────────────────────────────────────────────
//
// A container `system` creates is gated at 8 on create, so without this a
// fresh sign-up can neither make one nor be admitted to one and the app cannot
// be entered (FJS-2530). Each such container is created with the person who
// registered as its first member, holding the role that administers it.
//
// A column the hook cannot fill from the user is never guessed: a wrong guess
// fails every registration inside its own transaction. That container gets a
// finding instead, and its onboarding is the application's to write.

/**
 * @param {import('./answer.js').Plan} plan  its findings take one line per container left unentered
 * @returns {string|null}
 */
function onboarding(plan) {
  const lines = []
  const made = []
  for (const m of plan.models) {
    if (!m.access.system || !m.members) continue
    const mm = plan.models.find(x => x.name === m.members.model)
    const label = labelField(m)
    const role = m.members.admins?.[0] ?? null
    const unfilled = [
      ...needed(m, [label && m.fields.find(f => f.name === label)?.type === 'text' ? label : null]),
      ...needed(mm, [m.members.link, m.members.user, role ? 'role' : null]).map(n => `${mm.name}.${n}`),
    ]
    if (unfilled.length) {
      plan.findings.push({ rule: 'access', at: m.name, message: `Nothing the app ships creates ${an(m.name)}: onboarding cannot fill ${unfilled.join(', ')} from the person signing up, so the application writes the onRegistered that gives them one.` })
      continue
    }
    const v = camel(m.name)
    const data = label ? `{ ${label}: user.name ?? user.email }` : '{}'
    const member = [`${m.members.link}Id: ${v}.id`, `${m.members.user}Id: user.id`, ...role ? [`role: '${role}'`] : []]
    lines.push(`  const ${v} = await db.${v}.create({ data: ${data} })`)
    lines.push(`  await db.${camel(mm.name)}.create({ data: { ${member.join(', ')} } })`)
    made.push(role ? `${an(m.name)} they hold as ${role}` : `${an(m.name)} they are a member of`)
  }
  if (!lines.length) return null
  return [
    '// ─── onRegistered — written by @frontierjs/oracle ' + '─'.repeat(WIDTH - 49),
    '//',
    ...comment(`Only the application creates ${made.length > 1 ? 'these containers' : 'this container'}, so a person who signs up is given ${made.join(', and ')}. Pass it to createLitestoneAuth({ onRegistered }): db is the registration's own transaction, and a throw undoes the sign-up.`),
    '',
    'export async function onRegistered({ user, db }) {',
    ...lines,
    '}',
    '',
  ].join('\n')
}

// The columns of `m` a create must name and the hook has no value for: a
// required column with no default, a second kind, and a required link.
function needed(m, filled) {
  const out = []
  if (m.kinds.length > 1) out.push('kind')
  for (const f of m.fields) {
    const row = TYPES[f.type]
    if (f.required && f.default == null && !row.array && !row.alwaysSet && !filled.includes(f.name)) out.push(f.name)
  }
  for (const l of m.links) if (l.required && !filled.includes(l.name)) out.push(l.name)
  return out
}

// ─── comments ─────────────────────────────────────────────────────────────────

function comment(text) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ')
  const lead = (/^ +/.exec(String(text))?.[0] ?? '').length
  const lines = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur.length + w.length + 1) > WIDTH - 3 - lead) { lines.push(cur); cur = w }
    else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push(cur)
  return lines.map((l, i) => `// ${' '.repeat(i === 0 ? lead : lead + 2)}${l}`)
}
