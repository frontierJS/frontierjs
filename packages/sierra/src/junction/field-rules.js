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
import { levelPasses, canAtLevel }   from '@frontierjs/toolbelt/gate'
import { hookChainMessage }          from '@frontierjs/toolbelt/hooks'
import { derefFieldSchema, fieldShape } from '@frontierjs/toolbelt/jsonschema'
import { humanize }                    from '@frontierjs/toolbelt/inflect'
// The evaluator litestone's own `evalJs` is, so an affordance and the boundary
// cannot disagree about a row (`FJS-D259`).
import { evaluate as evaluatePredicate, truth } from '@frontierjs/toolbelt/predicate'

// `derefFieldSchema` is `@frontierjs/toolbelt/jsonschema`'s — the same walk
// jetty's resource needs, and one of the pure halves that moved to the
// substrate rather than being copied a second time (`FJS-059`). Re-exported
// here because this module is where every caller in this package already looks
// for it.
export { derefFieldSchema }

// ── Field rules ───────────────────────────────────────────────────────────────

const _CARRIED = [
  'format', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'default', 'description',
  // `readOnly` is what a computed / generated / `@from` / `@version` field
  // carries, and `contentMediaType` is where `@markdown` arrives. Both are
  // read by the control table below and by nothing else — a form has to know
  // that a value is not the caller's to write, and that a string is a document.
  'readOnly', 'contentMediaType',
  // `x-litestone-file` is on the FileRef definition a `File` column $refs. It
  // is carried because it is the one thing that tells a shape which is an
  // object with eight properties apart from a shape somebody declared — and
  // the control table has to answer differently for the two.
  'x-litestone-file',
  // What the Data boundary will REFUSE, so a generated header does not offer a
  // sort that throws and a bar does not offer a filter that 400s. Emitted only
  // as exceptions — absent means yes, a string says why not — which is why they
  // are carried rather than defaulted: the absence IS the answer.
  'x-sortable', 'x-filterable',
  // `@immutable` on a model that declares a `@seals` move. There is no
  // `readOnly` beside it, deliberately: the column is writable while the row is
  // a draft and frozen once it seals, and that difference lives in the ROW —
  // no schema can answer it. So the seal is carried as the two things a
  // consumer needs to answer it itself: the state column, and the values that
  // mean sealed. A form with a record resolves readOnly off `record[field]`; a
  // create form has no record and must not, since a row being made is a draft.
  'x-litestone-seal',
  // `@accept("image/png, …")` — the MIME list the Data boundary will admit. It
  // is carried so the picker can offer the same list the server enforces: the
  // refusal is real either way (`FileStorage` checks it before a byte is
  // stored), but a person who has already chosen a 4MB file and waited for it
  // to upload is being told something the dialog could have told them.
  'x-litestone-accept',
  // Which MACHINERY wrote this column, where a column has any. `tenancy` is
  // the one a table has to know about: the value is the same in every row a
  // scoped read can return, so it is a column of one repeated answer taking a
  // slot from a column that says something. Nothing else on the rule separates
  // it from an ordinary foreign key — it is a string with a `references`, which
  // is what an ordinary one is.
  'x-litestone-kind',
  // `writeOnly` is `@transient`: a field the caller sends and no read ever
  // answers. It gets a control like any other writable field — that is the
  // point of declaring it — and this is what lets a form say so, and what stops
  // a detail view rendering a value that is never there.
  'writeOnly',
  // `x-time` is `@time`, and the `pattern` carried above is its enforcement —
  // this key exists only to pick the control, because `<input type="time">`
  // shows a seconds box or does not and nothing in a pattern says which.
  'x-time',
  // `x-money` is `@money` and `x-scale` is `@scale`: an integer column whose
  // stored value is a SCALED one — 1299 for $12.99. Both are carried for the
  // reason `x-time` is, and it is the sharper case: nothing else on the rule
  // separates a scaled integer from an ordinary one, so a form generated
  // without them offers a spinner stepping by 1 and a person editing a price
  // types the number they can see and is out by a hundred. What that control
  // IS remains an app's decision (`registerControl` — the currency's symbol,
  // whether the box is in major units, what a blank means), and this is what
  // lets that decision be made off the declaration rather than off a column
  // name ending in `Cents`.
  'x-money', 'x-scale',
  // `x-litestone-required-where` is `@required(where: …)`: the AST of a
  // predicate over THIS ROW's own columns, deciding whether the column needs a
  // value. Carried as the EXPRESSION where the write policy one line down is
  // carried as a flag, and the difference is what a client can DO with it — a
  // write predicate reads the caller and cannot be answered here, this one
  // reads the record on screen and must be, because the person may have just
  // picked the status that makes the column required.
  //
  // `requiredFor(rule, record)` below is the reader. Nothing resolves it off
  // the rule alone: `required` on this table stays what the schema said, which
  // is *not unconditionally required*, so a form that never asked would behave
  // exactly as it did before.
  'x-litestone-required-where',
  // `x-litestone-write-policy` is a field `@allow('write', …)`: whether this
  // caller may write this column depends on the CALLER and the ROW, so no
  // keyword on the schema can answer it and the boundary answers it by DROPPING
  // the value rather than refusing — silently and correctly, because the same
  // payload is legitimate for somebody else. Carried because without it the
  // column is indistinguishable from an unpoliced one all the way to the
  // control, which is a box a person types into behind a save button that goes
  // green over a write that never happened (`FJS-1071`).
  //
  // It is a FLAG and not the predicate, so it may not disable anything: a
  // control switched off by it is switched off for every caller the predicate
  // ADMITS, which is the majority of them. `declinedFields` below is what it is
  // for — the answer after the write, which is the only moment the flag alone
  // can be turned into a true sentence.
  'x-litestone-write-policy',
  // `x-litestone-read-policy` is a field `@allow('read', …)`: whether this
  // column ARRIVES depends on the caller and the row, and when the policy
  // refuses the key is not null — it is ABSENT (measured: an admin reading a
  // note gets the text and an admin reading a row with none gets `null`, while
  // everyone else gets no key at all, both times). So *there is nothing here*
  // and *this is not yours to see* are one answer without the flag, and a form
  // renders an empty box for a column it cannot read. `withheldFields()` below
  // is the reader.
  'x-litestone-read-policy',
  // `x-big` is `@big`: a 64-bit integer column whose value crosses as a STRING
  // of digits, because past 2^53 a JS number cannot carry it (`FJS-643`). It is
  // carried for `x-time`'s reason and it is the sharpest case of all — the
  // field's declared type IS `string`, so with nothing else on the rule a
  // generated form offers a plain text box for a whole number: no numeric
  // keypad on a phone, no browser-side format refusal, and a person may type a
  // word. The pattern beside it is the enforcement; this is what picks a
  // control that knows the value is a number it may not treat as one.
  'x-big',
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

    // Type and nullability are one walk and it is the toolbelt's: nullability is
    // read off the RAW schema, and deref follows the non-null branch of an
    // anyOf, so by the time the target is in hand the null branch is gone.
    // Shared because `matchesQuery` needs exactly this much of a field and
    // jetty cannot reach the rest of this module (`FJS-493`).
    const { type, nullable } = fieldShape(raw, resolve)
    const def = derefFieldSchema(raw, resolve)

    const rule = { type, required: required.has(name), nullable }

    // A `$ref` nothing could resolve leaves no type behind, which is exactly
    // what a `Json` column looks like — and the control table reads a missing
    // type as *this is a document*. The two are different facts and only this
    // loop can still tell them apart: it is holding the raw schema. Without
    // the flag, a `$defs` table that was never registered turns every enum and
    // every relation on the form into a JSON textarea, silently.
    const ref = typeof raw.$ref === 'string' ? raw.$ref
      : Array.isArray(raw.anyOf) ? raw.anyOf.find(d => typeof d?.$ref === 'string')?.$ref
      : undefined
    if (ref && !resolve?.(ref)) rule.unresolvedRef = ref
    if (Array.isArray(def.enum)) rule.enum = def.enum

    // `x-labels` is what @label on an enum member emits — a partial map, only
    // the members that stated one. It is normalized into `rule.options` HERE
    // rather than in each control, because @frontierjs/ui peers on mesa and
    // css alone and cannot import this module to share the rule.
    //
    // Built only when a label exists, so an unlabelled enum carries no
    // `options` and every reader keeps the `rule.enum` path it already had.
    // A member with no label falls back to its own name, which is what a
    // control rendering a bare enum shows today.
    const enumLabels = def['x-labels']
    if (Array.isArray(def.enum) && enumLabels && typeof enumLabels === 'object') {
      rule.options = def.enum.map(v => ({ value: v, label: enumLabels[v] ?? v }))
    }
    for (const k of _CARRIED) if (k in def) rule[k] = def[k]

    // `x-values` is a @values binding: which named set this column draws from,
    // and how legal a value outside it is. Renamed onto `rule.values` for the
    // same reason `x-labels` is normalized into `rule.options` — a control
    // cannot import this module, so the shape it consumes is settled here.
    if (def['x-values'] && typeof def['x-values'] === 'object') rule.values = def['x-values']

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
 * `model` is normalized to the name as declared in the .lite file, so it can be
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
 *     rule['x-money'] ? 'money' : null)
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
  return _askRegistry(_controls, rule, ctx, { noun: 'control', key: 'control' })
}

