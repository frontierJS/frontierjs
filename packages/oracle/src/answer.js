// ─── answer.js — what a model may say, and the ladder's checks on it ──────────
//
// `IDEAS/oracle-reasoning.md` is the doctrine and this is the half of it that
// code can hold. A model reads a person's words and writes an ANSWER: which
// catalog entries the domain already contains, what it adds to them, who
// reaches each row, and how each thing moves. This module grades that answer
// and turns it into a PLAN `emit.js` writes as `.lite`. No model runs here
// (`FJS-D601`), so the same answer is graded the same way twice.
//
// ── Three rules the code holds rather than trusts ─────────────────────────────
//
// AN ANSWER WRITES NO SCHEMA. It names types from `TYPES`, actors from
// `ACTORS` and entries from the catalog; the `.lite` is the emitter's. A model
// that could write `@@allow` could write a wrong one, which is what a freehand
// run measured: a quarter of its graded models were readable across tenants
// (fjs-prototypes/base44, Phase 1).
//
// EVERY ROW HAS SOMEBODY. A gate is per model and never per row, so an entity
// is refused unless its answer names who reaches a row: a link to User through
// an actor, a parent it inherits from (`via`), a membership, or an explicit
// `public` or `shared` with a reason. *Signed in, so reads everything* is the
// one access shape this module cannot emit by accident.
//
// AN INFERENCE IS A QUESTION. An element whose own reasoning says `inferred` or
// `not stated` is refused into `open` (doctrine § 8): flagging a guess is not
// permission to ship it.
//
// Plain ESM. One import, the inflection the three resolvers share.

import { modelName, camel } from '@frontierjs/toolbelt/inflect'
import { ACTORS, ENTITY, PATTERN } from './catalog.js'
import { TYPES } from './types.js'

export const RUNGS = {
  catalog:  'the entity IS a catalog entry, under the entry\'s own name',
  variant:  'a catalog entry under the domain\'s name, or one kind of it (Candidate is a Contact)',
  property: 'not a concept: the rows of a relation (a membership, a join) — two links and little else',
  novel:    'genuinely new — the catalog has nothing it collapses to, and `why` says what was tried',
}

export const RISKS = {
  rename:    'a wrong answer costs a rename',
  migration: 'a wrong answer costs a migration',
  access:    'a wrong answer is an access hole or lost data',
}

// What the scaffold already declares. An answer names none of these again.
export const RESERVED = ['User', 'Notification', 'Credential', 'Session', 'Verification', 'LoginChallenge', 'OauthFlow']

// Columns the emitter writes on every model, or on a model with a kind or a
// lifecycle. An answer that declares one collides with the emitter.
const EMITTED = ['id', 'createdAt', 'updatedAt']

// A move is called by name next to the service's own methods.
const MOVE_RESERVED = ['create', 'read', 'update', 'delete', 'find', 'findMany', 'list', 'get', 'remove', 'restore', 'aggregate', 'patch', 'save', 'count', 'transition', 'transitions']

// The states a status field names. A free enum under one of these names is
// the lifecycle the doctrine says to declare (§ 5).
const STATE_NAMES = ['status', 'state', 'stage', 'phase']

const IDENT = /^[a-z][a-zA-Z0-9]*$/
const an = (name) => `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`
const VALUE = /^[a-z][a-z0-9_]*$/
const GUESS = /\binferred\b|\bnot (explicitly )?stated\b/i

// A json default as the JSON text of an object or an array, or null. An answer
// is JSON, so it says `{}` as a value, and the catalog's field spec says it as
// the text `=[]`.
function jsonDefault(v) {
  let doc = v
  if (typeof v === 'string') { try { doc = JSON.parse(v) } catch { return null } }
  return doc !== null && typeof doc === 'object' ? JSON.stringify(doc) : null
}

/**
 * Every rule `checkAnswer` holds, with what it says. `brief.js` renders this
 * table for the model, so the prompt and the grader are one list.
 */
