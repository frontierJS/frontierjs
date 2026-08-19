/**
 * junction/field-rules.js — schema → field rules, and checking a record.
 *
 * Split out of resource.js deliberately. resource.js imports the Junction
 * client, which reaches the router and therefore a `.mesa` component — so
 * anything living there can only be loaded by a bundler. These functions are
 * pure and depend on nothing but the schema registry, which keeps them usable
 * from a plain Node/Bun script: that is what lets the client rules and
 * Junction's server rules be compared directly, from one .lite file, instead of
 * being asserted against a copy of each other.
 *
 * The rules described here are the ones Litestone's generateJsonSchema actually
 * emits. This is not a general JSON Schema validator and should not grow into
 * one — if a keyword is not in the generator's output, it does not belong here.
 */

import { resolveRef, modelNameFor } from './schema-registry.js'
import { DIRECTIVE_PARAMS }          from '@frontierjs/toolbelt/directives'
import { derefFieldSchema }          from '@frontierjs/toolbelt/jsonschema'

// `derefFieldSchema` is `@frontierjs/toolbelt/jsonschema`'s — the same walk
// jetty's resource needs, and one of the pure halves that moved to the
// substrate rather than being copied a second time (`FJS-059`). Re-exported
// here because this module is where every caller in this package already looks
// for it.
export { derefFieldSchema }

// ── Field rules ───────────────────────────────────────────────────────────────

/** Is this raw field schema allowed to hold null? */
function _isNullable(raw) {
  if (Array.isArray(raw.type)) return raw.type.includes('null')
  if (Array.isArray(raw.anyOf)) return raw.anyOf.some(d => d?.type === 'null')
  return false
}

const _CARRIED = [
  'format', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'default', 'description',
  // `readOnly` is what a computed / generated / `@from` / `@version` field
  // carries, and `contentMediaType` is where `@markdown` arrives. Both are
  // read by the control table below and by nothing else — a form has to know
  // that a value is not the caller's to write, and that a string is a document.
  'readOnly', 'contentMediaType',
  // `writeOnly` is `@transient`: a field the caller sends and no read ever
  // answers. It gets a control like any other writable field — that is the
  // point of declaring it — and this is what lets a form say so, and what stops
  // a detail view rendering a value that is never there.
  'writeOnly',
]

/**
 * Flatten a model definition into per-field rules the UI can read directly.
 *
 * This is the same information Junction compiles into its server-side
 * validator, resolved the same way — `$ref` followed, nullable unwrapped — so a
 * form can render a select from `fields.plan.enum` and mark `fields.plan.required`
 * without a second source of truth.
 *
 * @param {object} schema  a model definition ({ properties, required })
 * @param {(ref: string) => object|null} [resolve]
 * @returns {Record<string, object>} field name → { type, required, nullable, enum?, … }
 */
