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
// (fjs-prototypes/charter, Phase 1).
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
// Plain ESM. Two imports: the inflection the three resolvers share, and the
// ISO 4217 table `@money` reads its scale from.

import { modelName, camel } from '@frontierjs/toolbelt/inflect'
import { isKnownCurrency } from '@frontierjs/toolbelt/units'
import { ACTORS, ENTITY, PATTERN, UNLINKED_ACTORS } from './catalog.js'
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

// The types a full-text index reads: stored as the text a person typed. A
// secret is ciphertext and a tag list is JSON, so neither matches a word.
const SEARCHABLE = ['text', 'longtext', 'markdown', 'email', 'url', 'phone', 'slug']

// The columns each of an answer's switches writes on an entity.
const SOFT_DELETE = 'deletedAt'
const CUSTOM = 'customFields'
const CURRENCY = 'currency'

// The ops `shared.ops` may hand every signed-in user.
const SHARED_OPS = ['read', 'create', 'update', 'delete']

const IDENT = /^[a-z][a-zA-Z0-9]*$/
// `Page.body`: a column of another entity, which is a move, not a rename.
const MOVED = /^[A-Z][A-Za-z0-9]*\.[a-z][a-zA-Z0-9]*$/
export const an = (name) => `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`
// FJS-D1748: an enum value is camelCase, the spelling fli check's
// enum-value-case grades the emitted schema by -- two spellings never settle.
const VALUE = IDENT
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
  shape:       'The answer is `{ summary, currency, actors, entities, open }` and every entity carries name, rung and why.',
  name:        'An entity name is PascalCase singular, unique, and never one the scaffold declares (User, Notification, and auth\'s own).',
  catalog:     '`from` names a catalog entry that is not reserved, and `kind`/`kinds` are kinds that entry lists.',
  rung:        'The rung agrees with `from`: catalog means the entry\'s own name, variant a different name or a kind, novel and property have no `from`, and a novel entity is not named like a catalog entry.',
  collapse:    'An entity with `from` says what the collapse costs and the escape if it turns out wrong.',
  inferred:    'Anything whose own reasoning says inferred or not stated goes in `open`, never in the answer. So does what you left out: `why` argues for what is in the answer, and an omission is a question in `open`.',
  field:       'A field has a camelCase name no other column on the entity has, a type from the type table, and an enum has two or more camelCase values.',
  state:       'A field named status, state, stage or phase with more than two values is a lifecycle, not an enum field.',
  document:    'A required json field states the document a new row starts with as `default`, `{}` or `[]`, unless it is `system`: no form a person fills can type JSON, so without one nobody can create the row.',
  link:        'A link names an entity in the answer or User; a link to User names the actor reaching the row through it, and a link to anything else names none.',
  lifecycle:   `A lifecycle has two or more states, each move names states it declares, every state is reachable from the first, and move names are camelCase, unique, and none of ${MOVE_RESERVED.join(', ')}.`,
  access:      'Every entity names who reaches a row: an actor link to User, `via` a required link to a parent, a `members` entity, or `public`/`shared` with a reason. `shared` is a reason, or `{ reason, ops }` to hand every signed-in user those ops (always including `read`); a write op is refused on an entity under a tenant container.',
  members:     'A `members` entity has a required link back to the container and a link to User.',
  roles:       'A container\'s `roles` is `{ update: [...] }` beside `members`, naming values of the membership\'s `role` enum: the members holding one rename the container, decide who is in it and change the rows under it, and the person whose sign-up creates it holds the first. A container without it leaves its membership to the application, and that person holds the role column\'s default. An entity `via` such a container may say `roles: { update: [...], delete: [...] }` to limit that write to members holding one of those roles, in place of the container\'s own rule; it is the container itself in `via`, never a parent of a parent. A lifecycle move takes `by: "finance"` or `by: ["finance", "admin"]` for the same limit on that move alone; a move is never a key of `roles`.',
  pattern:     'A cited pattern is one the catalog lists.',
  rename:      'A field says `was` only when it is the same column under a new name: the camelCase name the app has now, which no column of the entity holds under the new schema and no other field claims. It names a field you added, never a catalog field. Content moving from one entity into another is not carried yet: the answer says `risk: migration` with an `escape`, and asks in `open` whether the old values may go.',
  backfill:    'A field or link you add to an entity whose rows already exist says `backfill` with the value those rows take: a field `{ value }`, a constant of its type, and a link `{ first: true }`, the first row of the entity it links to. Never on a catalog field, beside `was`, or on a link to User.',
  currency:    '`currency` is one ISO 4217 code, or a list of them when each row with money names its own; the first is the default.',
  fts:         '`fts` lists fields of the entity a person types text into: text, longtext, markdown, email, url, phone or slug.',
  extensible:  '`extensible` names the entity of this answer whose rows declare the fields: required `model` and `key` text fields and a required `type` enum, and not extensible itself.',
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
  // One currency for every amount, or the list a row picks from.
  const codes = answer.currency == null ? ['USD'] : Array.isArray(answer.currency) ? answer.currency : [answer.currency]
  if (!codes.length || codes.some(c => typeof c !== 'string' || c !== c.toUpperCase() || !isKnownCurrency(c))) refuse('currency', 'currency', `\`currency\` is an ISO 4217 code such as USD, EUR or JPY, or a list of them; ${JSON.stringify(answer.currency)} is not.`)
  else if (new Set(codes).size !== codes.length) refuse('currency', 'currency', '`currency` lists a code twice.')
  const perRow = Array.isArray(answer.currency) && codes.length > 1
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
    /** @type {{ op: 'rename', model: string, from: string, to: string }[]} */
    const renames = []
    /** @type {Operation[]} */
    const backfills = []
    for (const [j, f] of [...kept, ...added].entries()) {
      const fat = `${at}.${f?.name ?? `fields[${j - kept.length}]`}`
      if (!f || typeof f.name !== 'string' || !IDENT.test(f.name)) { refuse('field', fat, 'A field has a camelCase name.'); continue }
      if (!TYPES[f.type]) { refuse('field', fat, `\`${f.type}\` is not a type. The types are ${Object.keys(TYPES).join(', ')}.`); continue }
      if (f.type === 'enum') {
        if (!Array.isArray(f.values) || f.values.length < 2) refuse('field', fat, 'An enum lists two or more values.')
        else for (const v of f.values) if (!VALUE.test(v)) refuse('field', fat, `\`${v}\` is not a camelCase value; write it as ${camel(String(v)) || 'a camelCase word'}.`)
        if (f.default != null && !f.values?.includes(f.default)) refuse('field', fat, `The default \`${f.default}\` is not one of the values.`)
        if (STATE_NAMES.includes(f.name) && f.values?.length > 2) refuse('state', fat, `\`${f.name}\` names ${f.values.length} states of one thing. Declare it as the entity's \`lifecycle\` with the moves between them, so a move nobody declared is refused.`)
      } else if (f.values != null) refuse('field', fat, 'Only an enum lists values.')
      if (typeof f.why === 'string' && GUESS.test(f.why)) refuse('inferred', fat, `This field's reason reads as a guess. Ask it in \`open\` instead.`)
      if (f.was != null) {
        if (j < kept.length) refuse('rename', fat, 'A catalog field has no former name; `was` belongs on a field you added.')
        else if (typeof f.was === 'string' && MOVED.test(f.was)) refuse('rename', fat, `\`was: ${f.was}\` moves a column from another entity, and no migration carries a move yet. Leave \`was\` off, say \`risk: migration\` on ${e.name} with an \`escape\` naming what the old values become, and ask in \`open\` whether they may go.`)
        else if (typeof f.was !== 'string' || !IDENT.test(f.was)) refuse('rename', fat, '`was` is the camelCase name the column has in the app now.')
        else if (f.was === f.name) refuse('rename', fat, '`was` is the field\'s own name, which is not a rename.')
        else if (renames.some(r => r.from === f.was)) refuse('rename', fat, `\`was: ${f.was}\` is claimed by two fields; one column becomes one field.`)
        else renames.push({ op: 'rename', model: e.name, from: f.was, to: f.name })
      }
      if (f.backfill != null) {
        const b = f.backfill
        if (j < kept.length) refuse('backfill', fat, 'A catalog field takes its rows\' values from the catalog; `backfill` belongs on a field you added.')
        else if (f.was != null) refuse('backfill', fat, 'A renamed field keeps the values it had; `was` and `backfill` are never both said.')
        else if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).join() !== 'value') refuse('backfill', fat, 'A field\'s `backfill` is `{ value }`: the constant every row already there takes.')
        else if (!['string', 'number', 'boolean'].includes(typeof b.value) || (typeof b.value === 'number' && !Number.isFinite(b.value))) refuse('backfill', fat, '`backfill.value` is a string, a number or a boolean.')
        else if (f.type === 'json') refuse('backfill', fat, 'A json field\'s rows take its `default`, not a backfill.')
        else if (f.type === 'enum' && !f.values?.includes(b.value)) refuse('backfill', fat, `\`backfill.value\` \`${b.value}\` is not one of the values.`)
        else backfills.push({ op: 'backfill', model: e.name, field: f.name, value: b.value })
      }
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
        if (!ACTORS[l.actor] || UNLINKED_ACTORS.includes(l.actor)) { refuse('link', lat, `A link to User names the actor reaching the row through it: ${Object.keys(ACTORS).filter(a => !UNLINKED_ACTORS.includes(a)).join(', ')}.`); continue }
      } else if (l.actor != null) { refuse('link', lat, `Only a link to User names an actor; \`${l.name}\` reaches ${l.to}, whose own rows name theirs.`); continue }
      if (l.to === e.name && l.required) { refuse('link', lat, 'A required link to the entity itself can never be satisfied by the first row. Make it optional.'); continue }
      if (typeof l.why === 'string' && GUESS.test(l.why)) refuse('inferred', lat, 'This link\'s reason reads as a guess. Ask it in `open` instead.')
      if (l.backfill != null) {
        // The first User would reach every existing row through an actor link.
        if (l.to === 'User') { refuse('backfill', lat, 'A link to User is never backfilled: the first User would reach every row already there. Make the link optional, or ask in `open` who those rows belong to.'); continue }
        const b = l.backfill
        if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).join() !== 'first' || b.first !== true) { refuse('backfill', lat, 'A link\'s `backfill` is `{ first: true }`: every row already there links to the first row of the entity it names.'); continue }
        backfills.push({ op: 'backfill', model: e.name, field: `${l.name}Id`, first: l.to })
      }
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

    // ── what it keeps: a trash, a search index, fields a tenant declares ──
    if (e.softDelete != null && typeof e.softDelete !== 'boolean') refuse('shape', at, '`softDelete` is true when a removed row goes to a trash it can be restored from.')
    const fts = e.fts == null ? [] : e.fts
    if (!Array.isArray(fts)) refuse('fts', at, '`fts` is a list of field names.')
    else for (const n of fts) {
      const f = fields.find(x => x.name === n)
      if (!f) refuse('fts', at, `\`fts: ${n}\` is not a field of ${e.name}.`)
      else if (!SEARCHABLE.includes(f.type)) refuse('fts', at, `\`fts: ${n}\` is ${f.type}; a search reads ${SEARCHABLE.join(', ')}.`)
    }
    if (Array.isArray(fts) && new Set(fts).size !== fts.length) refuse('fts', at, '`fts` lists a field twice.')
    if (e.extensible != null && (typeof e.extensible !== 'string' || !names.has(e.extensible))) refuse('extensible', at, `\`extensible\` names the entity of this answer that declares ${e.name}'s fields.`)
    const money = fields.some(f => f.type === 'money') && perRow

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
    if (e.softDelete === true) claim(SOFT_DELETE, 'when a row was removed to the trash')
    if (typeof e.extensible === 'string') claim(CUSTOM, 'the fields a tenant declares')
    if (money) claim(CURRENCY, 'the currency each amount is in')
    // The old name leaves the schema. A column of that name still on the entity
    // would make the rename a second column, and migrate create refuses it.
    for (const r of renames) if (columns.has(r.from)) refuse('rename', `${at}.${r.to}`, `\`was: ${r.from}\` is still ${columns.get(r.from)} of ${e.name}, so the schema would hold both and this is not a rename.`)

    models.push({
      name: e.name, from: base && !base.reserved ? base.name : null, kinds, rung: e.rung,
      why: e.why, cost: e.cost, escape: e.escape, risk: e.risk,
      fields, links, lifecycle: life, access: e.access ?? {}, patterns: e.patterns ?? [],
      softDelete: e.softDelete === true, fts: Array.isArray(fts) ? fts : [],
      extensible: typeof e.extensible === 'string' ? e.extensible : null, currency: money ? CURRENCY : null,
      renames, backfills, members: null, container: null, reach: null, opRoles: {},
    })
  }

  // ── access, which reads across entities ──
  const byName = new Map(models.map(m => [m.name, m]))

  // The declaring entity is found by litestone's convention, so its columns
  // are checked here rather than left to a parse error the model cannot read.
  for (const m of models) {
    if (!m.extensible) continue
    const d = byName.get(m.extensible)
    if (!d) continue
    const has = (n, types) => d.fields.some(f => f.name === n && f.required && types.includes(f.type))
    if (d === m) refuse('extensible', m.name, `${m.name} cannot declare its own fields; name another entity.`)
    else if (d.extensible) refuse('extensible', m.name, `${d.name} declares ${m.name}'s fields, so it is not extensible itself.`)
    else if (!has('model', ['text']) || !has('key', ['text']) || !has('type', ['enum'])) refuse('extensible', m.name, `${d.name} declares fields, so it has a required \`model\` text field (the entity a field is on), a required \`key\` text field and a required \`type\` enum.`)
  }
  for (const m of models) {
    const a = m.access
    const at = m.name
    if (typeof a !== 'object' || Array.isArray(a)) { refuse('access', at, '`access` is an object.'); continue }
    for (const key of Object.keys(a)) if (!['via', 'members', 'roles', 'public', 'publicWhen', 'shared', 'system', 'why'].includes(key)) refuse('access', at, `\`access.${key}\` is not an access word. The words are via, members, roles, public, publicWhen, shared, system, why.`)
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
        const admins = readAdmins(a.roles, mm, at, refuse)
        m.members = { model: mm.name, link: back.name, user: user.name, admins }
        mm.container = { model: m.name, link: back.name, user: user.name, admins }
        if (mm.access.public || mm.access.shared || mm.access.members) refuse('members', mm.name, `${mm.name} is the membership of ${m.name}, which decides who reads and changes it; it declares no public, shared or members of its own.`)
      }
    }
    const pub = a.public == null ? [] : a.public
    if (!Array.isArray(pub) || pub.some(op => !['read', 'create'].includes(op))) refuse('access', at, '`public` is a list of `read` and `create`.')
    if (a.shared != null) {
      const sh = a.shared
      const reason = typeof sh === 'string' ? sh : sh && typeof sh === 'object' && !Array.isArray(sh) ? sh.reason : null
      const ops = typeof sh === 'string' ? ['read'] : sh?.ops
      if (typeof reason !== 'string' || !reason.trim()) refuse('access', at, '`shared` is the reason every signed-in user reads every row, or `{ reason, ops }`.')
      else if (typeof sh === 'object' && (Object.keys(sh).some(k => !['reason', 'ops'].includes(k)) || !Array.isArray(ops) || !ops.length || ops.some(op => !SHARED_OPS.includes(op)) || new Set(ops).size !== ops.length)) refuse('access', at, `\`shared\` is \`{ reason, ops }\` with \`ops\` a list of ${SHARED_OPS.join(', ')}, each once.`)
      else if (!ops.includes('read')) refuse('access', at, '`shared.ops` names `read`: a write every signed-in user holds on rows they cannot all read would let them change rows they cannot see. List `read` beside the writes.')
      else {
        // One spelling below this line: the reason as text, the ops as a list.
        m.access = { ...a, shared: reason, sharedOps: ops }
      }
    }
    if (a.shared && pub.includes('read')) refuse('access', at, 'A public read already covers every signed-in user; `shared` adds nothing. A visitor who files a row every signed-in user reads is `public: ["create"]` with `shared`.')
    const sharedWrites = (m.access.sharedOps ?? []).filter(op => op !== 'read')
    for (const op of sharedWrites) if (pub.includes(op)) refuse('access', at, `\`public\` already lets anyone ${op}; naming ${op} in \`shared.ops\` adds nothing.`)
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

  // ── roles: which members reach a write, or a move ──
  for (const m of models) {
    const a = m.access
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue
    m.reach = reachOf(m, byName)
    if (a.members == null && a.roles != null) {
      const at = m.name
      const names = new Set(m.lifecycle?.moves.map(mv => mv.name))
      if (m.container) refuse('roles', at, `${m.name} is the membership of ${m.container.model}: its writes belong to the roles in the container's \`roles.update\`, so it takes no \`roles\` of its own.`)
      else if (typeof a.roles !== 'object' || Array.isArray(a.roles)) refuse('roles', at, '`roles` is `{ update: [...], delete: [...] }`: the membership roles that make that write.')
      else for (const [op, list] of Object.entries(a.roles)) {
        if (names.has(op)) refuse('roles', at, `\`roles.${op}\` names a lifecycle move, and a move's role goes on the move: \`by: "role"\` or \`by: ["role", ...]\` on ${op}.`)
        else if (!ROLE_OPS.includes(op)) refuse('roles', at, `\`roles.${op}\` is not an op. \`roles\` is \`{ update: [...], delete: [...] }\`.`)
        else if (!Array.isArray(list) || !list.length) refuse('roles', at, `\`roles.${op}\` lists one or more membership roles.`)
        else {
          const roles = grantable(m, list, `roles.${op}`, byName, refuse)
          if (roles) m.opRoles[op] = roles
        }
      }
    }
    for (const mv of m.lifecycle?.moves ?? []) {
      if (mv.roles) grantable(m, mv.roles, `${mv.name}'s \`by\``, byName, refuse, `${m.name}.${mv.name}`)
    }
  }
  for (const m of models) {
    const a = m.access
    const reachers = m.links.filter(l => l.to === 'User')
    const reads = reachers.length || a.via || m.members || m.container || (a.public ?? []).includes('read') || a.shared
    const open = (x) => x && (x.access.shared || ((x.access.public ?? []).includes('read') && !x.access.publicWhen))
    // @@allow(op, true) has no tenant test: a write every signed-in user holds
    // reaches every tenant's rows under a container.
    if (a.sharedOps?.length > 1 && tenanted(m, byName)) refuse('access', m.name, `\`shared.ops\` hands every signed-in user ${a.sharedOps.filter(op => op !== 'read').join(' and ')} on ${m.name}, which sits under a tenant container; the rule has no tenant test, so one tenant changes another's rows. Keep \`shared\` read-only and let the actor links or \`via\` hold the writes.`)
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
    if (a.shared) {
      // emit gives a write a link holds to gate 4 under an @@allow naming only
      // that link, and no gate level is exempt from a row policy: the
      // administrator holds the ops no link, and no `shared.ops`, names.
      const held = a.sharedOps ?? ['read']
      const who = new Map()
      for (const op of ['create', 'update', 'delete']) {
        if (held.includes(op)) continue
        const holders = m.links.filter(l => l.to === 'User' && ACTORS[l.actor]?.may.includes(op)).map(l => `its ${l.name}`)
        const key = pub.includes(op) ? 'anyone' : holders.length ? holders.join(' or ') : 'an administrator'
        who.set(key, [...(who.get(key) ?? []), op])
      }
      const clauses = [...who].map(([key, ops]) => ops.length === 3 ? `${key} writes one` : `${key} ${ops.map(op => `${op}s`).join(' or ')} one`)
      const verbs = held.map(op => `${op}s`)
      const everyone = `Every signed-in user ${verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} and ${verbs.at(-1)}` : verbs[0]} every ${m.name}`
      find('access', m.name, `${everyone}${clauses.length ? `, and ${who.size === 1 && who.has('an administrator') && held.length === 1 ? 'only ' : ''}${clauses.join(', and ')}` : ''}: ${a.shared}`)
    }
    if (a.system) find('access', m.name, `Only the application writes ${an(m.name)}.`)
    const named = Object.keys(m.opRoles)
    if (named.length === 1 && m.reach && !byName.get(m.reach.container).members.admins) {
      const other = ROLE_OPS.find(op => op !== named[0])
      find('access', m.name, `${m.name} limits ${named[0]} to ${m.opRoles[named[0]].join(' or ')}, and ${other} stays with whoever may change ${m.reach.container}: no role administers it, so that is every member who can read it. Say \`roles.${other}\` too if ${other} is a role's.`)
    }
    if (m.members && !m.members.admins) find('access', m.name, `No member administers ${an(m.name)}: only the application adds, removes or re-roles ${m.members.model} rows${a.system ? ', and the person whose sign-up creates it holds the role column\'s default' : ''}. Say \`roles: { update: [...] }\` to name the roles that do.`)
  }

  const ok = refusals.length === 0
  const plan = ok ? {
    summary: typeof answer.summary === 'string' ? answer.summary : '',
    currency: codes,
    actors: Array.isArray(answer.actors) ? answer.actors : [],
    open: Array.isArray(answer.open) ? answer.open.filter(q => typeof q === 'string') : [],
    models,
    operations: models.flatMap(m => [...m.renames, ...m.backfills]),
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
 *   access: { via?: string, members?: string, roles?: { update?: string[], delete?: string[] }, public?: string[], publicWhen?: Record<string, any>, shared?: string|{ reason: string, ops: string[] }, sharedOps?: string[], system?: boolean, why?: string },
 *   patterns: string[],
 *   softDelete: boolean, fts: string[], extensible: string|null, currency: string|null,
 *   renames: Operation[], backfills: Operation[],
 *   members: { model: string, link: string, user: string, admins: string[]|null }|null,
 *   container: { model: string, link: string, user: string, admins: string[]|null }|null,
 *   reach: { link: string|null, container: string }|null,
 *   opRoles: { update?: string[], delete?: string[] },
 * }} Model
 * A row-keeping operation `litestone migrate create` takes (`FJS-D603`).
 * `split` joins this union in the second pass (`FJS-D683`).
 * @typedef {{ op: 'rename', model: string, from: string, to: string }
 *   | { op: 'backfill', model: string, field: string, value: string|number|boolean }
 *   | { op: 'backfill', model: string, field: string, first: string }} Operation
 * @typedef {{ summary: string, currency: string[], actors: any[], open: string[], models: Model[], operations: Operation[], findings: Finding[] }} Plan
 */

