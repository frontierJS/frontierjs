// make-from-schema.js — JSON schema → defaults factory.
//
// Ported verbatim from @frontierjs/sierra/junction/resource.js's
// createMakeFromSchema (Sierra v0.1.0). Pure function; no dependencies on
// transport, Junction, or any framework piece. Listed as the first piece to
// extract into @frontierjs/resources-core when Option B refactor lands
// (see docs/future-refactors.md).

/**
 * Build a make() factory from JSON schema properties (Litestone format).
 *
 * Pass the properties object from a model definition:
 *   const { properties } = jsonSchema.definitions['leads']
 *   const make = createMakeFromSchema(properties)
 *
 * @param {object} properties   — JSON schema properties for the model
 * @param {string[]} [skip]     — server-managed fields to exclude from make()
 */
export function createMakeFromSchema(properties, skip = ['id', 'createdAt', 'updatedAt']) {
  const typeDefaults = {
    string:  '',
    integer: 0,
    number:  0,
    boolean: false,
    array:   [],
    object:  {},
  }

  const fieldDefaults = {}

  for (const [key, def] of Object.entries(properties ?? {})) {
    if (skip.includes(key)) continue

    // Explicit default wins.
    if ('default' in def) {
      fieldDefaults[key] = def.default
      continue
    }

    // Resolve type — handle nullable anyOf and array forms.
    let type = def.type
    if (!type && def.anyOf) {
      const nonNull = def.anyOf.find(t => t.type !== 'null')
      type = nonNull?.type
    }
    if (Array.isArray(type)) {
      type = type.find(t => t !== 'null')
    }

    // date-time strings → undefined (don't guess a value).
    if (type === 'string' && def.format === 'date-time') {
      fieldDefaults[key] = undefined
      continue
    }

    fieldDefaults[key] = type in typeDefaults ? typeDefaults[type] : null
  }

  return function make(spec) {
    const instance = {}
    for (const key in fieldDefaults) {
      // Clone arrays and objects so instances don't share references.
      const val = fieldDefaults[key]
      instance[key] = Array.isArray(val)
        ? []
        : (val !== null && typeof val === 'object') ? {} : val
    }
    return Object.assign(instance, spec ?? {})
  }
}