export function buildFieldRules(schema, resolve = resolveRef) {
  const properties = schema?.properties
  if (!properties || typeof properties !== 'object') return {}

  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const out = {}

  for (const [name, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    // nullable is read off the RAW schema: deref follows the non-null branch of
    // an anyOf, so by the time we have the target the null branch is gone.
    const nullable = _isNullable(raw)
    const def = derefFieldSchema(raw, resolve)

    let type = def.type
    if (Array.isArray(type)) type = type.find(t => t !== 'null')
    if (!type && Array.isArray(def.anyOf)) {
      type = def.anyOf.find(d => d && d.type !== 'null')?.type
    }

    const rule = { type: type ?? null, required: required.has(name), nullable }
    if (Array.isArray(def.enum)) rule.enum = def.enum
    for (const k of _CARRIED) if (k in def) rule[k] = def[k]

    // `title` is the FIELD's label (@label) and is read off the field's OWN
    // schema, never the deref'd target. Litestone titles every enum $def with
    // the type name, so following the ref would make `status OrderStatus`
    // introduce itself as "OrderStatus" in every message it appears in.
    if (typeof raw.title === 'string') rule.title = raw.title

    // Author-supplied wording, keyed by the JSON Schema keyword that failed —
    // `@length(3, 20, "…")` arrives as { length, minLength, maxLength }. Read
    // off the RAW schema as well as the deref'd one: a $ref'd field carries its
    // messages on the reference, beside `title`.
    const messages = { ...(def['x-messages'] ?? {}), ...(raw['x-messages'] ?? {}) }
    if (Object.keys(messages).length) rule.messages = messages

    out[name] = rule
  }

  // Mark foreign keys. `accountId` is emitted as a plain integer, so without
  // this a form generator renders a number input for what is a reference — the
  // one field where a picker is obviously right and a spinner obviously wrong.
  for (const rel of Object.values(buildRelations(schema))) {
    if (rel.type !== 'belongsTo') continue
    rel.foreignKeys.forEach((fk, i) => {
      if (!out[fk]) return
      out[fk].references = {
        model:    rel.model,
        field:    rel.references[i] ?? 'id',
        relation: rel.field,
      }
    })
  }

  return out
}

// ── Relations ─────────────────────────────────────────────────────────────────

/**
 * The model's relations, keyed by relation field name.
 *
 * Relations have no wire representation, so they are absent from `properties`
 * and `x-relations` is the only place they exist on the client. That became
 * load-bearing when implicit m2m fields were (correctly) removed from
 * properties: without reading this, `User.tags → Tag` is simply not knowable
 * in the browser.
 *
 *   { account: { field:'account', type:'belongsTo', model:'Account',
 *                foreignKeys:['accountId'], references:['id'],
 *                optional:false, onDelete:'Cascade' },
 *     tags:    { field:'tags', type:'m2m', model:'Tag' } }
 *
 * `model` is normalised to the name as declared in the .lite file, so it can be
 * handed straight to schemaFor() or used to name the related resource. It falls
 * back to whatever the schema said when the registry cannot resolve it.
 *
 * @param {object} schema  a model definition
 * @param {(...names: string[]) => string|null} [resolveName]
 */
export function buildRelations(schema, resolveName = modelNameFor) {
  const list = schema?.['x-relations']
  if (!Array.isArray(list)) return {}

  const out = {}
  for (const rel of list) {
    if (!rel?.field) continue

    const entry = {
      field: rel.field,
      type:  rel.type,
      model: resolveName?.(rel.model) ?? rel.model,
    }

    // Only belongsTo carries local FK columns; hasMany and m2m have none, and
    // emitting empty arrays for them would imply otherwise.
    if (rel.type === 'belongsTo') {
      entry.foreignKeys = Array.isArray(rel.fields) ? rel.fields : []
      entry.references  = Array.isArray(rel.references) ? rel.references : []
      entry.optional    = rel.optional ?? false
      if (rel.onDelete) entry.onDelete = rel.onDelete
    }

    out[rel.field] = entry
  }

  return out
}

// ── The control table ─────────────────────────────────────────────────────────
//
// One field rule → which control renders it. **This is the only place that
// mapping is written**, so a generated form and a hand-written one cannot
// disagree about what a `Float` is, and a UI package contributing a control for
// a type is an entry here rather than an `{#if}` ladder inside a component.
//
// It lives beside the rules rather than in the kit for the reason the rules do:
// this module imports nothing, so the table is readable from a plain Node
// script and from a component alike, and `@frontierjs/ui` does not have to
// depend on Sierra to render a form.
//
// The descriptor is deliberately thin. Everything a control can resolve for
// itself from `$context.form` — label, required, maxlength, `type="email"`,
// the error — is NOT repeated here; that resolution already has an owner and
// restating it is what this whole row exists to remove.

/** The one media type that says a string is a document rather than a line. */
const _MARKDOWN = 'text/markdown'

// ── Registered controls ───────────────────────────────────────────────────────
//
// The table above is the framework's answer, and it is deliberately small: a
// kit that ships five controls can only claim five kinds of column. Everything
// else — a `Json` document, a `String[]`, a `Decimal` an app renders as money,
// a rich text editor over `@markdown` — is a control somebody else owns, and
// until this registry existed there was nowhere to put it. `controlFor` was a
// switch inside a published package, so "contribute a control" meant forking
// Sierra.
//
// **A control is two registrations and they live in different packages**, which
// is a dependency rule rather than a taste: this module is a leaf that must run
// in plain Node, so it can name a control but cannot hold one. So the answer
// here is a NAME, and the kit binds that name to a component
// (`@frontierjs/ui/controls`). The name is also what makes the answer
// inspectable — `formFields()` is callable from a test, a prerender or a
// snapshot, where no component can be loaded at all.
//
// A resolver DECLINES by answering null, which is what keeps a registration
// narrow: an entry that claims everything is a bug in that entry and not
// something this module can grade.

/** name → resolve. Iteration order is registration order; consulted reversed. */
const _controls = new Map()

/**
 * Contribute a control.
 *
 *   registerControl('money', (rule) =>
 *     rule.type === 'number' && rule['x-litestone-kind'] === 'money' ? 'money' : null)
 *
 * `resolve(rule, ctx)` answers a control NAME, a full descriptor
 * (`{ control, …anything the component needs }`), or null to decline and let
 * the next entry — and finally the built-in table — answer. `ctx` is
 * `{ field, model }`: the column's name and the model it is on, which is what
 * lets an app claim one column rather than a type.
 *
 * **The last thing registered is the first thing asked**, so an app's own
 * registration beats a kit's: a kit registers when it is imported, and an app's
 * module body runs after its imports. Registering a name twice replaces the
 * first entry rather than stacking a second — a dev server re-evaluating a
 * module must not end up consulting three copies of it.
 *
 * @returns {() => void} the undo, for a test teardown or an HMR dispose
 */
export function registerControl(name, resolve) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('registerControl(name, resolve) — name must be a non-empty string')
  }
  if (typeof resolve !== 'function') {
    throw new TypeError(
      `registerControl('${name}') — resolve must be a function (rule, ctx) => name | descriptor | null`)
  }

  // Delete before set: a Map keeps insertion order, so re-registering has to
  // remove the old key or the entry keeps the position it first claimed.
  _controls.delete(name)
  _controls.set(name, resolve)

  return () => { if (_controls.get(name) === resolve) _controls.delete(name) }
}

/** Remove a registration by name. Answers whether there was one. */
export function unregisterControl(name) {
  return _controls.delete(name)
}

/** What is registered, in the order `controlFor` asks them. Diagnostics. */
export function registeredControls() {
  return [..._controls.keys()].reverse()
}

function _fromRegistry(rule, ctx) {
  if (!_controls.size) return null

  for (const [name, resolve] of [..._controls].reverse()) {
    let answer
    try {
      answer = resolve(rule, ctx)
    } catch (err) {
      // One bad resolver must not take every form in the app down with it, and
      // it must not do that quietly either.
      console.warn(`[field-rules] registered control '${name}' threw and was skipped — ${err?.message ?? err}`)
      continue
    }

    if (answer == null || answer === false) continue
    if (typeof answer === 'string') answer = { control: answer }

    if (typeof answer !== 'object' || Array.isArray(answer)) {
      console.warn(
        `[field-rules] registered control '${name}' answered ${typeof answer} — a resolver answers a ` +
        'control name, a descriptor object, or null to decline. Ignored.')
      continue
    }

    const claimed = answer.control
    if (claimed !== null && (typeof claimed !== 'string' || !claimed)) {
      console.warn(
        `[field-rules] registered control '${name}' answered a descriptor with no \`control\` name. ` +
        'Answer null to decline; `{ control: null, reason }` to say a field deliberately has none.')
      continue
    }

    // `by` is what makes an unrenderable field traceable: <Form> warns naming
    // the field, and the entry that claimed it is the next question.
    return { ...answer, by: name }
  }

  return null
}

