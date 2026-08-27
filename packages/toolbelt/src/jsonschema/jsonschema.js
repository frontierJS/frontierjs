/**
 * jsonschema — reading the JSON Schema Litestone emits.
 *
 * `@frontierjs/toolbelt/jsonschema`. Litestone WRITES this shape
 * (`generateJsonSchema`); this kit is the consumer half, and it is here because
 * two packages consume it — Sierra's resource and jetty's, which were a hand
 * copy of each other (`FJS-059`).
 *
 * Nothing here fetches or registers anything. A `$ref` is followed through a
 * `resolve` function the caller supplies, because the definition table is the
 * caller's: Sierra's is populated by its build, and jetty may have none at all.
 */

/**
 * Follow a `$ref` — and the non-null branch of an `anyOf` — to the definition
 * that actually describes the field.
 *
 * Keywords written on the field itself WIN over the target's: a field's
 * `@default(pro)` is emitted alongside the `$ref`, and must not be shadowed by
 * anything on the enum definition.
 *
 * @param {object} def
 * @param {(ref: string) => object|null} [resolve] — absent means *cannot follow*,
 *        which answers the field's own keywords rather than throwing
 * @returns {object}
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

/**
 * What TYPE is this field, and may it hold null?
 *
 * Two questions, one walk, because they are read off different places and
 * nothing else can tell them apart afterwards: nullability is on the RAW
 * schema, and `derefFieldSchema` follows the non-null branch of an `anyOf`, so
 * by the time the target is in hand the null branch is gone.
 *
 * @param {object} raw   the field's schema as the model declares it
 * @param {(ref: string) => object|null} [resolve]
 * @returns {{ type: string|null, nullable: boolean }}
 */
export function fieldShape(raw, resolve) {
  if (!raw || typeof raw !== 'object') return { type: null, nullable: false }

  const nullable = Array.isArray(raw.type)  ? raw.type.includes('null')
    : Array.isArray(raw.anyOf) ? raw.anyOf.some(d => d?.type === 'null')
    : false

  const def = derefFieldSchema(raw, resolve)
  let type = def.type
  if (Array.isArray(type)) type = type.find(t => t !== 'null')
  if (!type && Array.isArray(def.anyOf)) type = def.anyOf.find(d => d && d.type !== 'null')?.type

  return { type: type ?? null, nullable }
}

/**
 * The same for every field of a model definition.
 *
 * The minimum `@frontierjs/toolbelt/match` reads, for a consumer that has a
 * schema and no field-rule builder — jetty, where the richer table is Sierra's
 * and lives on the other side of the dependency direction.
 *
 * @param {object} modelDef  `{ properties }`, or the properties bag itself
 * @param {(ref: string) => object|null} [resolve]
 * @returns {Record<string, { type: string|null, nullable: boolean }>}
 */
export function fieldShapes(modelDef, resolve) {
  const properties = modelDef?.properties ?? modelDef
  if (!properties || typeof properties !== 'object') return {}

  const out = {}
  for (const [name, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    out[name] = fieldShape(raw, resolve)
  }
  return out
}

const TYPE_DEFAULTS = {
  string:  '',
  integer: 0,
  number:  0,
  boolean: false,
  array:   [],
  object:  {},
}

/**
 * Build a `make()` factory — what a blank record of this model looks like.
 *
 * @param {object} properties — the model definition's `properties` map
 * @param {object} [opts]
 * @param {string[]} [opts.skip=['id','createdAt','updatedAt']] — server-managed columns
 * @param {(ref: string) => object|null} [opts.resolve] — `$ref` resolver
 * @param {string[]} [opts.foreignKeys=[]] — columns that are a relation's local
 *        key (`x-relations[].fields`). A `belongsTo` is emitted as a plain
 *        integer, so this cannot be derived from `properties` alone.
 * @returns {(spec?: object) => object}
 */
export function createMakeFromSchema(properties, opts = {}) {
  const {
    skip        = ['id', 'createdAt', 'updatedAt'],
    resolve     = undefined,
    foreignKeys = [],
  } = opts

  const fkFields = new Set(foreignKeys)
  const fieldDefaults = {}

  for (const [key, raw] of Object.entries(properties ?? {})) {
    if (skip.includes(key)) continue

    // Not a field definition at all. Reached when a caller hands over something
    // that is not a properties map — an enum def used to arrive here and throw
    // on the `in` check below.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    // Enum and `@type(T)` fields arrive as `{$ref}`. Without following it there
    // is no `type` to read and every such field silently defaulted to null.
    const def = derefFieldSchema(raw, resolve)

    // A value the caller may not write is not the caller's to seed either.
    // `@system`, `@computed`, `@generated` and `@from` all arrive `readOnly`,
    // and a blank seeded for one is a key in the payload — which the Data
    // boundary refuses by name for a `@system` column, so a form that never
    // showed the field could not submit at all. `@version` is the deliberate
    // exception and is not seeded here either: a resource remembers the version
    // it read and puts it on the patch itself.
    if (def.readOnly) continue

    // An explicit default wins over everything below.
    if ('default' in def) {
      fieldDefaults[key] = def.default
      continue
    }

    // An enum with no `@default` has no blank value that is a member of it.
    // `''` would be as invalid as null, and picking the first member would
    // invent a choice nobody made — so leave it unset for the form to fill.
    if (Array.isArray(def.enum)) {
      fieldDefaults[key] = null
      continue
    }

    // A foreign key is the same case and worse. `0` is not "no customer" — it
    // is customer #0, a claim nobody made, and unlike a bad enum value it
    // passes every rule the schema can state: a perfectly good integer, kept by
    // coercion and approved by validation. The first thing to object is SQLite:
    //
    //   POST /api/orders {"customerId": 0}  →  500 FOREIGN KEY constraint failed
    //
    // Null makes the required check fire where it should — in the browser, with
    // the field's own name on it. Note the deliberate asymmetry with
    // `string: ''` below: a required string left blank also fails, but it fails
    // INFORMATIVELY, and an empty text box is what the user actually sees.
    // There is no such honest empty for a numeric key.
    if (fkFields.has(key)) {
      fieldDefaults[key] = null
      continue
    }

    let type = def.type
    if (!type && def.anyOf) type = def.anyOf.find(t => t.type !== 'null')?.type
    if (Array.isArray(type)) type = type.find(t => t !== 'null')

    // A date-time is left undefined rather than guessed at.
    if (type === 'string' && def.format === 'date-time') {
      fieldDefaults[key] = undefined
      continue
    }

    fieldDefaults[key] = type in TYPE_DEFAULTS ? TYPE_DEFAULTS[type] : null
  }

  return function make(spec) {
    const instance = {}
    for (const key in fieldDefaults) {
      // Cloned, so two instances never share one array or object.
      const val = fieldDefaults[key]
      instance[key] = Array.isArray(val)
        ? []
        : (val !== null && typeof val === 'object') ? {} : val
    }
    return Object.assign(instance, spec ?? {})
  }
}
