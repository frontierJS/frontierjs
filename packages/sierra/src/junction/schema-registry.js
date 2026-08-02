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

/** @type {Record<string, object>} model name → JSON schema definition */
let _defs = {}

/** @type {Record<string, string>} accessor / service name → model name */
let _index = {}

/**
 * Install the generated schemas. Called once from `virtual:sierra`.
 *
 * @param {object} defs   $defs from generateJsonSchema — keyed by model name
 */
export function registerSchemas(defs) {
  _defs = defs ?? {}
  _index = {}

  for (const modelName of Object.keys(_defs)) {
    const accessor = modelName.charAt(0).toLowerCase() + modelName.slice(1)
    // Every spelling a caller might reasonably use: the model name as declared,
    // the Litestone accessor, and the conventional plural service name.
    _index[modelName] = modelName
    _index[accessor]  = modelName
    _index[accessor + 's'] = _index[accessor + 's'] ?? modelName
    if (accessor.endsWith('y')) {
      _index[accessor.slice(0, -1) + 'ies'] = _index[accessor.slice(0, -1) + 'ies'] ?? modelName
    }
  }
}

/**
 * Look up a model's schema by model name, accessor, or service name.
 *
 * @param   {...string} names  candidates, first match wins
 * @returns {object|null}
 */
export function schemaFor(...names) {
  for (const n of names) {
    if (!n) continue
    const key = _index[n]
    if (key && _defs[key]) return _defs[key]
  }
  return null
}

/** All registered schemas, keyed by model name. */
export function allSchemas() {
  return _defs
}

/** True when the build generated schemas — false in a plain Node test. */
export function hasSchemas() {
  return Object.keys(_defs).length > 0
}