/**
 * What the built-in table alone would answer, registrations ignored.
 *
 * Exported so a resolver can extend rather than restate — an entry that wants a
 * number input with its own `step` asks for the table's answer and adds to it,
 * which is how a contribution stays one line instead of a copy of the switch.
 */
export function defaultControlFor(rule) {
  return _builtinControl(rule)
}

/**
 * Which control this field gets.
 *
 *   { control: 'input'|'textarea'|'select'|'checkbox'|'picker'|'datetime'|null,
 *     type?, options?, model?, valueField?, relation?, reason? }
 *
 * `control: null` is an answer, not an omission — an array column, a `Json`
 * document and an unknown type have no control in this kit, and the caller is
 * expected to say so rather than drop the field silently. That silence is the
 * failure this table exists to prevent: a column added to `.lite` that simply
 * never appears on the form.
 *
 * A registered control is asked first and `by` names the one that answered;
 * `defaultControlFor` is this same table with the registry skipped.
 *
 * @param {object} rule  one entry from buildFieldRules()
 * @param {{field?: string, model?: string}} [ctx]  which column, on which model
 */
export function controlFor(rule, ctx = {}) {
  if (!rule || typeof rule !== 'object') return { control: null, reason: 'no rule' }

  // Not the caller's to write: @system, @computed, @generated, @from, @version.
  // Present in the schema so a client knows the field exists, absent from a
  // form — and NOT offered to the registry, because a control is a thing that
  // writes and the Data boundary refuses this column by name. A read-only value
  // shown on a form is a detail renderer wearing a control's clothes, and it
  // wants the surface that does not exist yet rather than this one.
  if (rule.readOnly) return { control: null, reason: 'readOnly' }

  const registered = _fromRegistry(rule, ctx)
  if (registered) return registered

  return _builtinControl(rule)
}

function _builtinControl(rule) {
  if (!rule || typeof rule !== 'object') return { control: null, reason: 'no rule' }
  if (rule.readOnly) return { control: null, reason: 'readOnly' }

  // A foreign key is the one field where a picker is obviously right and a
  // number spinner obviously wrong, and `references` is already derived.
  if (rule.references) {
    return {
      control:    'picker',
      model:      rule.references.model,
      valueField: rule.references.field,
      relation:   rule.references.relation,
    }
  }

  if (Array.isArray(rule.enum)) return { control: 'select', options: rule.enum }

  switch (rule.type) {
    case 'boolean':
      return { control: 'checkbox' }

    // Input resolves `type="number"` from the rule itself; `step` is the one
    // thing the schema does not say — how finely may this be nudged — so it is
    // stated here rather than derived.
    case 'integer':
      return { control: 'input', step: 1 }
    case 'number':
      return { control: 'input', step: 'any' }

    case 'string': {
      if (rule.contentMediaType === _MARKDOWN) return { control: 'textarea' }
      // A date has no zone, so `<input type="date">` round-trips it and the
      // plain input is right. A date-time DOES have one and `datetime-local`
      // has none — it accepts and emits a wall clock — so the two have to be
      // converted at each edge or the value shifts silently, in opposite
      // directions going in and coming out. That is a control rather than a
      // type attribute, which is why this row names one.
      if (rule.format === 'date') return { control: 'input', type: 'date' }
      if (rule.format === 'date-time') return { control: 'datetime' }
      return { control: 'input' }
    }

    case 'array':  return { control: null, reason: 'array — no control in the kit yet' }
    case 'object': return { control: null, reason: 'object — a Json column has no single control' }
    default:       return { control: null, reason: `no control for type ${rule.type ?? 'unknown'}` }
  }
}

/**
 * The form's field list, in schema order.
 *
 * The field SET is the last thing a form still restates about a model. A list
 * typed into a component drifts the way every duplicated list in this repo has
 * drifted — a column added to `.lite` does not appear, and nothing says so.
 *
 * `only` narrows and reorders (its order wins, because naming five fields is
 * also naming the order you want them in); `except` removes. A name in either
 * that the model does not have comes back as an `unknown` entry rather than
 * being ignored, for the same reason a missing control does.
 *
 * @param {Record<string, object>} fields  from buildFieldRules()
 * @param {{only?: string[], except?: string[], model?: string}} [opts]
 *   `model` is not a filter — it is handed to a registered control, so an app
 *   can claim one column on one model rather than a type everywhere.
 * @returns {Array<{name, rule, control, …}>}
 */
export function formFieldList(fields, { only, except, model } = {}) {
  const rules   = fields && typeof fields === 'object' ? fields : {}
  const known   = Object.keys(rules)
  const removed = new Set(Array.isArray(except) ? except : [])
  const names   = Array.isArray(only) && only.length ? only : known

  const out = []

  for (const name of names) {
    if (removed.has(name)) continue
    if (!(name in rules)) {
      out.push({ name, rule: null, control: null, reason: 'no such field on this model' })
      continue
    }
    out.push({ name, rule: rules[name], ...controlFor(rules[name], { field: name, model }) })
  }

  // An `except` naming a field that is not there is the same mistake as an
  // `only` that does — usually a rename that left the form behind.
  for (const name of removed) {
    if (!(name in rules)) out.push({ name, rule: null, control: null, reason: 'excluded, but no such field on this model' })
  }

  return out
}

/**
 * Which column of a related model a picker should SHOW.
 *
 * A foreign key holds an id and nobody recognises an id, so something has to
 * choose the human column. Nothing in `.lite` declares one today, so this is a
 * convention and it says so: the first of a few conventional names that exists
 * as a plain string column, then the first plain string column, then the value
 * itself. Pass `labelField` to state it and this is not consulted.
 *
 * One owner, because the alternative is every picker in every app choosing
 * differently — and a picker that shows `4` instead of `Ada Lovelace` is the
 * shape of bug nobody files.
 */
