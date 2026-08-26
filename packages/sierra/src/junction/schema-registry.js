/**
 * junction/schema-registry.js — model schemas, generated from the .lite file.
 *
 * The browser needs a model's field shape for `make()` defaults and for
 * option-form generation. Hand-writing that in each resource file duplicated
 * `db/schema.lite`, and it was the only remaining place the two halves of a
 * FrontierJS app could drift — the server stopped needing a copy once Junction
 * started deriving validation from the Litestone client's own `$schema`.
 *
 * Sierra's build now generates the JSON schema from the same `.lite` file and
 * emits a `registerSchemas()` call into `virtual:sierra`, which runs before any
 * route module is evaluated. `createResource` reads from here when no schema is
 * passed explicitly.
 *
 * Registration happens in generated code rather than by importing a virtual
 * module here, so this file stays plain JavaScript that Sierra's own Node tests
 * can import.
 */

import { pluralize } from '@frontierjs/toolbelt/inflect'

/**
 * Every `$defs` entry, by name — models, enums, `type` declarations, FileRef.
 * This is the document's definition table, and it is kept whole because it is
 * what `$ref` points into. Dropping everything but the models is what left
 * `{"$ref":"#/$defs/Plan"}` dangling in the browser.
 * @type {Record<string, object>}
 */
let _defs = {}

/** @type {Record<string, object>} model name → definition (models only) */
let _models = {}

/** @type {Record<string, string>} accessor / service name → model name */
let _index = {}

/** A definition that could be a model: an object type with fields. */
function _looksLikeModel(def) {
  return !!def && typeof def === 'object' && !!def.properties
}

/**
 * Install the generated schemas. Called once from `virtual:sierra`.
 *
 * Only `modelNames` become addressable as resources. An enum is a definition,
 * not a model — indexing `enum Plan` under 'Plan'/'plan'/'plans' meant
 * `createResource('plans')` resolved to it and `make()` then iterated a string,
 * throwing "Cannot use 'in' operator to search for 'default' in string".
 *
 * @param {object} defs          the whole `$defs` table from generateJsonSchema
 * @param {string[]} [modelNames] which of those entries are models. Omitted →
 *        fall back to "has properties", which is right for every case except a
 *        `type T { … }` declaration; the build always passes the real list.
 */
export function registerSchemas(defs, modelNames) {
  _defs = defs ?? {}
  _models = {}
  _index = {}

  const names = modelNames ?? Object.keys(_defs).filter(n => _looksLikeModel(_defs[n]))

  for (const modelName of names) {
    const def = _defs[modelName]
    if (!def) continue
    _models[modelName] = def

    const accessor = modelName.charAt(0).toLowerCase() + modelName.slice(1)
    // Every spelling a caller might reasonably use: the model name as declared,
    // the Litestone accessor, and the conventional plural service name.
    //
    // English's regular rules plus toolbelt's irregular table, so `people`
    // does index `Person`. What the table does not hold is still not guessed —
    // name the model explicitly instead:
    //   createResource('lenses', { model: 'Lens' })
    _index[modelName] = modelName
    _index[accessor]  = modelName

    // The lenient spelling as well as the conventional one: `companys` is not
    // English, and someone who names their service that should still resolve.
    _index[accessor + 's'] = _index[accessor + 's'] ?? modelName

    const plural = _pluralOf(accessor)
    _index[plural] = _index[plural] ?? modelName

    // The TABLE spelling, which is snake_case of the model name. A caller
    // holding one is not hypothetical: litestone's `$tapQuery` reports the
    // table, and the static-safety gate resolves what a prerendered route read
    // through here — so without this row every MULTI-WORD model is
    // unpublishable. It fails closed, which is the safe direction and the
    // confusing one: `product_variant` was reported as a name "the schema does
    // not describe" while `db/schema.lite` plainly declares `ProductVariant`.
    // A single-word model resolved by accident, its table being its accessor.
    const table = _tableOf(modelName)
    _index[table] = _index[table] ?? modelName
    const tablePlural = _pluralOf(table)
    _index[tablePlural] = _index[tablePlural] ?? modelName
  }
}