export const RULES = {
  shape:       'The answer is `{ summary, actors, entities, open }` and every entity carries name, rung and why.',
  name:        'An entity name is PascalCase singular, unique, and never one the scaffold declares (User, Notification, and auth\'s own).',
  catalog:     '`from` names a catalog entry that is not reserved, and `kind`/`kinds` are kinds that entry lists.',
  rung:        'The rung agrees with `from`: catalog means the entry\'s own name, variant a different name or a kind, novel and property have no `from`, and a novel entity is not named like a catalog entry.',
  collapse:    'An entity with `from` says what the collapse costs and the escape if it turns out wrong.',
  inferred:    'Anything whose own reasoning says inferred or not stated goes in `open`, never in the answer. So does what you left out: `why` argues for what is in the answer, and an omission is a question in `open`.',
  field:       'A field has a camelCase name no other column on the entity has, a type from the type table, and an enum has two or more lowercase values.',
  state:       'A field named status, state, stage or phase with more than two values is a lifecycle, not an enum field.',
  document:    'A required json field states the document a new row starts with as `default`, `{}` or `[]`, unless it is `system`: no form a person fills can type JSON, so without one nobody can create the row.',
  link:        'A link names an entity in the answer or User; a link to User names the actor reaching the row through it, and a link to anything else names none.',
  lifecycle:   `A lifecycle has two or more states, each move names states it declares, every state is reachable from the first, and move names are camelCase, unique, and none of ${MOVE_RESERVED.join(', ')}.`,
  access:      'Every entity names who reaches a row: an actor link to User, `via` a required link to a parent, a `members` entity, or `public`/`shared` with a reason.',
  members:     'A `members` entity has a required link back to the container and a link to User.',
  pattern:     'A cited pattern is one the catalog lists.',
}

/** @typedef {{ rule: string, at: string, message: string }} Finding */

/**
 * Grade an answer. `ok` is false when anything was refused, and then `plan` is
 * null: an emitter writing from a refused answer writes the refusal into a
 * schema.
 *
 * `findings` are the access-grade facts the doctrine says to state together
 * and first (§ 10) — every public read, every unauthenticated write, every
 * table every signed-in user reads. They refuse nothing.
 *
 * @param {any} answer
 * @returns {{ ok: boolean, refusals: Finding[], findings: Finding[], plan: Plan|null }}
 */