const _LABEL_FIELDS = ['name', 'title', 'label', 'displayName', 'reference', 'email', 'slug', 'code']

export function labelFieldFor(fields, fallback = 'id') {
  const rules = fields && typeof fields === 'object' ? fields : {}
  const plain = (r) => r?.type === 'string' && !r.enum && !r.references && !r.readOnly

  for (const name of _LABEL_FIELDS) if (plain(rules[name])) return name
  for (const [name, rule] of Object.entries(rules)) if (plain(rule)) return name
  return fallback
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/**
 * Service-method → gate operation. Litestone states four; the client speaks in
 * method names, so both spellings are accepted.
 *
 * `restore` maps to update: it modifies an existing row rather than creating or
 * destroying one.
 */
const _GATE_OP = {
  read: 'read', find: 'read', get: 'read',
  create: 'create',
  update: 'update', patch: 'update', restore: 'update',
  delete: 'delete', remove: 'delete',
}

/**
 * The model's `@@gate` levels, or null when it declares none.
 * @returns {{read:number, create:number, update:number, delete:number}|null}
 */
export function buildGate(schema) {
  const g = schema?.['x-gate']
  if (!g || typeof g !== 'object') return null
  return { read: g.read, create: g.create, update: g.update, delete: g.delete }
}

/**
 * Would `level` clear the gate for this operation?
 *
 * ⚠ A UI AFFORDANCE, NOT A SECURITY BOUNDARY. The gate is enforced at the data
 * layer by Litestone and turned into a status code by Junction; this only lets
 * the UI avoid offering a button that is going to 403. Never guard anything on
 * it that the server does not also guard.
 *
 * Unknown answers are permissive — no gate declared, no level supplied, an
 * operation the gate does not mention. Hiding a control the user could have
 * used is a worse and much quieter failure than showing one that errors, and
 * the server is the thing actually saying no.
 *
 * Levels are Litestone's 0–9 scale (STRANGER 0 … USER 4 … OWNER 6, SYSTEM 8).
 * A number is expected: mapping names to numbers here would be a hand-copy of
 * litestone's LEVELS and exactly the kind of duplicate that drifts.
 *
 * @param {object|null} gate       from buildGate()
 * @param {string} operation       'read'|'create'|'update'|'delete', or a
 *                                 service method name ('find', 'patch', …)
 * @param {number} level           the current user's gate level
 */
export function canAtLevel(gate, operation, level) {
  if (!gate) return true

  const op = _GATE_OP[operation] ?? operation
  const need = gate[op]
  if (typeof need !== 'number') return true
  if (typeof level !== 'number') return true

  return level >= need
}

// ── Transitions ───────────────────────────────────────────────────────────────

/**
 * The model's declared state machines, or null when it has none.
 *
 * Shape is litestone's `x-transitions`: keyed by field, then by transition name.
 * A model can declare more than one, so the field key is part of the answer, not
 * an implementation detail.
 *
 * @returns {Record<string, Record<string, {from:string[], to:string, gate:number|null}>>|null}
 */
export function buildTransitions(schema) {
  const t = schema?.['x-transitions']
  if (!t || typeof t !== 'object') return null
  return t
}

/**
 * The legal next states for `row`, each flagged with whether `level` may take it.
 *
 * ⚠ A UI AFFORDANCE, NOT A SECURITY BOUNDARY — same contract as canAtLevel().
 * Litestone enforces every one of these at the Data boundary and throws
 * TransitionViolationError / TransitionGateError regardless of what the client
 * decided to render. This exists so the UI can offer the right buttons, not so
 * it can decide who is allowed.
 *
 * Unknown answers are permissive: no gate on a transition, or no level supplied,
 * means `allowed: true`. A gated move the caller cannot make is still returned
 * with `allowed: false` rather than dropped — rendering it disabled is usually
 * better than making it vanish, and the caller can filter if it disagrees.
 *
 * Mirrors litestone's `db.<model>.transitions(row)` field for field.
 *
 * @param {object|null} spec   from buildTransitions()
 * @param {object} row         the record to evaluate
 * @param {number} [level]     the current user's gate level (0–9)
 */
export function transitionsAt(spec, row, level) {
  if (!spec || !row) return []

  const out = []
  for (const [field, transitions] of Object.entries(spec)) {
    const current = row[field]
    if (current == null) continue
    for (const [name, t] of Object.entries(transitions ?? {})) {
      if (!Array.isArray(t?.from) || !t.from.includes(current)) continue
      const gate    = t.gate ?? null
      const allowed = gate == null || typeof level !== 'number' ? true : level >= gate
      out.push({ name, field, from: current, to: t.to, gate, allowed })
    }
  }
  return out
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Thrown by a resource whose `validate` option is on. */
export class ResourceValidationError extends Error {
  constructor(service, errors) {
    super(errors.map(e => e.message).join(', '))
    this.name    = 'ResourceValidationError'
    this.service = service
    this.errors  = errors
  }
}

const _EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function _typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function _checkType(name, rule, value, errors) {
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') errors.push({ field: name, message: `${fieldLabel(name, rule)} must be a string` })
      return typeof value === 'string'
    case 'integer':
      if (!Number.isInteger(value)) errors.push({ field: name, message: `${fieldLabel(name, rule)} must be an integer` })
      return Number.isInteger(value)
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push({ field: name, message: `${fieldLabel(name, rule)} must be a number` })
        return false
      }
      return true
    case 'boolean':
      if (typeof value !== 'boolean') errors.push({ field: name, message: `${fieldLabel(name, rule)} must be a boolean` })
      return typeof value === 'boolean'
    case 'array':
      if (!Array.isArray(value)) errors.push({ field: name, message: `${fieldLabel(name, rule)} must be an array` })
      return Array.isArray(value)
    case 'object':
      if (_typeOf(value) !== 'object') errors.push({ field: name, message: `${fieldLabel(name, rule)} must be an object` })
      return _typeOf(value) === 'object'
    default:
      // No type constraint — Json columns are emitted as {}. Anything goes.
      return true
  }
}