/**
 * The conventional plural of a client accessor.
 *
 * One definition, two directions: `registerSchemas` indexes it so a service
 * name resolves to its model, and `serviceNameFor` reads it so a relation can
 * name the service that answers for a model. The rules are
 * `@frontierjs/toolbelt`'s, which is what makes them the same rules litestone
 * used to name the table (Invariant 2) rather than a fourth opinion — a word
 * they cannot reach is said by hand: `createResource('lenses', { model:
 * 'Lens' })`.
 */
function _pluralOf(accessor) {
  return pluralize(accessor)
}

/**
 * The SQL table a model is stored in — `ProductVariant` → `product_variant`.
 *
 * The same derivation litestone's `modelToTableName` applies, restated here
 * rather than imported because sierra must not depend on litestone. What it
 * cannot see is `@@map("custom_name")`, which always wins on the Data side; a
 * mapped model resolves by its own name and its accessor as before, and only
 * the table spelling is missed.
 */
function _tableOf(modelName) {
  return modelName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g,     '$1_$2')
    .toLowerCase()
}

/**
 * The service name a model is conventionally served under — `Customer` →
 * `customers`.
 *
 * A relation carries a MODEL name (`x-relations` says `belongsTo Customer`) and
 * a resource is created against a SERVICE, so something has to cross the two.
 * That crossing was being written by hand at every call site — `model
 * .toLowerCase() + 's'`, which is not even the rule this registry uses — and it
 * belongs here, where the plural rules already are.
 */
export function serviceNameFor(modelName) {
  if (typeof modelName !== 'string' || !modelName) return null
  const accessor = modelName.charAt(0).toLowerCase() + modelName.slice(1)
  return _pluralOf(accessor)
}

/**
 * The known model whose name most resembles `name`, or null.
 *
 * Only used to make a failed lookup say something useful. Deliberately a shared
 * prefix rather than an edit distance: it is right for children/Child and
 * statuses/Status, and honestly returns nothing for people/Person, where no
 * string rule could have known.
 */
export function suggestModel(name) {
  const known = Object.keys(_models)
  if (!name || !known.length) return null

  const shared = (a, b) => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }

  const needle = String(name).toLowerCase()
  let best = null
  let bestLen = 0
  for (const m of known) {
    const n = shared(needle, m.toLowerCase())
    if (n > bestLen) { bestLen = n; best = m }
  }

  return bestLen >= 3 ? best : null
}

/**
 * Look up a model's schema by model name, accessor, or service name.
 *
 * @param   {...string} names  candidates, first match wins
 * @returns {object|null}
 */
export function schemaFor(...names) {
  const key = modelNameFor(...names)
  return key ? _models[key] : null
}

/**
 * Resolve any spelling to the MODEL NAME as declared in the .lite file.
 *
 * `schemaFor` answers "what is the shape"; this answers "what is it called".
 * A resource addressed as `statuses` is backed by `Status`, and callers that
 * report a model — `ctx.model`, telemetry, an error message — want the name the
 * schema actually uses, not whichever plural the service happened to be given.
 *
 * @param   {...string} names  candidates, first match wins
 * @returns {string|null}
 */
export function modelNameFor(...names) {
  for (const n of names) {
    if (!n) continue
    const key = _index[n]
    if (key && _models[key]) return key
  }
  return null
}

/**
 * Resolve a JSON Schema `$ref` against the registered definition table.
 *
 * generateJsonSchema emits enum-typed fields as `{"$ref":"#/$defs/Plan"}` and
 * `Json @type(T)` fields as `{"$ref":"#/$defs/T"}`. Without this, a consumer
 * sees a field with no `type` and no `enum` and can say nothing about it — which
 * is why every enum field defaulted to null and no select could be built from
 * the schema. Junction's own mapProp does the same thing server-side.
 *
 * @param   {string} ref  e.g. '#/$defs/Plan'
 * @returns {object|null}
 */
export function resolveRef(ref) {
  if (typeof ref !== 'string') return null
  const name = ref.replace(/^#\/(\$defs|definitions)\//, '')
  const def = _defs[name]
  return def && typeof def === 'object' ? def : null
}

/** All registered MODELS, keyed by model name. */
export function allSchemas() {
  return _models
}

/** The whole definition table — models, enums, types, FileRef. */
export function allDefs() {
  return _defs
}

/** True when the build generated schemas — false in a plain Node test. */
export function hasSchemas() {
  return Object.keys(_models).length > 0
}