export function checkAnswer(answer) {
  /** @type {Finding[]} */
  const refusals = []
  /** @type {Finding[]} */
  const findings = []
  const refuse = (rule, at, message) => refusals.push({ rule, at, message })
  const find = (rule, at, message) => findings.push({ rule, at, message })

  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    refuse('shape', '', 'The answer is a JSON object.')
    return { ok: false, refusals, findings, plan: null }
  }
  const entities = Array.isArray(answer.entities) ? answer.entities : null
  if (!entities?.length) {
    refuse('shape', 'entities', 'The answer names at least one entity.')
    return { ok: false, refusals, findings, plan: null }
  }
  if (answer.actors != null && !Array.isArray(answer.actors)) refuse('shape', 'actors', '`actors` is a list.')
  if (answer.open != null && !Array.isArray(answer.open)) refuse('shape', 'open', '`open` is a list of questions.')
  for (const [i, a] of (Array.isArray(answer.actors) ? answer.actors : []).entries()) {
    if (!a?.name || !ACTORS[a?.archetype]) refuse('shape', `actors[${i}]`, `An actor is { name, archetype, who }, and archetype is one of ${Object.keys(ACTORS).join(', ')}.`)
  }

  const names = new Map()
  for (const [i, e] of entities.entries()) {
    if (e?.name) names.set(e.name, i)
  }

  /** @type {Model[]} */
  const models = []

  for (const [i, e] of entities.entries()) {
    const at = e?.name ? e.name : `entities[${i}]`
    if (!e || typeof e !== 'object') { refuse('shape', at, 'An entity is an object.'); continue }
    for (const key of ['name', 'rung', 'why']) {
      if (typeof e[key] !== 'string' || !e[key].trim()) refuse('shape', at, `An entity carries \`${key}\`.`)
    }
    if (typeof e.name !== 'string') continue

    // ── name ──
    if (modelName(e.name) !== e.name) refuse('name', at, `\`${e.name}\` is not PascalCase singular; the name three resolvers derive from it is \`${modelName(e.name)}\`.`)
    if (names.get(e.name) !== i) refuse('name', at, `\`${e.name}\` is declared twice.`)
    if (RESERVED.includes(e.name)) refuse('name', at, `\`${e.name}\` is declared by the scaffold already. ${ENTITY[e.name]?.reserved ?? ''}`.trim())

    // ── catalog and rung ──
    const base = e.from != null ? ENTITY[e.from] : null
    if (e.from != null) {
      if (!base) refuse('catalog', at, `\`from: ${e.from}\` is not a catalog entry. The entries are ${Object.keys(ENTITY).filter(n => !ENTITY[n].reserved).join(', ')}.`)
      else if (base.reserved) refuse('catalog', at, `\`from: ${e.from}\` is reserved: ${base.reserved}.`)
    }
    const kinds = e.kinds ?? (e.kind != null ? [e.kind] : [])
    if (!Array.isArray(kinds)) refuse('catalog', at, '`kinds` is a list.')
    else if (kinds.length && !base?.kinds) refuse('catalog', at, `\`${e.from ?? at}\` has no kinds to choose from.`)
    else for (const k of kinds) if (base?.kinds && !base.kinds.includes(k)) refuse('catalog', at, `\`${k}\` is not a kind of ${base.name}. Its kinds are ${base.kinds.join(', ')}.`)

    if (!RUNGS[e.rung]) refuse('rung', at, `The rung is one of ${Object.keys(RUNGS).join(', ')}.`)
    else if (e.from != null && !['catalog', 'variant'].includes(e.rung)) refuse('rung', at, `An entity with \`from\` is rung catalog or variant, not ${e.rung}.`)
    else if (e.from == null && ['catalog', 'variant'].includes(e.rung)) refuse('rung', at, `Rung ${e.rung} names the catalog entry it is: add \`from\`.`)
    else if (e.rung === 'catalog' && (e.name !== e.from || kinds.length === 1)) refuse('rung', at, `Rung catalog is the entry under its own name with no single kind; \`${e.name}\` from ${e.from}${kinds.length === 1 ? `:${kinds[0]}` : ''} is a variant.`)
    else if (e.from == null && ENTITY[e.name] && !ENTITY[e.name].reserved) refuse('rung', at, `\`${e.name}\` is a catalog entry: say \`from: ${e.name}\`, or name the novel thing for what it is.`)

    if (base && !base.reserved && e.rung === 'variant') {
      for (const key of ['cost', 'escape']) if (typeof e[key] !== 'string' || !e[key].trim()) refuse('collapse', at, `A variant of ${base.name} says its \`${key}\`: ${key === 'cost' ? 'what the collapse gives up' : 'the signal that it should split, and what it splits into'}.`)
    }
    for (const key of ['why', 'cost', 'escape']) if (typeof e[key] === 'string' && GUESS.test(e[key])) refuse('inferred', at, `\`${key}\` reads as a guess ("${e[key].match(GUESS)[0]}"). Ask it in \`open\` instead, and leave the element out until it is answered.`)

    if (e.risk != null && !RISKS[e.risk]) refuse('shape', at, `\`risk\` is one of ${Object.keys(RISKS).join(', ')}.`)
    for (const id of e.patterns ?? []) if (!PATTERN[id]) refuse('pattern', at, `\`${id}\` is not a catalog pattern. The patterns are ${Object.keys(PATTERN).join(', ')}.`)

    // ── fields ──
    const omit = e.omit ?? []
    if (!Array.isArray(omit)) refuse('field', at, '`omit` is a list of catalog field names.')
    for (const n of Array.isArray(omit) ? omit : []) if (!base?.fields.some(f => f.name === n)) refuse('field', at, `\`omit: ${n}\` is not a field of ${base?.name ?? 'a catalog entry'}.`)
    const kept = (base?.fields ?? []).filter(f => !omit.includes(f.name))
    const added = Array.isArray(e.fields) ? e.fields : []
    if (e.fields != null && !Array.isArray(e.fields)) refuse('field', at, '`fields` is a list.')

    /** @type {import('./catalog.js').Field[]} */
    const fields = []
    for (const [j, f] of [...kept, ...added].entries()) {
      const fat = `${at}.${f?.name ?? `fields[${j - kept.length}]`}`
      if (!f || typeof f.name !== 'string' || !IDENT.test(f.name)) { refuse('field', fat, 'A field has a camelCase name.'); continue }
      if (!TYPES[f.type]) { refuse('field', fat, `\`${f.type}\` is not a type. The types are ${Object.keys(TYPES).join(', ')}.`); continue }
      if (f.type === 'enum') {
        if (!Array.isArray(f.values) || f.values.length < 2) refuse('field', fat, 'An enum lists two or more values.')
        else for (const v of f.values) if (!VALUE.test(v)) refuse('field', fat, `\`${v}\` is not a lowercase value; write it as ${camel(String(v)).toLowerCase() || 'a lowercase word'}.`)
        if (f.default != null && !f.values?.includes(f.default)) refuse('field', fat, `The default \`${f.default}\` is not one of the values.`)
        if (STATE_NAMES.includes(f.name) && f.values?.length > 2) refuse('state', fat, `\`${f.name}\` names ${f.values.length} states of one thing. Declare it as the entity's \`lifecycle\` with the moves between them, so a move nobody declared is refused.`)
      } else if (f.values != null) refuse('field', fat, 'Only an enum lists values.')
      if (typeof f.why === 'string' && GUESS.test(f.why)) refuse('inferred', fat, `This field's reason reads as a guess. Ask it in \`open\` instead.`)
      if (f.type === 'json') {
        const doc = jsonDefault(f.default)
        if (f.default != null && doc == null) { refuse('document', fat, `The default of a json field is a document, \`{}\` or \`[]\` or one with content; \`${JSON.stringify(f.default)}\` is not one.`); continue }
        if (f.required && !f.system && doc == null) { refuse('document', fat, `\`${f.name}\` is a required json field, and no form a person fills can type JSON. State the document a new row starts with, \`default: {}\` or \`default: []\`, or mark it \`system\` if the application writes it.`); continue }
        // The emitter writes a string default as `@default("…")`, which is the
        // spelling a Json column takes its document in.
        if (doc != null) { fields.push({ ...f, default: doc }); continue }
      }
      fields.push(f)
    }

    // ── links ──
    const links = []
    for (const [j, l] of (Array.isArray(e.links) ? e.links : []).entries()) {
      const lat = `${at}.${l?.name ?? `links[${j}]`}`
      if (!l || typeof l.name !== 'string' || !IDENT.test(l.name)) { refuse('link', lat, 'A link has a camelCase name.'); continue }
      if (l.to !== 'User' && !names.has(l.to)) { refuse('link', lat, `\`to: ${l.to}\` is not an entity in this answer, or User.`); continue }
      if (l.to === 'User') {
        if (!ACTORS[l.actor] || l.actor === 'system') { refuse('link', lat, `A link to User names the actor reaching the row through it: ${Object.keys(ACTORS).filter(a => a !== 'system').join(', ')}.`); continue }
      } else if (l.actor != null) { refuse('link', lat, `Only a link to User names an actor; \`${l.name}\` reaches ${l.to}, whose own rows name theirs.`); continue }
      if (l.to === e.name && l.required) { refuse('link', lat, 'A required link to the entity itself can never be satisfied by the first row. Make it optional.'); continue }
      if (typeof l.why === 'string' && GUESS.test(l.why)) refuse('inferred', lat, 'This link\'s reason reads as a guess. Ask it in `open` instead.')
      links.push({ name: l.name, to: l.to, actor: l.actor, required: !!l.required, why: l.why })
    }

    // ── lifecycle ──
    let life = null
    if (e.lifecycle === 'catalog') {
      const byKind = base?.lifecycles && kinds.length === 1 ? base.lifecycles[kinds[0]] : null
      life = byKind ?? base?.lifecycle ?? null
      if (!life) refuse('lifecycle', at, base?.lifecycles
        ? `${base.name}'s lifecycle depends on its kind; name one kind, or write the lifecycle out. Kinds with one: ${Object.keys(base.lifecycles).join(', ')}.`
        : `${base?.name ?? at} has no catalog lifecycle; write the states and moves out.`)
    } else if (e.lifecycle != null) {
      life = readLifecycle(e.lifecycle, `${at}.lifecycle`, refuse)
    }

    // ── collisions ──
    const columns = new Map()
    const claim = (name, what) => {
      if (columns.has(name)) refuse('field', `${at}.${name}`, `\`${name}\` is both ${columns.get(name)} and ${what}.`)
      else columns.set(name, what)
    }
    for (const n of EMITTED) claim(n, 'a column every model gets')
    if (kinds.length > 1) claim('kind', 'the kind column')
    if (life) claim(life.field, 'the lifecycle column')
    for (const f of fields) claim(f.name, 'a field')
    for (const l of links) { claim(l.name, 'a link'); claim(`${l.name}Id`, `the key of link \`${l.name}\``) }

    models.push({
      name: e.name, from: base && !base.reserved ? base.name : null, kinds, rung: e.rung,
      why: e.why, cost: e.cost, escape: e.escape, risk: e.risk,
      fields, links, lifecycle: life, access: e.access ?? {}, patterns: e.patterns ?? [],
      members: null, container: null,
    })
  }

  // ── access, which reads across entities ──
  const byName = new Map(models.map(m => [m.name, m]))
  for (const m of models) {
    const a = m.access
    const at = m.name
    if (typeof a !== 'object' || Array.isArray(a)) { refuse('access', at, '`access` is an object.'); continue }
    for (const key of Object.keys(a)) if (!['via', 'members', 'public', 'publicWhen', 'shared', 'system', 'why'].includes(key)) refuse('access', at, `\`access.${key}\` is not an access word. The words are via, members, public, publicWhen, shared, system, why.`)
    if (a.via != null) {
      const l = m.links.find(x => x.name === a.via)
      if (!l || l.to === 'User') refuse('access', at, `\`via: ${a.via}\` names a link to another entity of this answer.`)
      else if (!l.required) refuse('access', at, `\`via: ${a.via}\` is an optional link, and a row naming no parent passes a delegation to it: every signed-in caller reads it. Make the link required, or reach the row another way.`)
    }
    if (a.members != null) {
      const mm = byName.get(a.members)
      const back = mm?.links.find(x => x.to === m.name && x.required)
      const user = mm?.links.find(x => x.to === 'User')
      if (!mm || !back || !user) refuse('members', at, `\`members: ${a.members}\` names an entity with a required link to ${m.name} and a link to User.`)
      else if (mm.container) refuse('members', at, `${a.members} is already the membership of ${mm.container.model}.`)
      else {
        m.members = { model: mm.name, link: back.name, user: user.name }
        mm.container = { model: m.name, link: back.name, user: user.name }
        if (mm.access.public || mm.access.shared || mm.access.members) refuse('members', mm.name, `${mm.name} is the membership of ${m.name}, which decides who reads and changes it; it declares no public, shared or members of its own.`)
      }
    }
    const pub = a.public == null ? [] : a.public
    if (!Array.isArray(pub) || pub.some(op => !['read', 'create'].includes(op))) refuse('access', at, '`public` is a list of `read` and `create`.')
    if (a.shared != null && (typeof a.shared !== 'string' || !a.shared.trim())) refuse('access', at, '`shared` is the reason every signed-in user reads every row.')
    if (a.shared && pub.length) refuse('access', at, 'An entity is public or shared, not both.')
    if (pub.length && !(typeof a.why === 'string' && a.why.trim())) refuse('access', at, 'Public access says `why` — it is the fact most likely to be wrong.')
    if (a.publicWhen != null) {
      if (!pub.includes('read')) refuse('access', at, '`publicWhen` narrows a public read; declare `public: ["read"]`.')
      else if (typeof a.publicWhen !== 'object' || Array.isArray(a.publicWhen)) refuse('access', at, '`publicWhen` is `{ field: value }`.')
      else for (const [k, v] of Object.entries(a.publicWhen)) {
        const f = m.fields.find(x => x.name === k)
        const states = m.lifecycle?.field === k ? m.lifecycle.states : f?.type === 'enum' ? f.values : null
        if (!f && !states) refuse('access', at, `\`publicWhen.${k}\` is not a field of ${m.name}.`)
        else if (states && !states.includes(v)) refuse('access', at, `\`publicWhen.${k}\` is \`${v}\`, which is not one of ${states.join(', ')}.`)
        else if (!states && f.type !== 'bool') refuse('access', at, `\`publicWhen\` compares a bool, an enum or the lifecycle; \`${k}\` is ${f.type}.`)
      }
    }
    if (a.system != null && typeof a.system !== 'boolean') refuse('access', at, '`system` is true when only the application writes the rows.')
  }
  for (const m of models) {
    const a = m.access
    const reachers = m.links.filter(l => l.to === 'User')
    const reads = reachers.length || a.via || m.members || m.container || (a.public ?? []).includes('read') || a.shared
    const open = (x) => x && (x.access.shared || ((x.access.public ?? []).includes('read') && !x.access.publicWhen))
    if (a.via) {
      const parent = byName.get(m.links.find(l => l.name === a.via)?.to)
      if (open(parent)) refuse('access', m.name, `\`via: ${a.via}\` delegates to ${parent.name}, which every caller reads, so a delegation to it admits everybody. Say \`shared\` or \`public\` on ${m.name} itself if that is meant, or reach the row another way.`)
    }
    if (m.members && open(m)) refuse('members', m.name, `${m.name} is read by everybody, so its membership decides nothing. Drop \`members\` or the open read.`)
    const creates = m.links.some(l => l.to === 'User' && ACTORS[l.actor].may.includes('create')) || a.via || m.container || (a.public ?? []).includes('create') || a.system || a.shared
    if (!creates) refuse('access', m.name, `Nobody creates ${an(m.name)}. Name who does: an owner, author or coordinator link to User, \`via\` a parent, \`public: ["create"]\` with a reason, or \`system\` when only the application writes it.`)
    if (!reads) refuse('access', m.name, `Nobody reaches ${an(m.name)} row. Name who does: a link to User through an actor, \`via\` a required link to a parent, a \`members\` entity, or \`public\`/\`shared\` with a reason. A signed-in level alone lets every user read every other user's rows.`)
    // A delegation chain that closes on itself compiles to a predicate no row satisfies.
    const seen = [m.name]
    let cur = m
    while (cur?.access?.via) {
      const next = byName.get(cur.links.find(l => l.name === cur.access.via)?.to)
      if (!next) break
      if (seen.includes(next.name)) { refuse('access', m.name, `\`via\` loops: ${[...seen, next.name].join(' → ')}.`); break }
      seen.push(next.name)
      cur = next
    }
    const pub = a.public ?? []
    const because = a.why ? ` — ${a.why}` : ''
    if (pub.includes('create')) find('access', m.name, `Anyone, signed in or not, creates ${an(m.name)}: an unauthenticated write${because}.`)
    if (pub.includes('read')) find('access', m.name, `Anyone, signed in or not, reads ${a.publicWhen ? `${an(m.name)} where ${Object.entries(a.publicWhen).map(([k, v]) => `${k} is ${v}`).join(' and ')}` : `every ${m.name}`}${because}.`)
    if (a.shared) find('access', m.name, `Every signed-in user reads every ${m.name}, and only an administrator writes one: ${a.shared}`)
    if (a.system) find('access', m.name, `Only the application writes ${an(m.name)}.`)
  }

  const ok = refusals.length === 0
  const plan = ok ? {
    summary: typeof answer.summary === 'string' ? answer.summary : '',
    actors: Array.isArray(answer.actors) ? answer.actors : [],
    open: Array.isArray(answer.open) ? answer.open.filter(q => typeof q === 'string') : [],
    models,
    findings,
  } : null
  return { ok, refusals, findings, plan }
}