/**
 * What to call a field in a message.
 *
 * `title` is `@label("Customer")`. Failing that, a foreign key borrows its
 * relation's name, so `customerId` reads as "customer" with nothing authored —
 * which is the common case, and the one where the raw column name under a form
 * label that says "customer" looks most like a bug.
 */
export function fieldLabel(name, rule) {
  return rule?.title ?? rule?.references?.relation ?? name
}

/**
 * The message for a failed rule: whatever the schema declared for it, else the
 * generated sentence. `keyword` is the JSON Schema keyword that failed, which
 * is exactly how `x-messages` is keyed — no mapping table on this side.
 */
function _say(rule, keyword, fallback) {
  return rule?.messages?.[keyword] ?? fallback
}

const _required = (name, rule) =>
  _say(rule, 'required', `${fieldLabel(name, rule)} is required`)

function _checkConstraints(name, rule, value, errors) {
  const label = fieldLabel(name, rule)
  const add = (message) => errors.push({ field: name, message })
  const say = (keyword, fallback) => add(_say(rule, keyword, fallback))

  if (rule.enum && !rule.enum.includes(value)) {
    say('enum', `${label} must be one of: ${rule.enum.join(', ')}`)
  }

  if (typeof value === 'string') {
    if (rule.minLength != null && value.length < rule.minLength) say('minLength', `${label} must be at least ${rule.minLength} characters`)
    if (rule.maxLength != null && value.length > rule.maxLength) say('maxLength', `${label} must be at most ${rule.maxLength} characters`)
    if (rule.pattern) {
      let re = null
      try { re = new RegExp(rule.pattern) } catch { re = null }
      if (re && !re.test(value)) say('pattern', `${label} is not in the expected format`)
    }
    if (rule.format === 'email' && !_EMAIL.test(value)) say('format', `${label} must be a valid email address`)
    if (rule.format === 'uri') {
      try { new URL(value) } catch { say('format', `${label} must be a valid URL`) }
    }
    if (rule.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      say('format', `${label} must be a valid date`)
    }
  }

  if (typeof value === 'number') {
    if (rule.minimum != null && value < rule.minimum) say('minimum', `${label} must be at least ${rule.minimum}`)
    if (rule.maximum != null && value > rule.maximum) say('maximum', `${label} must be at most ${rule.maximum}`)
    if (rule.exclusiveMinimum != null && value <= rule.exclusiveMinimum) say('exclusiveMinimum', `${label} must be greater than ${rule.exclusiveMinimum}`)
    if (rule.exclusiveMaximum != null && value >= rule.exclusiveMaximum) say('exclusiveMaximum', `${label} must be less than ${rule.exclusiveMaximum}`)
  }

  if (Array.isArray(value)) {
    if (rule.minItems != null && value.length < rule.minItems) say('minItems', `${label} must have at least ${rule.minItems} items`)
    if (rule.maxItems != null && value.length > rule.maxItems) say('maxItems', `${label} must have at most ${rule.maxItems} items`)
  }
}

/**
 * Check a record against field rules. Returns an array of
 * `{ field, message }` — empty when the record is acceptable.
 *
 * Deliberately not a general JSON Schema validator: it covers exactly what
 * Litestone's generator emits, and it mirrors Junction's semantics so a record
 * that passes here is not then rejected by the server for a different reason.
 * In particular `required` means "not null and not absent" — an empty string
 * satisfies a required String, exactly as it does server-side.
 *
 * An array is validated element-wise, and each error carries the row `index` —
 * Junction accepts a bulk create, so this has to as well.
 *
 * @param {Record<string, object>} fields  from buildFieldRules()
 * @param {object|object[]} data
 * @param {'create'|'patch'|'update'} [mode]  patch skips absent fields entirely
 */
export function validateAgainstFields(fields, data, mode = 'create') {
  if (Array.isArray(data)) {
    return data.flatMap((row, index) =>
      validateAgainstFields(fields, row, mode).map(e => ({ ...e, index })))
  }

  const errors = []
  const isPatch = mode === 'patch' || mode === 'update'
  const record  = data ?? {}

  for (const [name, rule] of Object.entries(fields ?? {})) {
    const present = Object.prototype.hasOwnProperty.call(record, name)

    if (!present) {
      if (!isPatch && rule.required) errors.push({ field: name, message: _required(name, rule) })
      continue
    }

    const value = record[name]

    if (value == null) {
      // An explicit null on a required field is the enum case: make() leaves a
      // required enum unset because no blank value is a member of it.
      if (rule.required) errors.push({ field: name, message: _required(name, rule) })
      continue
    }

    if (_checkType(name, rule, value, errors)) {
      _checkConstraints(name, rule, value, errors)
    }
  }

  return errors
}

// ── Version ───────────────────────────────────────────────────────────────────

/**
 * The name of the model's `@version` column, or null when it declares none.
 *
 * `x-version` is a single string rather than a flag because the column is
 * named in the schema and a client has to send that exact key back. It is the
 * one piece of the optimistic-concurrency contract the browser needs: the
 * comparison happens at the Data boundary and the client cannot check anything
 * — its whole job is to return the value it was given.
 *
 * The field is also emitted `readOnly` in the update schema, which is what stops
 * a generated form rendering a number input for it.
 */
export function buildVersion(schema) {
  const v = schema?.['x-version']
  return typeof v === 'string' && v ? v : null
}

/**
 * Did this failure mean *the row moved under you*?
 *
 * A 409 alone cannot answer it. Litestone throws two of them and they want
 * opposite words: `VersionConflictError` / `TransitionConflictError` are races
 * (`retryable: true` — re-read and try again), while `TransitionViolationError`
 * is a domain refusal (`retryable: false` — "you cannot ship a cancelled
 * order"), whose own message is the right thing to show. Junction carries
 * `retryable` on the wire for exactly this, and both transports land it at
 * `err.data.retryable`.
 */