// One walker for both registries. The control half and the display half differ
// only in which map they read and which key names the answer, and copying the
// walk would put the decline rule, the throw guard and the `by` stamp in two
// places — three rules whose whole value is being the same for both.
function _askRegistry(entries, rule, ctx, { noun, key }) {
  if (!entries.size) return null

  for (const [name, resolve] of [...entries].reverse()) {
    let answer
    try {
      answer = resolve(rule, ctx)
    } catch (err) {
      // One bad resolver must not take every form in the app down with it, and
      // it must not do that quietly either.
      console.warn(`[field-rules] registered ${noun} '${name}' threw and was skipped — ${err?.message ?? err}`)
      continue
    }

    if (answer == null || answer === false) continue
    if (typeof answer === 'string') answer = { [key]: answer }

    if (typeof answer !== 'object' || Array.isArray(answer)) {
      console.warn(
        `[field-rules] registered ${noun} '${name}' answered ${typeof answer} — a resolver answers a ` +
        `${noun} name, a descriptor object, or null to decline. Ignored.`)
      continue
    }

    const claimed = answer[key]
    if (claimed !== null && (typeof claimed !== 'string' || !claimed)) {
      console.warn(
        `[field-rules] registered ${noun} '${name}' answered a descriptor with no \`${key}\` name. ` +
        `Answer null to decline; \`{ ${key}: null, reason }\` to say a field deliberately has none.`)
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
 *   { control: 'input'|'textarea'|'select'|'checkbox'|'picker'|'datetime'|'json'|null,
 *     type?, options?, model?, valueField?, relation?, reason? }
 *
 * `control: null` is an answer, not an omission — a read-only column and a type
 * this table does not know have no control, and the caller is expected to say
 * so rather than drop the field silently. That silence is the failure this
 * table exists to prevent: a column added to `.lite` that simply never appears
 * on the form.
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

  // A value set is asked BEFORE the foreign key and before the array branch,
  // because it is strictly more information about the same column: it carries
  // the scope the list is narrowed by, the column a person reads, and how legal
  // a value outside the list is. A bound FK answered as a plain relation picker
  // would fetch the whole related table and offer rows the set excludes.
  //
  // The strength picks the control, and the two weak ones pick the same one:
  // what separates `open` from `suggested` is what the SERVER does with a new
  // value, not what the caller may type.
  if (rule.values) {
    const allowNew = rule.values.strength !== 'required'
    const base     = {
      set:        rule.values.set,
      strength:   rule.values.strength,
      model:      rule.values.model,
      valueField: rule.values.value,
      labelField: rule.values.label,
      allowNew,
    }
    if (rule.type === 'array') return { control: 'multiselect', ...base }
    return { control: allowNew ? 'combobox' : 'picker', ...base }
  }

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

  if (Array.isArray(rule.enum)) return { control: 'select', options: rule.options ?? rule.enum }

  // A `File` column $refs FileRef, which derefs to an ordinary object — so the
  // `json` control below would offer a textarea over a storage key, a bucket
  // and a provider, which is not a document anybody edits by hand.
  //
  // The upload BETWEEN the browser's File and the stored ref is what this had
  // no answer for (`FJS-409`), and the answer turned out to be already built
  // and unused: the junction client switches a request to `multipart/form-data`
  // the moment any value in it is a File, the bridge merges those files back
  // into `ctx.data`, and `FileStorage` stores the bytes and writes the ref. So
  // the bytes go WITH THE RECORD, through the service the form already calls —
  // which is also the only route that keeps the gate, the row policies and
  // `@accept`, where a signed URL or an upload route is a second door with its
  // own answer to who may write. What the form holds until submit is the
  // browser `File` itself; nothing has to invent a pending state, and a form
  // abandoned half-filled uploads nothing at all.
  if (rule['x-litestone-file']) {
    return {
      control:  'file',
      accept:   rule['x-litestone-accept'] ?? null,
      // `File[]`. The array's `x-litestone-file` is on `items`, which
      // `derefFieldSchema` has already lifted, so the only thing separating the
      // two here is the declared type.
      multiple: rule.type === 'array',
    }
  }

  // A SCALED integer — `@money(USD)` stores cents, `@scale(2)` stores
  // hundredths — and the number a person types is in the other unit. The row
  // below answers `{ control: 'input', step: 1 }` for an integer, which is the
  // correct control for a count and a spinner that is out by a factor of a
  // hundred for these: 42 typed into a `@money` box is forty-two CENTS, and
  // nothing at any layer refuses it, because 42 is a legal value of the column.
  //
  // So there is no built-in answer here, and the table says so the way it says
  // it for an array or a `Json` document — `control: null` plus a reason, which
  // leaves the field IN `formFields()` with the sentence beside it rather than
  // dropping it silently. What the control IS remains an app's decision
  // (`FJS-D17`): the currency's symbol, whether the box is in major units, what
  // a blank means, and — for `@scale` — what the number even measures, since
  // `example`'s `Discount.value` is a percentage on half its rows and money on
  // the other half. `registerControl` is asked before this table, so an app or
  // a kit that has answered wins and this is only what happens when nobody has.
  if (rule['x-money'] || rule['x-scale']) {
    return {
      control: null,
      reason: rule['x-money']
        ? '@money — register a control; the box is in major units and the column is minor'
        : '@scale — register a control; the box is in decimals and the column is a scaled integer',
    }
  }

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
      // `@big`. Asked before every other string row because it is the one whose
      // JSON type does not describe the value: the column is an integer and the
      // string is only how it travels. `inputMode` is what a phone reads for
      // the keypad, and `type` stays text deliberately — `type="number"` binds
      // through a JS number and would round the value back at the browser,
      // which is the defect this attribute exists to close, arriving one layer
      // further out.
      if (rule['x-big']) return { control: 'input', type: 'text', inputMode: 'numeric', pattern: rule.pattern }
      // A date has no zone, so `<input type="date">` round-trips it and the
      // plain input is right. A date-time DOES have one and `datetime-local`
      // has none — it accepts and emits a wall clock — so the two have to be
      // converted at each edge or the value shifts silently, in opposite
      // directions going in and coming out. That is a control rather than a
      // type attribute, which is why this row names one.
      if (rule.format === 'date') return { control: 'input', type: 'date' }
      if (rule.format === 'date-time') return { control: 'datetime' }
      // A wall clock has no zone, so `<input type="time">` round-trips it and
      // the plain input is right — the same reason `date` is here and
      // `date-time` is not. `step` is what makes the seconds box appear: the
      // control shows HH:MM unless the step is not a whole number of minutes,
      // so a column that accepts seconds has to ask for it or a person cannot
      // type a value the boundary would take.
      if (rule['x-time']) {
        return rule['x-time'].seconds
          ? { control: 'input', type: 'time', step: 1 }
          : { control: 'input', type: 'time' }
      }
      return { control: 'input' }
    }

    // An array column and a declared `type T` shape stop being described by the
    // schema at the point a form would need a field list, so the only editor
    // that covers every value they may hold is the value's own syntax.
    case 'array':  return { control: 'json' }
    case 'object': return { control: 'json' }

    // A `Json` column arrives here, and NOT at `case 'object'`. Litestone
    // emits it as `{}` — the empty schema, no `type` at all, because a Json
    // document may be any of the seven things JSON can hold — so a table that
    // waits for `type: 'object'` never sees the one column this is most for.
    // Measured against a real schema: `settings Json @default("{}")` yields
    // `{ type: null }`, which used to fall to the reason below and be left off
    // every generated form.
    case null:
    case undefined:
      // …unless the type is missing because a `$ref` did not resolve, which
      // looks identical from here and is not a document at all.
      if (rule.unresolvedRef) {
        return { control: null, reason: `unresolved $ref ${rule.unresolvedRef} — is the schema registry populated?` }
      }
      return { control: 'json' }

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

// ── Displays ──────────────────────────────────────────────────────────────────
//
// **A control renders a value for EDITING; a display renders it for READING,
// and they are not the same function.** `controlFor` named this surface from
// the inside before it existed, refusing a read-only column with *a read-only
// value shown on a form is a detail renderer wearing a control's clothes*.
//
// The two tables disagree at their FIRST branch, which is why they are two
// tables rather than one with a mode: a control refuses `@system`, `@computed`,
// `@generated`, `@from` and `@version` by rule and never offers them to a
// registry at all, and those are among the columns a table most wants. Where
// the two agree they agree on a NAME, which is the only thing that has to
// cross.
//
// The two-registration split is `FJS-D17`'s and is unchanged: `registerDisplay`
// here, because the naming side must run in plain Node, and
// `registerDisplayComponent` in `@frontierjs/ui`, because the rendering side
// may not import sierra.

/** name → resolve. Iteration order is registration order; consulted reversed. */
const _displays = new Map()

/**
 * Contribute a display.
 *
 *   registerDisplay('duration', (rule) =>
 *     rule['x-litestone-kind'] === 'duration' ? 'duration' : null)
 *
 * The same contract as `registerControl` in every respect — a name, a full
 * descriptor, or null to decline; last registered asked first; a resolver that
 * throws is skipped loudly — because it is the same mechanism and a second set
 * of rules for the mirror surface would be a second thing to learn.
 *
 * @returns {() => void} the undo, for a test teardown or an HMR dispose
 */
export function registerDisplay(name, resolve) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('registerDisplay(name, resolve) — name must be a non-empty string')
  }
  if (typeof resolve !== 'function') {
    throw new TypeError(
      `registerDisplay('${name}') — resolve must be a function (rule, ctx) => name | descriptor | null`)
  }
  _displays.delete(name)
  _displays.set(name, resolve)
  return () => { if (_displays.get(name) === resolve) _displays.delete(name) }
}