// Whether a row sits under a container whose members are its tenants: it is
// the container, its membership, or reaches one through `via`.
function tenanted(m, byName) {
  for (let cur = m, seen = new Set(); cur && !seen.has(cur.name); cur = byName.get(cur.links.find(l => l.name === cur.access.via)?.to)) {
    if (cur.members || cur.container) return true
    seen.add(cur.name)
    if (!cur.access.via) break
  }
  return false
}

const ROLE_OPS = ['update', 'delete']

// The membership container a row's roles are tested against, and the one
// relation hop to it: none on the container itself, the container link on
// its membership, the `via` link on a child whose parent is the container.
// litestone takes one to-one hop before `.some` and refuses a second.
function reachOf(m, byName) {
  if (m.members) return { link: null, container: m.name }
  if (m.container) return { link: m.container.link, container: m.container.model }
  const parent = byName.get(m.links.find(l => l.name === m.access.via)?.to)
  return parent?.members ? { link: m.access.via, container: parent.name } : null
}

// The role names a write or a move may be limited to: values of the reached
// container's membership `role` enum. `label` is what the answer said.
function grantable(m, roles, label, byName, refuse, at = m.name) {
  if (!m.reach) {
    const ancestors = []
    for (let cur = byName.get(m.links.find(l => l.name === m.access.via)?.to); cur && !ancestors.includes(cur.name); cur = byName.get(cur.links.find(l => l.name === cur.access.via)?.to)) {
      ancestors.push(cur.name)
      if (cur.members) { refuse('roles', at, `${label} names membership roles, and ${m.name} reaches ${cur.name}'s members through ${ancestors.slice(0, -1).join(' → ')}: more than one hop before the membership, which litestone refuses. Say \`via\` the container itself, or let ${m.name} delegate.`); return null }
    }
    refuse('roles', at, `${label} names membership roles, and ${m.name} reaches no membership container: it is not the container, its membership, or \`via\` an entity with \`members\`.`)
    return null
  }
  const container = byName.get(m.reach.container)
  const mm = byName.get(container.members.model)
  const role = mm.fields.find(f => f.name === 'role' && f.type === 'enum')
  if (!role) { refuse('roles', at, `${label} names values of ${mm.name}'s \`role\` enum, and ${mm.name} has no \`role\` enum field.`); return null }
  if (roles.some(r => typeof r !== 'string')) { refuse('roles', at, `${label} lists role names.`); return null }
  const unknown = roles.filter(v => !role.values?.includes(v))
  if (unknown.length) { refuse('roles', at, `${label} names ${unknown.join(', ')}, which ${mm.name}'s \`role\` is not: it is one of ${role.values.join(', ')}.`); return null }
  return [...new Set(roles)]
}

