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

/**
 * Follow a `$ref` (and the non-null branch of an `anyOf`) to the definition
 * that actually describes the field.
 *
 * Keywords written on the field itself win over the target's — a field's
 * `@default(pro)` is emitted alongside the `$ref`, and must not be shadowed by
 * anything on the enum definition.
 *
 * @param {object} def
 * @param {(ref: string) => object|null} resolve
 */
export function derefFieldSchema(def, resolve) {
  if (!def || typeof def !== 'object') return {}

  if (typeof def.$ref === 'string') {
    const { $ref, ...own } = def
    const target = resolve?.($ref)
    return target ? { ...target, ...own } : own
  }

  if (Array.isArray(def.anyOf)) {
    const nonNull = def.anyOf.find(d => d && d.type !== 'null')
    if (nonNull) {
      const inner = derefFieldSchema(nonNull, resolve)
      return 'default' in def ? { ...inner, default: def.default } : inner
    }
  }

  return def
}


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