/** Remove a registration by name. Answers whether there was one. */
export function unregisterDisplay(name) {
  return _displays.delete(name)
}

/** What is registered, in the order `displayFor` asks them. Diagnostics. */
export function registeredDisplays() {
  return [..._displays.keys()].reverse()
}

/**
 * How this column's value is RENDERED.
 *
 *   { display: 'text'|'number'|'money'|'time'|'date'|'boolean'|'enum'|
 *              'relation'|'file'|'json'|'list'|'markdown'|null,
 *     …whatever that renderer needs, reason? }
 *
 * `display: null` is an answer and not an omission, exactly as `controlFor`'s
 * is: a type this table does not know keeps its place in the column list with
 * the sentence beside it. Filtering it out would reproduce, inside the
 * generator, the bug the generator exists to end — a column added to `.lite`
 * that never appears and nothing saying so.
 *
 * **Nothing is refused here for being read-only.** That is the whole difference
 * from `controlFor`, and it is what lets a generated table show a `@computed`
 * total and a server-written status.
 *
 * What is answered from the DECLARATION rather than from the value's JS type is
 * the point of the table: `@money` holds minor units, so `1299` is a price
 * rendered wrongly in the way that looks right, and only the schema knows the
 * currency that sets the scale. Likewise an enum's `@label`, a relation's label
 * column, and whether a `DateTime` is an instant or a wall clock.
 *
 * @param {object} rule  one entry from buildFieldRules()
 * @param {{field?: string, model?: string}} [ctx]
 */
