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
// An op nobody holds is raised to gate 8 rather than left at a signed-in
// level with no policy, which is the shape that read every tenant's rows in
// the freehand run. `shared` and `public` are the two ways to say otherwise,
// and `checkAnswer` lists each as a finding.
//
// The first owner/author/coordinator column is stamped `@default(auth().id)`,
// so a create through the API names its caller without being told.

import { camel, pascal, pluralize } from '@frontierjs/toolbelt/inflect'
import { ACTORS } from './catalog.js'
import { checkAnswer } from './answer.js'
import { TYPES } from './types.js'

const STAMPS = ['owner', 'author', 'coordinator']
const WIDTH = 96

/**
 * @param {any} answer
 * @param {{ scaffold?: string }} [opts]  the app's db/schema.lite as `fli new`
 *   wrote it. The emitted models are appended to it; User and Notification
 *   stay the scaffold's.
 * @returns {{ ok: boolean, text: string|null, models: string[], refusals: import('./answer.js').Finding[], findings: import('./answer.js').Finding[] }}
 */
export function emit(answer, { scaffold = '' } = {}) {
  const graded = checkAnswer(answer)
  if (!graded.ok) return { ok: false, text: null, models: [], refusals: graded.refusals, findings: graded.findings }
  const plan = /** @type {import('./answer.js').Plan} */ (graded.plan)
  const section = emitPlan(plan)
  const head = scaffold.trimEnd()
  return {
    ok: true,
    text: `${head}${head ? '\n\n\n' : ''}${section}`,
    models: plan.models.map(m => m.name),
    refusals: [],
    findings: graded.findings,
  }
}

/** @param {import('./answer.js').Plan} plan */
function emitPlan(plan) {
  const backs = backFields(plan.models)
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
    out.push(...emitModel(m, backs.get(m.name) ?? [], access.get(m.name)))
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
    ...(m.lifecycle ? [m.lifecycle.field] : []),
    ...m.fields.map(f => f.name),
    ...m.links.flatMap(l => [l.name, `${l.name}Id`])]
}

// ─── one model ────────────────────────────────────────────────────────────────

/** @param {import('./answer.js').Model} m */
function emitModel(m, backs, access) {
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
    const { type, attrs } = row.lite(f, enumName)
    const optional = !f.required && !row.array && !row.alwaysSet && f.default == null
    const extra = [...attrs]
    if (f.unique) extra.push('@unique')
    if (f.default != null) extra.push(`@default(${literal(f)})`)
    else if (row.alwaysSet) extra.push('@default(false)')
    else if (row.array) extra.push('@default([])')
    if (f.system) extra.push('@system')
    rows.push([f.name, `${type}${optional ? '?' : ''}`, extra.join(' ')])
  }

  const stamp = m.access.system || m.container ? null
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

  for (const b of backs) rows.push([b.name, `${b.source}[]`, b.relation ? `@relation("${b.relation}")` : ''])

  rows.push(['createdAt', 'DateTime', '@default(now())'])
  rows.push(['updatedAt', 'DateTime', '@default(now()) @updatedAt'])

  const w0 = Math.max(...rows.map(r => r[0].length))
  const w1 = Math.max(...rows.map(r => r[1].length))
  const body = rows.map(([n, t, a]) => `  ${n.padEnd(w0)}  ${a ? `${t.padEnd(w1)}  ${a}` : t}`.trimEnd())

  const attrs = []
  const label = labelField(m)
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
  if (m.patterns.includes('audit')) attrs.push('@@log(audit)')

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

  if (a.shared) return { gate: [4, 5, 5, 5], policies: [] }

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
    // A membership row: its person reads it, and whoever may change the
    // container decides who is in it.
    const c = m.container
    const change = delegate(c.link, changeOp(c.model))
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
    // A member reads and changes the container; the gate says which rung
    // renames it. Without the update term a membership's create would fall
    // back to the container's read, and any member could add anyone.
    if (m.members) {
      const list = backs.find(b => b.source === m.members.model && b.link === m.members.link).name
      const member = `${list}.some(${m.members.user}Id == auth().id)`
      terms.read.push(member)
      terms.update.push(member)
    }
    if (a.publicWhen) terms.read.push(...Object.entries(a.publicWhen).map(([k, v]) => `${k} == ${typeof v === 'string' ? `'${v}'` : v}`))
  }

  const gate = []
  const policies = []
  for (const op of OPS) {
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
    gate.push(system ? 8 : pub.includes(op) ? 0 : expr ? 4 : 8)
    if (expr) policies.push([op, expr])
  }
  return { gate, policies }
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
