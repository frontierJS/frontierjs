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
    // These are English's regular plural rules, and only those. Irregular
    // plurals (people/Person, children/Child) are not guessable and are not
    // guessed — name the model explicitly instead:
    //   createResource('people', { model: 'Person' })
    _index[modelName] = modelName
    _index[accessor]  = modelName
    _index[accessor + 's'] = _index[accessor + 's'] ?? modelName

    // consonant + y → -ies    (Company → companies)
    if (/[^aeiou]y$/.test(accessor)) {
      const ies = accessor.slice(0, -1) + 'ies'
      _index[ies] = _index[ies] ?? modelName
    }

    // sibilant → -es    (Status → statuses, Box → boxes, Church → churches)
    // Missing this made a plainly regular plural need a manual override: a
    // `model Status` behind a `statuses` service resolved to nothing.
    if (/(s|x|z|ch|sh)$/.test(accessor)) {
      const es = accessor + 'es'
      _index[es] = _index[es] ?? modelName
    }
  }
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