export function displayFor(rule, ctx = {}) {
  if (!rule || typeof rule !== 'object') return { display: null, reason: 'no rule' }

  const registered = _askRegistry(_displays, rule, ctx, { noun: 'display', key: 'display' })
  if (registered) return registered

  return _builtinDisplay(rule)
}

/**
 * What the built-in table alone would answer, registrations ignored.
 *
 * Exported for `defaultControlFor`'s reason: a resolver that wants to add to an
 * answer rather than replace it asks for the default and spreads it.
 */
export function defaultDisplayFor(rule) {
  return _builtinDisplay(rule)
}

function _builtinDisplay(rule) {
  if (!rule || typeof rule !== 'object') return { display: null, reason: 'no rule' }

  // A value set is asked before the foreign key for `controlFor`'s reason
  // exactly: it is strictly more information about the same column, and a bound
  // FK read as a plain relation would resolve a label through the wrong table.
  if (rule.values) {
    return {
      display:    'enum',
      set:        rule.values.set,
      model:      rule.values.model,
      valueField: rule.values.value,
      labelField: rule.values.label,
    }
  }

  // `rule.options` is `@label` on the members, normalized by buildFieldRules.
  // Passing it through is the difference between a status cell reading
  // *Awaiting payment* and reading `awaiting_payment`.
  if (Array.isArray(rule.enum)) return { display: 'enum', options: rule.options ?? rule.enum }

  // A foreign key holds an id and nobody recognizes an id. The related model
  // travels so the renderer can resolve its label column the way a picker does.
  if (rule.references) {
    return {
      display:    'relation',
      model:      rule.references.model,
      valueField: rule.references.field,
      relation:   rule.references.relation,
    }
  }

  // Before the Json branch, for the reason the control table has the same
  // ordering: a File column $refs FileRef, which derefs to an ordinary object,
  // so a document viewer would render a storage key, a bucket and a provider.
  if (rule['x-litestone-file']) return { display: 'file' }

  // The declaration decides, never the JS type. Both of these are integers.
  // `x-money` has THREE shapes and a renderer has to tell them apart: a stated
  // currency, one held per ROW in a sibling column, and neither. Only the first
  // was carried, so `field:` reached a cell as `currency: undefined` and the
  // column that holds the answer was never named — a prop the cell reads and
  // nothing sets, which renders as the app default on every row of a
  // multi-currency table.
  if (rule['x-money']) return {
    display: 'money',
    currency:      rule['x-money'].currency,
    currencyField: rule['x-money'].field,
  }
  if (rule['x-scale'] != null) return { display: 'scale', scale: rule['x-scale'] }

  // An instant and a wall clock are different values that arrive as the same
  // string, and which zone resolved one is not recoverable from the string.
  if (rule['x-time']) return { display: 'time', time: rule['x-time'] }

  if (rule.contentMediaType === 'text/markdown') return { display: 'markdown' }

  switch (rule.type) {
    case 'boolean': return { display: 'boolean' }
    case 'integer':
    case 'number':  return { display: 'number' }
    case 'string':  return rule.format === 'date-time' || rule.format === 'date'
      ? { display: 'time', time: { kind: rule.format === 'date' ? 'date' : 'instant' } }
      : { display: 'text' }
    case 'array':   return { display: 'list' }

    // A Json column arrives as `{ type: null }` rather than as `object` — the
    // seed says `Json` and the emitter describes no shape — so all three
    // spellings are one branch here, the same way the control table takes them.
    //
    // A `$ref` nothing resolved looks identical from here and is not the same
    // fact: `buildFieldRules` is the only thing that could still tell them
    // apart, so it marks the first, and a marked one says so rather than
    // pretending to be a document.
    case 'object':
    case null:
    case undefined: return rule.unresolvedRef
      ? { display: null, reason: `unresolved $ref ${rule.unresolvedRef}` }
      : { display: 'json' }

    default: return { display: null, reason: `no display for type ${rule.type}` }
  }
}

/**
 * What a column's HEADER says.
 *
 * `@label` in the seed wins, which is the whole reason it is a declaration —
 * `providerRef` reads as *Provider reference* on every table in the app without
 * one of them saying so. Failing that, the name is humanized for a READER,
 * which is the axis `@frontierjs/toolbelt/inflect` owns and the one that may
 * change without the storage and shape axes moving.
 *
 * NOT `fieldLabel`, which is the same question for a validation MESSAGE and
 * answers a bare column name rather than a humanized one — *placedAt must be a
 * string* is a sentence about a field a caller sent, and a table header is a
 * word a person reads.
 */
export function columnLabel(name, rule) {
  // The relation name is humanized like any other, and only `@label` is taken
  // verbatim: `customerId` reading as *customer* put the one lowercase header
  // in a table whose every other column was Title Case, because the relation
  // name is an IDENTIFIER — `customer`, `productVariant` — and the reader axis
  // is what a header wants. An author-supplied `@label` is already a reader's
  // words and is the one thing that must not be re-cased.
  return rule?.title ?? humanize(rule?.references?.relation ?? name)
}

/**
 * Which OPERATOR a filter over this kind of column asks with.
 *
 * **A filter is a second binding on `displayFor`'s names rather than a third
 * resolver**, and the reason is that the naming is already done. `controlFor`
 * cannot serve it — measured over this repo's two apps, 61 of `example`'s 346
 * filterable columns and 32 of basecamp's 482 answer `control: null` for being
 * read-only, and those are precisely what an operator filters by: a `@from`
 * rollup, a foreign key, the `@version`. A control refuses them BY RULE and
 * never offers them to a registry. `displayFor` refuses nothing for being
 * read-only, so a column already has one kind, named once.
 *
 * So this is a TABLE and not a resolver: display name → the question a filter
 * asks of that kind. The component that renders it is the kit's half
 * (`registerFilterComponent`), exactly as a display's is.
 *
 *   text                        → contains          a box, matched loosely
 *   number · money · scale·time → gte + lte         a range
 *   enum · relation             → in                several values
 *   boolean                     → equals            any · yes · no
 *   list                        → hasSome           several values
 *   json · file                 → null, with a reason
 *
 * **The `null` rows are the ones the Data boundary would refuse**, and they are
 * here rather than left out so a caller can say why a column offers no filter.
 * `$checkWhere` throws BY NAME for a text operator on a column holding a JSON
 * document, an array or a file reference — a substring match against a
 * serialized document is a plausible answer rather than an error, which is the
 * failure mode this whole surface exists to end.
 *
 * @param {string|null} display  a name from `displayFor`
 * @returns {{op: string|string[], kind: 'text'|'range'|'set'|'exact', reason?: string}|null}
 */