export function isStaleWrite(err) {
  if (!err || typeof err !== 'object') return false
  const code = err.code ?? err.status ?? err.data?.code
  if (code !== 409) return false
  return err.retryable === true || err.data?.retryable === true
}

/** The sentence a form shows for a stale write. Exported so an app can match or replace it. */
export const STALE_WRITE_MESSAGE =
  'This record changed while you were editing it. Reload to see the current version, then try again.'

/**
 * The two revisions behind a stale write — the one the caller submitted, and the
 * one the row is at now. `null` for anything that is not a race, and for a race
 * whose error did not carry them.
 *
 * `STALE_WRITE_MESSAGE` is what a form shows; this is what a screen offering
 * *reload* or *overwrite* needs, and it is the half a status cannot express.
 * Litestone's `VersionConflictError` builds the payload, junction's error
 * boundary carries it, and it lands two `data`s deep for the same reason a
 * server 400's field list does — each hop wraps once.
 *
 * @param {unknown} err
 * @returns {{ model: string|null, field: string|null, expected: unknown, actual: unknown }|null}
 */
export function toConflict(err) {
  if (!isStaleWrite(err)) return null
  const payload = err?.data?.data ?? err?.data ?? null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const { model, field, expected, actual } = payload
  // Both halves or neither: one number alone cannot say what moved.
  if (expected === undefined || actual === undefined) return null
  return { model: model ?? null, field: field ?? null, expected, actual }
}

// ── Thrown value → per-field messages ─────────────────────────────────────────

/**
 * Pull the `{ field, message }[]` out of whatever was thrown.
 *
 * There are three shapes and they are all the same list wearing a different
 * number of wrappers, because each hop adds one:
 *
 *   err.errors        ResourceValidationError — the browser said no, no request
 *                     was made, and the list is the property it was built with.
 *   err.data.data     A server 400. Junction's validator throws
 *                     `BadRequest(joined, list)`; `toJSON()` puts the list on
 *                     `data`; the browser client assigns the whole parsed body
 *                     to `.data` on the Error it throws. So the list is two
 *                     `data`s deep, and it looks like a typo. It is not.
 *   err.data          The same list one wrapper shallower — a FrameworkError
 *                     caught in-process, or a transport that unwrapped once.
 *
 * Anything else is a failure with no field information: a 500, a dropped
 * socket, a thrown string. That is not an empty result, it is a form-level
 * message, which is why this returns both halves.
 *
 * @param {unknown} err
 * @returns {{ fields: Record<string,string>, message: string }}
 *   `fields` is keyed for direct use as `<Field errors={…}>`; `message` is the
 *   form-level line, and is empty when the failure was entirely per-field.
 */
export function toFieldErrors(err) {
  const fields = {}
  let message  = ''

  // A lost-update race has no field to blame and its raw message names a column
  // and two integers. Say the thing the person can act on instead.
  if (isStaleWrite(err)) return { fields, message: STALE_WRITE_MESSAGE }

  for (const e of _errorList(err)) {
    const field = typeof e === 'object' && e !== null ? e.field : null
    const text  = (typeof e === 'object' && e !== null ? e.message : e) ?? ''
    if (!text) continue

    // '_' is what Junction's validator reports for "Expected an object" — a
    // failure of the whole payload, which no field can render.
    if (!field || field === '_') {
      if (!message) message = String(text)
      continue
    }
    // First message per field wins. A field can fail two rules at once (absent
    // AND wrong type is not possible, but too-short AND wrong format is), and
    // one line under one control is what there is room for.
    if (!(field in fields)) fields[field] = String(text)
  }

  // Nothing per-field — fall back to the error's own message so the form has
  // something true to say rather than a silent no-op submit.
  if (!message && Object.keys(fields).length === 0) {
    message = (err && typeof err === 'object' && 'message' in err)
      ? String(err.message)
      : String(err ?? 'Request failed')
  }

  return { fields, message }
}

function _errorList(err) {
  if (!err || typeof err !== 'object') return []
  if (Array.isArray(err.errors))    return err.errors
  if (Array.isArray(err.data))      return err.data
  if (Array.isArray(err.data?.data)) return err.data.data
  return []
}

// ── Coercion ──────────────────────────────────────────────────────────────────

/**
 * Cast the strings a DOM control produces into the types the schema declares.
 *
 * `<input type="number">` and `<select>` both hand back strings — `el.value` is
 * a string for every control there is, and Mesa's bindInput passes it through
 * unchanged (correctly: it has no idea what the field is). So a form bound to
 * `make()` sends `value: "42"` for a `Float` and `accountId: "1"` for an `Int`,
 * and the schema-derived validator rejects both. Only the schema knows what they
 * were meant to be, which is why this belongs here and not in Mesa.
 *
 * Conservative on purpose:
 *   - `''` is never coerced. `Number('')` is 0, and silently inventing a zero
 *     for an empty box is worse than the validation error. Blank handling is
 *     normalizeBlanks' job, and it runs after this.
 *   - A string that is not a clean number is left alone, so `validate()` can say
 *     so rather than passing NaN to the server.
 *   - Only string inputs are touched; a value already of the right type, or of
 *     some other type entirely, is left for validation to judge.
 *
 * Returns the same object when nothing changed.
 *
 * @param {Record<string, object>} fields  from buildFieldRules()
 * @param {object|object[]} data
 */