/**
 * @typedef {{
 *   name: string, from: string|null, kinds: string[], rung: string,
 *   why: string, cost?: string, escape?: string, risk?: string,
 *   fields: import('./catalog.js').Field[],
 *   links: { name: string, to: string, actor?: string, required: boolean, why?: string }[],
 *   lifecycle: import('./catalog.js').Lifecycle|null,
 *   access: { via?: string, members?: string, public?: string[], publicWhen?: Record<string, any>, shared?: string, system?: boolean, why?: string },
 *   patterns: string[],
 *   members: { model: string, link: string, user: string }|null,
 *   container: { model: string, link: string, user: string }|null,
 * }} Model
 * @typedef {{ summary: string, actors: any[], open: string[], models: Model[], findings: Finding[] }} Plan
 */

function readLifecycle(raw, at, refuse) {
  if (typeof raw !== 'object' || Array.isArray(raw)) { refuse('lifecycle', at, 'A lifecycle is `"catalog"` or `{ field, states, moves }`.'); return null }
  const field = raw.field ?? 'status'
  if (!IDENT.test(field)) refuse('lifecycle', at, `\`${field}\` is not a camelCase field name.`)
  const states = Array.isArray(raw.states) ? raw.states : []
  if (states.length < 2) { refuse('lifecycle', at, 'A lifecycle has two or more states; one state is a constant.'); return null }
  for (const s of states) if (!VALUE.test(s)) refuse('lifecycle', at, `\`${s}\` is not a lowercase state name.`)
  if (new Set(states).size !== states.length) refuse('lifecycle', at, 'A state is listed twice.')
  const initial = raw.initial ?? states[0]
  if (!states.includes(initial)) refuse('lifecycle', at, `\`initial: ${initial}\` is not one of the states.`)
  const moves = []
  const moveNames = new Set()
  for (const [j, mv] of (Array.isArray(raw.moves) ? raw.moves : []).entries()) {
    const mat = `${at}.moves[${j}]`
    if (!mv || typeof mv.name !== 'string' || !IDENT.test(mv.name)) { refuse('lifecycle', mat, 'A move has a camelCase name.'); continue }
    if (MOVE_RESERVED.includes(mv.name)) refuse('lifecycle', mat, `\`${mv.name}\` is a service method's name; call the move what the person does (approve, ship, cancel).`)
    if (moveNames.has(mv.name)) refuse('lifecycle', mat, `\`${mv.name}\` is declared twice; one move may leave several states: \`from: [a, b]\`.`)
    moveNames.add(mv.name)
    const from = mv.from === '*' ? states.filter(s => s !== mv.to) : Array.isArray(mv.from) ? mv.from : [mv.from]
    for (const s of [...from, mv.to]) if (!states.includes(s)) refuse('lifecycle', mat, `\`${s}\` is not one of the states.`)
    if (from.includes(mv.to)) refuse('lifecycle', mat, `\`${mv.name}\` moves ${mv.to} to itself.`)
    if (mv.by != null && mv.by !== 'system') refuse('lifecycle', mat, '`by` is `system` for a move the application makes, or absent.')
    moves.push({ name: mv.name, from, to: mv.to, ...(mv.by === 'system' ? { by: 'system' } : {}) })
  }
  if (!moves.length) refuse('lifecycle', at, 'A lifecycle declares its moves; states nobody moves between are an enum.')
  const reach = new Set([initial])
  for (let grew = true; grew;) {
    grew = false
    for (const mv of moves) if (!reach.has(mv.to) && mv.from.some(s => reach.has(s))) { reach.add(mv.to); grew = true }
  }
  const stranded = states.filter(s => !reach.has(s))
  if (stranded.length) refuse('lifecycle', at, `No move reaches ${stranded.join(', ')} from ${initial}.`)
  return { field, states, initial, moves }
}