export function filterOpFor(display) {
  switch (display) {
    case 'text':     return { op: 'contains', kind: 'text' }
    case 'number':
    case 'money':
    case 'scale':
    case 'time':     return { op: ['gte', 'lte'], kind: 'range' }
    case 'enum':
    case 'relation': return { op: 'in', kind: 'set' }
    case 'boolean':  return { op: 'equals', kind: 'exact' }
    case 'list':     return { op: 'hasSome', kind: 'set' }

    // Stated rather than absent, and each with the boundary's own reason: a
    // text operator on one of these matches the serialized document, which
    // looks like an answer.
    case 'json':     return { op: null, kind: null, reason: 'a Json document matches as text, punctuation included' }
    case 'file':     return { op: null, kind: null, reason: 'a file reference is a document, not a value to compare' }
    case 'markdown': return { op: 'contains', kind: 'text' }

    default:         return null
  }
}

/**
 * The table's column list, ranked./**
 * The table's column list, ranked.
 *
 * NOT `formFieldList`, and the reason is a rule rather than a detail. **A form
 * shows what is WRITABLE; a table shows what is READABLE and IDENTIFYING**, and
 * the two sets differ at both ends: `@system`, `@computed`, `@generated`,
 * `@from` and `@version` are `readOnly` and absent from a form BY RULE, and a
 * server-written status or a computed total is among the columns a table most
 * wants. Nothing is dropped here for being read-only.
 *
 * **Quantity is the other half.** A form showing every writable column is
 * right; a table showing forty columns is not a table. So this needs an input a
 * field list never needed — *which few columns identify this row to a person* —
 * and the answer is ranked rather than sliced. A slice off `Object.keys` is
 * presentation decided by the order columns happen to sit in a file people
 * reorder for unrelated reasons, which is presentation decided badly and
 * invisibly.
 *
 * Five tiers, each a stated reason to be near the front:
 *
 *   label     — the column that NAMES the row (`@@label`, or a conventional
 *               name). A `scan` answer is deliberately not taken: it is the
 *               first plain string, which is the arbitrariness this replaces
 *   identify  — `x-identify`, a unique tuple minus the members that only scope
 *               it. The business key a person recognizes: an sku, a reference
 *   state     — a bound enum or a value set. The column somebody filters by
 *   quantity  — money and time, which is what a row is usually compared on
 *   rest      — declaration order, which is the right answer once the columns
 *               that had a reason to lead are in front of it
 *
 * `only` bypasses the ranking entirely and its order wins, because naming the
 * columns is also naming the order you want them in. That is the escape hatch,
 * and `omitted` is what keeps it from being a silent one.
 *
 * **Everything not returned comes back in `omitted` WITH A REASON.** Filtering
 * silently would reproduce, inside the generator, the bug the generator exists
 * to end: a column added to `.lite` that does not appear and nothing says so.
 *
 * @param {Record<string, object>} fields  from buildFieldRules()
 * @param {{only?: string[], except?: string[], limit?: number,
 *          identify?: string[], label?: string}} [opts]
 *   `identify` is the model's `x-identify`; `label` its `x-label-field`.
 * @returns {{columns: Array<{name, rule, tier}>, omitted: Array<{name, reason}>}}
 */
export function columnList(fields, { only, except, limit = 6, identify, label } = {}) {
  const rules   = fields && typeof fields === 'object' ? fields : {}
  const known   = Object.keys(rules)
  const removed = new Set(Array.isArray(except) ? except : [])
  const omitted = []

  // An `only` or an `except` naming a field the model does not have is usually
  // a rename that left the table behind, and is reported the way `formFieldList`
  // reports one rather than ignored.
  for (const name of removed)
    if (!(name in rules)) omitted.push({ name, reason: 'excluded, but no such field on this model' })

  if (Array.isArray(only) && only.length) {
    const columns = []
    for (const name of only) {
      if (removed.has(name)) { omitted.push({ name, reason: 'named by only and by except' }); continue }
      if (!(name in rules)) { omitted.push({ name, reason: 'no such field on this model' }); continue }
      columns.push({
        name, rule: rules[name], tier: 'named',
        label:       columnLabel(name, rules[name]),
        sortable:    !rules[name]?.['x-sortable'],
        sortRefusal: rules[name]?.['x-sortable'] ?? null,
      })
    }
    for (const name of known)
      if (!only.includes(name) && !removed.has(name)) omitted.push({ name, reason: 'not named by only' })
    return { columns, omitted }
  }

  const identifying = new Set(Array.isArray(identify) ? identify : [])
  // `declared` and `conventional` are answers; `scan` and `fallback` are the
  // guesses this function exists to stop making.
  const named = label ?? (() => {
    const info = labelFieldInfo(rules, null)
    return info.source === 'declared' || info.source === 'conventional' ? info.field : null
  })()

  // `state` and `quantity` are questions about the column's KIND, and the kind
  // has one owner — the built-in display table. Re-deriving them from raw keys
  // is a second reader, and the two disagreed: `x-time` is the `@time`
  // ATTRIBUTE, so an ordinary `DateTime` carries `format: 'date-time'` and none
  // of it, and every date column fell to `rest` under a tier whose own name is
  // *money and time*. An invoice list then led with the tax it was charged
  // rather than the day it was due.
  //
  // `defaultDisplayFor` and not `displayFor`: the ranking reads the built-in
  // table alone, so a contributed display changes how a column RENDERS and
  // never which columns a table picks.
  const tierOf = (name, rule) => {
    if (name === named)                       return 'label'
    if (identifying.has(name))                return 'identify'
    const { display } = defaultDisplayFor(rule)
    if (display === 'enum')                   return 'state'
    if (display === 'money' || display === 'time') return 'quantity'
    return 'rest'
  }

  const RANK = { label: 0, identify: 1, state: 2, quantity: 3, rest: 4 }

  // A tenancy stamp is what the boundary SCOPED the read by, so every row that
  // came back carries the same value: a column of one repeated answer, holding
  // a slot in a six-column table. It ranks as `rest` on its own merits and that
  // is not low enough — a model declaring few columns puts the workspace id on
  // screen ahead of the commit that was deployed.
  //
  // Omitted rather than deranked, because there is no position at which a
  // constant column is worth a slot. `only` still names it: a cross-workspace
  // screen reads through `asSystem()`, where the stamp is the one column
  // telling its rows apart, and naming the columns is the escape hatch for
  // exactly the case the ranking cannot know about.
  const ranked = known
    .filter(name => !removed.has(name))
    .filter((name) => {
      if (rules[name]?.['x-litestone-kind'] !== 'tenancy') return true
      omitted.push({ name, reason: 'a tenancy stamp — the same value in every row a scoped read returns' })
      return false
    })
    .map((name, order) => ({ name, rule: rules[name], tier: tierOf(name, rules[name]), order }))
    // Declaration order breaks a tie, so a schema stays readable as a table:
    // within one tier the file's order is the only ordering anybody stated.
    .sort((a, b) => RANK[a.tier] - RANK[b.tier] || a.order - b.order)

  for (const name of removed)
    if (name in rules) omitted.push({ name, reason: 'excluded by the caller' })

  const cap = Number.isInteger(limit) && limit > 0 ? limit : ranked.length
  for (const c of ranked.slice(cap))
    omitted.push({ name: c.name, reason: `beyond the ${cap}-column limit (ranked ${c.tier})` })

  return {
    columns: ranked.slice(0, cap).map(({ name, rule, tier }) => ({
      name, rule, tier,
      label:    columnLabel(name, rule),
      // Absent means yes. A string is the boundary's own reason, carried so a
      // caller can say why a header does not offer a sort rather than just not
      // offering one.
      sortable: !rule?.['x-sortable'],
      sortRefusal: rule?.['x-sortable'] ?? null,
    })),
    omitted,
  }
}