// The roles whose members administer a container, or null when the answer
// names none. Null leaves every membership write to the application: a member
// test with no role in it let any member add, remove and re-role anyone,
// themselves included (FJS-1799).
function readAdmins(roles, mm, at, refuse) {
  if (roles == null) return null
  const role = mm.fields.find(f => f.name === 'role' && f.type === 'enum')
  if (typeof roles !== 'object' || Array.isArray(roles) || Object.keys(roles).some(k => k !== 'update')) refuse('roles', at, '`roles` is `{ update: [...] }`: the membership roles that rename the container and decide who is in it.')
  else if (!Array.isArray(roles.update) || !roles.update.length) refuse('roles', at, '`roles.update` lists one or more membership roles.')
  else if (!role) refuse('roles', at, `\`roles\` names values of ${mm.name}'s \`role\` enum, and ${mm.name} has no \`role\` enum field.`)
  else {
    const unknown = roles.update.filter(v => !role.values?.includes(v))
    if (unknown.length) refuse('roles', at, `\`roles.update\` names ${unknown.join(', ')}, which ${mm.name}'s \`role\` is not: it is one of ${role.values.join(', ')}.`)
    else return [...new Set(roles.update)]
  }
  return null
}

function readLifecycle(raw, at, refuse) {
  if (typeof raw !== 'object' || Array.isArray(raw)) { refuse('lifecycle', at, 'A lifecycle is `"catalog"` or `{ field, states, moves }`.'); return null }
  const field = raw.field ?? 'status'
  if (!IDENT.test(field)) refuse('lifecycle', at, `\`${field}\` is not a camelCase field name.`)
  const states = Array.isArray(raw.states) ? raw.states : []
  if (states.length < 2) { refuse('lifecycle', at, 'A lifecycle has two or more states; one state is a constant.'); return null }
  for (const s of states) if (!VALUE.test(s)) refuse('lifecycle', at, `\`${s}\` is not a camelCase state name; write it as ${camel(String(s)) || 'a camelCase word'}.`)
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
    // A role is tested against the membership the row reaches, which only the
    // access pass can see; here it is the shape that is graded.
    const roles = typeof mv.by === 'string' ? [mv.by] : mv.by
    if (mv.by != null && mv.by !== 'system' && (!Array.isArray(roles) || !roles.length || roles.some(r => typeof r !== 'string' || r === 'system'))) refuse('lifecycle', mat, '`by` is `system` for a move the application makes, a membership role or a list of roles for a move only those members make, or absent.')
    moves.push({ name: mv.name, from, to: mv.to, ...(mv.by === 'system' ? { by: 'system' } : mv.by != null && Array.isArray(roles) ? { roles } : {}) })
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