export function coerceToSchema(fields, data) {
  if (Array.isArray(data)) return data.map(row => coerceToSchema(fields, row))
  if (!data || typeof data !== 'object') return data

  let out = null
  const write = (name, value) => {
    if (out === null) out = { ...data }
    out[name] = value
  }

  for (const [name, rule] of Object.entries(fields ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(data, name)) continue

    const raw = data[name]
    if (typeof raw !== 'string' || raw === '') continue

    if (rule.type === 'integer') {
      if (/^[+-]?\d+$/.test(raw.trim())) write(name, Number(raw))
      continue
    }

    if (rule.type === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) write(name, n)
      continue
    }

    if (rule.type === 'boolean') {
      if (raw === 'true')  write(name, true)
      if (raw === 'false') write(name, false)
      continue
    }
  }

  return out ?? data
}

// ── Blank → null ──────────────────────────────────────────────────────────────

/**
 * Replace `''` with `null` on nullable fields.
 *
 * A text input cannot produce "no value" — an untouched box submits `''` — so a
 * form bound to make()'s output writes `''` into a column the schema said was
 * nullable. In SQLite those are not the same value:
 *
 *   - `String? @unique` accepts any number of NULLs, but a second `''` fails
 *     the constraint. A create that worked once then fails, from a default
 *     nobody wrote.
 *   - `WHERE col IS NULL` never matches `''`, so "records with no X" silently
 *     excludes everything the app created.
 *   - A record read back from the DB has `null` where a freshly made one has
 *     `''` — same logical state, two representations, so dirty-checking a form
 *     against its initial value reports a change nobody made.
 *
 * So the form keeps binding to a string and the wire carries the distinction
 * the schema actually made.
 *
 * Only NULLABLE fields are touched: `''` on a non-optional `String` is a real
 * empty string and nulling it would turn a valid record into an invalid one.
 * Only fields PRESENT in the record are touched — a patch is not widened. And
 * only the exact value `''`; whitespace is content, not blankness (trimming is
 * a separate decision, and not this function's).
 *
 * Returns the same object when nothing changed, so an unaffected payload is not
 * needlessly copied.
 *
 * @param {Record<string, object>} fields  from buildFieldRules()
 * @param {object|object[]} data
 */
export function normalizeBlanks(fields, data) {
  if (Array.isArray(data)) return data.map(row => normalizeBlanks(fields, row))
  if (!data || typeof data !== 'object') return data

  let out = null

  for (const [name, rule] of Object.entries(fields ?? {})) {
    // nullable ⇒ not required in everything Litestone generates, but a field
    // that were both would be made invalid by this, so say it explicitly.
    if (!rule.nullable || rule.required) continue
    if (!Object.prototype.hasOwnProperty.call(data, name)) continue
    if (data[name] !== '') continue

    if (out === null) out = { ...data }
    out[name] = null
  }

  return out ?? data
}

// ── Does this record belong in that query's results? ──────────────────────────
//
// A pushed record is an announcement about a row, not about a list. The store a
// `load(query)` filled means "the rows matching that query", so applying every
// event to it unconditionally is what let a row that LEFT the filter stay in the
// list, updated in place and quietly wrong (`FJS-011`).
//
// The question is answered here rather than on the server because the client
// already holds the constraint table, so a query-scoped subscription costs no
// registry, no re-run and no second transport — only the events for rows this
// list filtered out, which is bandwidth rather than correctness.
//
// The operators are exactly what Junction's `parseWhere` / `translateOps` accept
// and Litestone's `buildWhere` compiles — the `$`-prefixed wire spelling, and the
// bare Litestone spelling that reaches the same place through parseWhere's nested
// branch. Nothing more: a keyword the server cannot be sent does not belong here.
//
// Three answers, not two. A matcher forced to return a boolean has to guess about
// a filter it cannot see through — a `select` that dropped the filtered column, a
// filter naming a relation, `$search`, a raw clause — and guessing wrong is
// silent. `null` says *cannot decide*, and its caller asks the server again.

const _WIRE_OPS = {
  $in: 'in', $nin: 'notIn', $lt: 'lt', $lte: 'lte', $gt: 'gt', $gte: 'gte',
  $ne: 'not', $like: 'contains', $ilike: 'contains', $start: 'startsWith', $end: 'endsWith',
}

// The same operators under the names Litestone knows them by. An unprefixed
// operator block travels through `parseWhere` untouched (it only looks for a
// leading `$`), so both spellings reach `buildWhere` and both are legal here.
const _BARE_OPS = new Set([
  'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not', 'equals',
  'contains', 'startsWith', 'endsWith',
  'has', 'hasEvery', 'hasSome', 'hasNone', 'isEmpty',
])

// Filters whose answer is not in the record, so a pushed row cannot be graded
// against them: `$search` is an FTS5 index, `$onlyDeleted`/`$onlyTemplates` are
// visibility flags the record does not carry a decidable answer for (the marker
// column can be renamed, and this side holds no schema), `$raw` is SQL.
const _OPAQUE = new Set(['$search', '$onlyDeleted', '$onlyTemplates', '$raw'])

// Not filters at all — `parseQuery` destructures these out before `parseWhere`
// sees the rest. They ride in `query` only on the pre-directives fallback path.
//
// Read off the wire's own table rather than restated, because a Data-realm
// feature that grows a per-call option is otherwise a filter on a column nobody
// declared here, three layers from the cause (FJS-306). Only the decidability
// question above is this module's to answer.
const _DIRECTIVES = new Set(DIRECTIVE_PARAMS.filter(p => !_OPAQUE.has(p)))

/** Three-valued AND — false wins over unknown, unknown wins over true. */
function _and(a, b) {
  if (a === false || b === false) return false
  if (a === null  || b === null)  return null
  return true
}

function _not(v) {
  return v === null ? null : !v
}

/**
 * A query operand as the column would hold it. The wire is strings — a query
 * built from a URL or a form control sends `'5'` for an Int — and SQLite's type
 * affinity converts on comparison, so `WHERE id = '5'` matches row 5 and a
 * client matcher comparing `5 === '5'` would not.
 */