/**
 * Which column of a related model a picker should SHOW, and how sure it is.
 *
 * A foreign key holds an id and nobody recognizes an id, so something has to
 * choose the human column. `@@label(field)` in the seed is that answer, and it
 * arrives here as `x-label-field`; everything below it is a guess, kept because
 * a model that declared nothing still has to render something.
 *
 * `source` is the half that was missing. Each step down is a worse answer and
 * every one of them used to be silent: a `Person` with `firstName`/`lastName`
 * labels every option *Ada, Ada, Ada* and looks like it worked, and a model
 * whose strings are all enums or foreign keys offers `1, 2, 3`. The caller
 * decides what to do about it — the same shape as `controlFor` reporting a
 * field it cannot place rather than dropping it.
 *
 *   declared      — @@label. Authoritative
 *   conventional  — one of the names below. Usually right
 *   scan          — the first plain string column. A guess
 *   fallback      — nothing readable; the id
 *
 * One owner, because the alternative is every picker in every app choosing
 * differently — and a picker that shows `4` instead of `Ada Lovelace` is the
 * shape of bug nobody files.
 */
const _LABEL_FIELDS = ['name', 'title', 'label', 'displayName', 'reference', 'email', 'slug', 'code']

export function labelFieldInfo(fields, fallback = 'id', declared = null) {
  const rules = fields && typeof fields === 'object' ? fields : {}
  const plain = (r) => r?.type === 'string' && !r.enum && !r.references && !r.readOnly

  // A declaration is NOT checked against the rules map, and must not be. The
  // schema refused every shape a picker cannot use before this ran, and the
  // case the attribute exists for — a `@generated` full name — reaches the
  // client `readOnly`, which the scan below skips by design. It is also absent
  // from a create-mode registry, and a picker reads it off a row.
  if (typeof declared === 'string' && declared) return { field: declared, source: 'declared' }

  for (const name of _LABEL_FIELDS) if (plain(rules[name])) return { field: name, source: 'conventional' }
  for (const [name, rule] of Object.entries(rules)) if (plain(rule)) return { field: name, source: 'scan' }
  return { field: fallback, source: 'fallback' }
}

export function labelFieldFor(fields, fallback = 'id', declared = null) {
  return labelFieldInfo(fields, fallback, declared).field
}

// ── Gate ──────────────────────────────────────────────────────────────────────

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
 * `@frontierjs/toolbelt/gate` owns it, together with the method→position map
 * and the permissive-unknown rule. Re-exported here because this module is
 * Sierra's surface for the derived-schema helpers, and which of two files holds
 * the answer is not something a caller should have to know.
 *
 * A UI AFFORDANCE, NOT A SECURITY BOUNDARY — the server enforces regardless
 * (Invariant 6).
 */
export { canAtLevel }

// ── Transitions ───────────────────────────────────────────────────────────────

/**
 * The model's declared state machines, or null when it has none.
 *
 * Shape is litestone's `x-transitions`: keyed by field, then by transition name.
 * A model can declare more than one, so the field key is part of the answer, not
 * an implementation detail.
 *
 * @returns {Record<string, Record<string, {from:string[], to:string, gate:number|null, system:boolean}>>|null}
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
 * ── It is the GATE half of litestone's answer, and only that half ────────────
 *
 * `db.<model>.transitions(row)` grades a row POLICY too, since a move is an
 * update and an `@@allow('update', …)` refuses one exactly as a gate does
 * (`FJS-495`). Nothing here can: a policy is compiled to SQL or evaluated
 * against the row by litestone's own JS evaluator, and neither exists in a
 * browser — which is why `x-transitions` carries the gate and not the
 * predicate. So this answers `allowed: true` for a move a policy refuses, and
 * `refusedBy` is `'system'`, `'gate'` or `null` where the server may also say
 * `'policy'`.
 *
 * `'system'` is the exception to permissive-when-unknown, and the only verdict
 * here that is not a guess: a `@system` move is the APPLICATION's, so no
 * caller's level changes the answer and a browser is never the application.
 * A screen renders no button for one rather than a disabled button, because a
 * disabled button says *ask somebody more senior* about something no caller can
 * do.
 *
 * That is the documented affordance contract rather than a gap: unknown is
 * permissive, the Data boundary refuses regardless, and the honest failure is a
 * button that gets refused rather than one that is missing when it would have
 * worked. A screen that needs the true list asks the SERVER for it — the same
 * shape comes back off a service call, with the policy graded.
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
      const gate   = t.gate ?? null
      const system = Boolean(t.system)

      // `@system` is asked first, and it is the ONE refusal this side can be
      // certain of: it needs no level and no policy, because the application
      // makes the move and a browser is never the application. Everything else
      // here is permissive-when-unknown; this is not.
      let allowed   = !system
      let refusedBy = system ? 'system' : null

      if (allowed && gate != null && typeof level === 'number') {
        allowed   = levelPasses(gate, level)
        refusedBy = allowed ? null : 'gate'
      }

      out.push({ name, field, from: current, to: t.to, gate, system, allowed, refusedBy })
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

/**
 * Thrown when a resource's hook pipeline ends with nobody having produced an
 * answer — an `around` that forgot `next()`, an `around` that swallowed the
 * failure, or an `error` hook that cleared `ctx.error` and set no result.
 *
 * The words are `@frontierjs/toolbelt/hooks`' — jetty throws the same sentence
 * from a class of its own, and a message written twice is a message that drifts.
 */