function _operand(rule, v) {
  if (v instanceof Date) return v.toISOString()
  if (typeof v !== 'string' || v === '') return v
  if (rule?.type === 'integer') return /^[+-]?\d+$/.test(v.trim()) ? Number(v) : v
  if (rule?.type === 'number')  { const n = Number(v); return Number.isFinite(n) ? n : v }
  if (rule?.type === 'boolean') {
    if (v === 'true')  return true
    if (v === 'false') return false
  }
  return v
}

/** `IN (…)` for a scalar column, `hasSome` for an array one — as the bare-array shorthand compiles. */
function _inList(rule, actual, list) {
  if (!Array.isArray(list)) return null
  const wanted = list.map(v => _operand(rule, v))
  if (Array.isArray(actual)) return actual.some(v => wanted.includes(v))
  return wanted.includes(actual)
}

// LIKE is case-insensitive for ASCII in SQLite, which is what makes `$like` and
// `$ilike` compile to the same `contains` on the server.
const _like = (actual, operand, test) =>
  actual == null ? false : test(String(actual).toLowerCase(), String(operand).toLowerCase())

function _matchOp(rule, actual, op, operand) {
  switch (op) {
    case 'in':     return _inList(rule, actual, operand)
    // NOT IN excludes NULL rows in SQLite, so Litestone ORs `IS NULL` back in.
    case 'notIn':  return operand?.length ? _not(_inList(rule, actual, operand)) : true
    case 'gt':     return actual == null ? false : actual >  _operand(rule, operand)
    case 'gte':    return actual == null ? false : actual >= _operand(rule, operand)
    case 'lt':     return actual == null ? false : actual <  _operand(rule, operand)
    case 'lte':    return actual == null ? false : actual <= _operand(rule, operand)
    case 'contains':   return _like(actual, operand, (a, b) => a.includes(b))
    case 'startsWith': return _like(actual, operand, (a, b) => a.startsWith(b))
    case 'endsWith':   return _like(actual, operand, (a, b) => a.endsWith(b))
    case 'equals':
      if (operand === null) return actual == null
      if (Array.isArray(operand)) {
        // The exact set, in order — the one place an array is not a membership test.
        if (!Array.isArray(actual)) return null
        return actual.length === operand.length && actual.every((v, i) => v === operand[i])
      }
      return actual === _operand(rule, operand)
    case 'not':
      if (operand === null) return actual != null
      if (Array.isArray(operand)) return operand.length ? _not(_inList(rule, actual, operand)) : true
      // `col != ?` is NULL, not true, on a NULL column.
      return actual == null ? false : actual !== _operand(rule, operand)
    case 'has':      return Array.isArray(actual) ? actual.includes(operand) : null
    case 'hasEvery': return Array.isArray(actual) ? operand.every(v => actual.includes(v)) : null
    case 'hasSome':  return Array.isArray(actual) ? operand.some(v => actual.includes(v))  : null
    case 'hasNone':  return Array.isArray(actual) ? !operand.some(v => actual.includes(v)) : null
    case 'isEmpty':  return Array.isArray(actual) ? (operand ? actual.length === 0 : actual.length > 0) : null
    default:         return null
  }
}

function _matchField(rule, actual, expected) {
  if (expected === null) return actual == null
  if (expected instanceof Date) return actual === expected.toISOString()
  if (Array.isArray(expected)) {
    // A bare array is membership, never equality — Prisma reads it the other way
    // and a schema ported from there filters wider than it did.
    return expected.length ? _inList(rule, actual, expected) : false
  }
  if (typeof expected !== 'object') return actual === _operand(rule, expected)

  if ('$null' in expected) return expected.$null ? actual == null : actual != null

  const keys = Object.keys(expected)
  if (!keys.length) return true

  // Every key an operator, or none of them: the same disambiguation the server
  // makes (`isTypedJsonPath`). Anything else is a path into a JSON document or a
  // filter over a relation, neither of which this record can answer.
  if (!keys.every(k => k in _WIRE_OPS || _BARE_OPS.has(k))) return null

  let verdict = true
  for (const k of keys) {
    verdict = _and(verdict, _matchOp(rule, actual, _WIRE_OPS[k] ?? k, expected[k]))
    if (verdict === false) return false
  }
  return verdict
}

/**
 * Does this record satisfy that query?
 *
 * @param {Record<string, object>} fields  from buildFieldRules(); `{}` still
 *        matches structurally, it just cannot convert a string operand
 * @param {object} record
 * @param {object} query  filters as they travel over the wire
 * @returns {true|false|null}  in the results, not in them, or undecidable
 */
export function matchesQuery(fields, record, query) {
  if (!query || typeof query !== 'object') return true
  if (!record || typeof record !== 'object') return null

  let verdict = true

  for (const [key, val] of Object.entries(query)) {
    if (val === undefined || _DIRECTIVES.has(key)) continue

    let one
    if (_OPAQUE.has(key)) {
      one = null
    } else if (key === '$or') {
      one = Array.isArray(val) ? _some(fields, record, val) : null
    } else if (key === '$and') {
      one = Array.isArray(val) ? _every(fields, record, val) : null
    } else if (key === '$not') {
      one = _not(matchesQuery(fields, record, val))
    } else if (key.startsWith('$')) {
      one = null   // an operator the server may know and this does not
    } else if (!(key in record)) {
      // A `select` that dropped the filtered column, or a filter naming a
      // relation — the row is here, the answer is not.
      one = null
    } else {
      one = _matchField(fields?.[key], record[key], val)
    }

    verdict = _and(verdict, one)
    if (verdict === false) return false
  }

  return verdict
}

function _some(fields, record, list) {
  let verdict = false
  for (const q of list) {
    const one = matchesQuery(fields, record, q)
    if (one === true) return true
    if (one === null) verdict = null
  }
  return verdict
}

function _every(fields, record, list) {
  let verdict = true
  for (const q of list) {
    verdict = _and(verdict, matchesQuery(fields, record, q))
    if (verdict === false) return false
  }
  return verdict
}