export class ResourceHookError extends Error {
  constructor(service, method, phase, cause) {
    super(hookChainMessage(service, method, phase))
    this.name    = 'ResourceHookError'
    this.service = service
    this.method  = method
    this.phase   = phase
    // The failure the error hook discarded. Without it the original is gone.
    if (cause !== undefined) this.cause = cause
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
 * The sentence a form shows when the write landed and something after it did
 * not. Exported for the same reason as the one above — an app matches it, or
 * replaces it with its own wording.
 */
export const COMMITTED_MESSAGE =
  'Your changes were saved, but a step after the save did not finish. ' +
  'Reload before editing again — saving a second time would create a duplicate.'

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
 * `committed` is the third thing a form has to know and the one it cannot see:
 * whether the write LANDED before the failure. An `after` hook that throws
 * leaves the row written and the caller holding an error, so a form that offers
 * Save again makes a second row. The resource marks the error (`err.committed`)
 * and this reads it — a caller asking "what do I show" gets one answer, which
 * is the whole reason this function is the owner.
 *
 * @param {unknown} err
 * @returns {{ fields: Record<string,string>, message: string, committed: boolean }}
 *   `fields` is keyed for direct use as `<Field errors={…}>`; `message` is the
 *   form-level line, and is empty when the failure was entirely per-field.
 */
export function toFieldErrors(err) {
  const fields = {}
  let message  = ''
  const committed = err?.committed === true

  // The write landed and something after it did not. Nothing per-field can be
  // true of that — the payload was accepted — and the one thing the person must
  // not be told is "it failed", because they will do it again.
  if (committed) return { fields, message: COMMITTED_MESSAGE, committed }

  // A lost-update race has no field to blame and its raw message names a column
  // and two integers. Say the thing the person can act on instead.
  if (isStaleWrite(err)) return { fields, message: STALE_WRITE_MESSAGE, committed }

  for (const e of _errorList(err)) {
    const field = typeof e === 'object' && e !== null ? _fieldOf(e) : null
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

  return { fields, message, committed }
}

// Two boundaries name the offending field differently and both reach a form.
// Junction's validator says `field`; litestone's `ValidationError` says
// `path: ['color']`, and it is the one that carries every rule a browser
// cannot pre-check — a value set, a transition, a soft-deleted unique. Reading
// only `field` sent all of those to the form-level message, where they render
// away from the control they are about and `<Form>` cannot mark it invalid.
function _fieldOf(e) {
  if (e.field) return e.field
  // A nested path is joined rather than dropped: a form field name is flat, so
  // a dotted name matches nothing and falls to the message — which is the same
  // place it would have gone, said truthfully.
  return Array.isArray(e.path) ? e.path.join('.') || null : (e.path ?? null)
}

function _errorList(err) {
  if (!err || typeof err !== 'object') return []
  if (Array.isArray(err.errors))    return err.errors
  if (Array.isArray(err.data))      return err.data
  if (Array.isArray(err.data?.data)) return err.data.data
  return []
}

// ── Coercion ──────────────────────────────────────────────────────────────────

// A number as a PERSON types it, which is HTML's own valid-floating-point-number
// grammar and deliberately not JavaScript's: a native `<input type="number">`
// accepts `1e3` and reports `0x10` invalid, so reading them the same way is what
// keeps the control and this table from disagreeing about the same box. No hex,
// no binary, no octal, no separators, no `Infinity`.
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

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
 *     so rather than passing NaN to the server. `integer` and `number` read the
 *     SAME grammar for that (`NUMERIC`), which is the half that was missing:
 *     `number` used bare `Number()`, so `0x10` became 16 and `0b101` became 5
 *     in a price box while the identical string in a quantity box was refused
 *     (`FJS-823`). One rule, one answer, whichever column it lands in.
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

    if (rule.type === 'integer' || rule.type === 'number') {
      const text = raw.trim()
      if (!NUMERIC.test(text)) continue
      const n = Number(text)
      if (!Number.isFinite(n)) continue
      // The one thing that still separates the two: `1e3` is 1000 and lands in
      // an Int column; `1.5` and `1e-3` are not integers and are left as text so
      // `validate()` names the column rather than the server rounding it.
      if (rule.type === 'integer' && !Number.isInteger(n)) continue
      write(name, n)
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

// ── The columns the SERVER owns ───────────────────────────────────────────────

/**
 * Is this column frozen FOR THIS ROW?
 *
 * `@immutable` on a model that declares a `@seals` move freezes at the seal
 * rather than at create, so the answer is in the record and not in the schema —
 * which is why the field carries no `readOnly` and carries `x-litestone-seal`
 * instead. One owner, because a form, a control and a write pipeline would each
 * otherwise decide it and the three would disagree about a state two hops from
 * the seal.
 *
 * **No record means NOT frozen**, deliberately: a create form is making a draft,
 * and refusing an affordance the server decides anyway is how a working app ends
 * up with a box nobody can type in.
 *
 * @param {object} rule     a field rule from buildFieldRules
 * @param {object} [record] the row being edited
 */
export function sealedFor(rule, record) {
  const seal = rule?.['x-litestone-seal']
  if (!seal || !record) return false
  return seal.states.includes(record[seal.field])
}

/**
 * Does this column need a value FOR THIS ROW?
 *
 * `@required(where: …)` is required in the rows a predicate admits, so the
 * answer is in the record and not in the schema — which is why the field is not
 * in the schema's `required` list and carries the predicate instead. The exact
 * shape `x-litestone-seal` has one attribute over, and `sealedFor` is the
 * sibling: one owner, because a form, a control and a write pipeline would
 * each otherwise decide it and the three would disagree about a row two edits
 * from the state that matters.
 *
 * **The evaluator is `@frontierjs/toolbelt/predicate`, which IS litestone's own
 * `evalJs`** — the same function with a different environment passed in
 * (`FJS-D259`). So this is not a second reading of the rule that could drift
 * from the boundary's; it is the boundary's reading, run against the record on
 * screen instead of against the stored row.
 *
 * The predicate reads this row's own columns and nothing else — `auth()`,
 * `now()`, `check()` and a relation hop are each refused at parse — so there is
 * nothing here the browser cannot answer, and no default that has to guess.
 *
 * **UNKNOWN is not required.** A predicate whose own column has no value yet is
 * UNKNOWN, and the rule is *required in the rows the predicate ADMITS*. It is
 * also what the CHECK does: SQLite admits a row it cannot judge, so answering
 * `true` here would mark a control required that the boundary would accept
 * empty — an affordance stricter than the rule, which is the one direction a
 * form must not be wrong in.
 *
 * **No record answers false**, which is a create form: the row is being made
 * and its columns are being typed, so a create that read the predicate off an
 * absent row would demand a value for a state nobody has chosen yet. `<Form>`
 * re-asks as the record changes, which is what makes the affordance track the
 * status the person just picked.
 *
 * @param {object} rule     a field rule from buildFieldRules
 * @param {object} [record] the record as it stands now
 */
export function requiredFor(rule, record) {
  if (rule?.required) return true
  const where = rule?.['x-litestone-required-where']
  if (!where || !record) return false
  try {
    // `truth()` and not `=== true`: `evaluate` is an EXPRESSION evaluator, so a
    // bare column predicate — `where: active` — answers the column's stored
    // value, and SQLite stores a boolean as 1. The SQL half treats 1 as true,
    // so without this the CHECK fires while the form says the column is
    // optional, which is the two halves disagreeing rather than a missing
    // affordance. Litestone's own policy layer wraps every predicate the same
    // way (`allowHolds`/`denyFires`).
    return truth(evaluatePredicate(where, { record })) === true
  } catch {
    // An expression this evaluator does not know is a schema newer than this
    // client. Permissive, which is every other `x-*` affordance's answer and is
    // what Invariant 6 requires: the server enforces regardless.
    return false
  }
}

/**
 * Which of the columns this write SENT did the boundary decline to write.
 *
 * A field `@allow('write', …)` is a predicate over the caller and the row, and
 * the Data boundary answers it by keeping the stored value: the write succeeds,
 * every other column lands, and the one the predicate refused comes back as it
 * was. That is deliberate and stays — the same payload is legitimate for
 * another caller, so a refusal BY NAME would be wrong (`FJS-D129`).
 *
 * **Silent at the boundary is one thing; silent on the screen is another.** The
 * column reached the browser indistinguishable from an unpoliced one, so a
 * generated form offered a box, a person typed in it, and the save button went
 * green over nothing (`FJS-1071`).
 *
 * This is the only question the FLAG alone can answer truthfully, and it can
 * only be asked AFTER the write: before it, *may I write this* needs the
 * predicate and a row, which is a second reader on the policy language and a
 * decision of its own. So nothing here disables a control — a control switched
 * off by the flag is switched off for every caller the predicate admits.
 *
 * **Only flagged columns are compared**, which is what keeps this from
 * reporting every server-side transform as a refusal: `@lower`, `@trim` and
 * `@slug` all legitimately hand back a different value, and a column carrying
 * both a transform and a write predicate is the one case this can still get
 * wrong — reported, because a false *the server kept its value* is a sentence
 * somebody can check, where the silence it replaces is not.
 *
 * **Primitives only.** An object or an array comes back re-serialized and
 * compares unequal by reference for reasons that have nothing to do with a
 * policy, and a `Json` column would report on every save.
 *
 * A column ABSENT from the answer is not a decline: that is `@allow('read', …)`
 * on the same column, or a narrow `select`, and neither says anything about the
 * write.
 *
 * @param {Record<string, object>} fields  from buildFieldRules()
 * @param {object} sent   the payload this write put on the wire
 * @param {object} saved  the row the write answered with
 * @returns {Record<string,string>} keyed for direct use as `<Field errors={…}>`
 */
export function declinedFields(fields, sent, saved) {
  const out = {}
  if (!fields || !sent || !saved || typeof sent !== 'object' || typeof saved !== 'object')
    return out
  if (Array.isArray(sent) || Array.isArray(saved)) return out

  for (const name of Object.keys(sent)) {
    if (!fields[name]?.['x-litestone-write-policy']) continue
    if (!(name in saved)) continue

    const was = sent[name]
    const now = saved[name]
    if (!_comparable(was) || !_comparable(now)) continue
    if (was === now) continue

    const label = fields[name].title || name
    out[name] = `${label} was not changed — you do not have permission to write it.`
  }
  return out
}

/**
 * Which columns this caller was not allowed to READ.
 *
 * A field `@allow('read', …)` is enforced by STRIPPING the key, so a refused
 * read and an empty column are the same answer to every reader that tests the
 * value — and a generated form then offers an ordinary empty box for a note it
 * is not allowed to see. Typing in that box overwrites what is there, unseen:
 * a read policy is not a write policy, and a caller refused the read is not
 * refused the write unless the schema says so separately (measured against
 * `example`'s `Customer.notes`, which declares only the read half).
 *
 * The signal is KEY PRESENCE and it cannot be anything else, which also fixes
 * the limit: a row narrowed by `$select` is missing keys for a different
 * reason, so this is sound only over a full row — which is what a form is
 * handed. A create has no record and withholds nothing, because a row being
 * made has no stored value to hide.
 */
export function withheldFields(fields, record) {
  if (!fields || !record || typeof record !== 'object' || Array.isArray(record)) return []
  return Object.keys(fields).filter(
    (name) => fields[name]?.['x-litestone-read-policy'] && !(name in record))
}

const _comparable = (v) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/**
 * Drop the fields a caller may not write from a create or patch payload.
 *
 * `@system`, `@generated`, `@computed`, `@from` and a tenancy stamp all reach
 * the client as `readOnly`, which is what stops a generated form offering them
 * and stops `make()` seeding them. Neither of those covers the case an EDIT form
 * is: `<Form record={row}>` is handed a row the server sent, that row carries
 * every column the caller could READ, and the whole record is what gets written
 * back. So a form nobody typed a server-owned value into sends one.
 *
 * The Data boundary then refuses BY NAME — `@system` and `@guarded` are
 * deliberately loud rather than silently dropped, because a payload naming one
 * is code that meant to write it — and the person is shown a 403 about a column
 * that is not on their screen.
 *
 * **The `@version` column is `readOnly` and must still travel**, which is why
 * this takes a keep list rather than dropping everything marked read-only: the
 * revision an update carries back is the one thing the server marks read-only
 * and requires. It is not an exception to the rule so much as the reason the
 * rule cannot be spelled `delete every readOnly key`.
 *
 * Only fields the rules KNOW about are dropped. A key with no rule behind it is
 * left alone: an app may legitimately send something the model does not
 * describe (a `@transient`, a custom method's own argument), and guessing about
 * those is how a strip becomes the thing that breaks a working app.
 *
 * Returns the same object when nothing changed.
 *
 * @param {Record<string, object>} fields  from buildFieldRules()
 * @param {object|object[]} data
 * @param {{ keep?: string[] }} [opts]
 */
export function stripReadOnly(fields, data, opts = {}) {
  if (Array.isArray(data)) return data.map(row => stripReadOnly(fields, row, opts))
  if (!data || typeof data !== 'object') return data

  const keep = new Set(opts.keep ?? [])
  let out = null

  for (const [name, rule] of Object.entries(fields ?? {})) {
    if (!rule?.readOnly || keep.has(name)) continue
    if (!Object.prototype.hasOwnProperty.call(data, name)) continue

    if (out === null) out = { ...data }
    delete out[name]
  }

  return out ?? data
}

// ── Does this record belong in that query's results? ──────────────────────
//
// `@frontierjs/toolbelt/match` owns it; this is the re-export, so every
// caller here is unchanged.
//
// It moved because there are two live stores and only one of them asked.
// jetty's upserted whatever its channel delivered, so a row that had LEFT the
// list went straight back into it (`FJS-493`) — and jetty may not import
// sierra, while a hand copy is what `FJS-059` already paid for once.
//
// The `fields` table is `buildFieldRules()`'s output, passed whole: the
// matcher reads `rule.type` and nothing else, so anything richer satisfies it.
export { matchesQuery } from '@frontierjs/toolbelt/match'

