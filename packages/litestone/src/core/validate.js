// validate.js — field-level validation and transform engine
//
// Field-level validators (declared in schema.lite):
//   String:  @email, @url, @datetime, @regex, @length, @startsWith, @endsWith, @contains
//   Number:  @lt, @lte, @gt, @gte
//   Any:     custom message via second argument
//
// String transforms (applied BEFORE validation and write):
//   @trim, @lower, @upper
//
// Model-level cross-field rules (defined in extensions as $validate):
//   { check: data => boolean, message: string, path?: string[] }
//
// All validators skip null/undefined values — use NOT NULL in schema for required fields.

// ─── Error type ───────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  /**
   * @param {Array<{ path: string[], message: string }>} errors
   */
  constructor(errors) {
    // An empty path is a record-level refusal — a `@@check` spans columns, so
    // there is no box to name — and joining it anyway produced a leading `: `.
    const summary = errors.map(e =>
      (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).join(', ')
    super(`Validation failed — ${summary}`)
    this.name       = 'ValidationError'
    this.errors     = errors   // [{ path: ['field'], message: 'msg' }]
  }
}

// ─── Built-in validators ──────────────────────────────────────────────────────

const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE      = /^https?:\/\/.+/
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/
// 24-hour clock with leading zeros required. Range 00:00 → 23:59. Under
// `@time(seconds: true)` the seconds are OPTIONAL — 00:00 and 00:00:00 are both
// accepted — because the flag widens what may be stored and does not make a
// finer value mandatory. Strict leading zeros mean values sort lexicographically
// the same as numerically — important for ORDER BY in admin queries that don't
// bother parsing.
const TIME_RE_HM   = /^([01]\d|2[0-3]):[0-5]\d$/
const TIME_RE_HMS  = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

/**
 * The same two rules as a JSON Schema `pattern`, for the emitter.
 *
 * A pattern rather than `format: 'time'`, because RFC 3339 full-time — which
 * is what that format means — requires both seconds and an offset, and `@time`
 * requires neither and admits no offset at all. A consumer honouring the format
 * would refuse `09:30`, which the Data boundary accepts.
 */
export const TIME_PATTERNS = {
  hm:  TIME_RE_HM.source,
  hms: TIME_RE_HMS.source,
}
// E.164 international format + common local formats
const PHONE_RE    = /^\+?[\d\s\-().]{7,20}$/

const VALIDATORS = {
  // String validators
  email:       (v)          => EMAIL_RE.test(String(v)),
  url:         (v)          => URL_RE.test(String(v)),
  date:        (v)          => DATE_RE.test(String(v)),
  datetime:    (v)          => ISO_DATE_RE.test(String(v)),
  // @time(seconds: true) accepts HH:MM:SS as well as HH:MM. Default is
  // strict HH:MM (no seconds). Either form: 24-hour, leading zeros.
  time:        (v, seconds) => seconds
                                 ? TIME_RE_HMS.test(String(v))
                                 : TIME_RE_HM.test(String(v)),
  phone:       (v)          => PHONE_RE.test(String(v)),
  regex:       (v, pattern) => new RegExp(pattern).test(String(v)),
  length:      (v, min, max) => {
    const len = String(v).length
    if (min != null && len < min) return false
    if (max != null && len > max) return false
    return true
  },
  startsWith:  (v, text)    => String(v).startsWith(text),
  endsWith:    (v, text)    => String(v).endsWith(text),
  contains:    (v, text)    => String(v).includes(text),

  // Number validators
  lt:   (v, n) => Number(v) <  Number(n),
  lte:  (v, n) => Number(v) <= Number(n),
  gt:   (v, n) => Number(v) >  Number(n),
  gte:  (v, n) => Number(v) >= Number(n),

  // Array validators. The value IS the array — every other validator here is
  // handed one element's worth of value, and these are handed the whole column.
  minItems:    (v, n) => v.length >= n,
  maxItems:    (v, n) => v.length <= n,
  uniqueItems: (v)    => new Set(v.map(String)).size === v.length,

  // Exact numbers. A scaled column holds the value with the point moved, so
  // what a caller sends is the WHOLE number of minor units — 1299, not 12.99.
  // Without this the refusal came from SQLite, which says `cannot store REAL
  // value in INTEGER column p.total`: a true sentence about a physical column
  // that tells nobody what to send instead (`FJS-D142`).
  scale:       (v)    => Number.isInteger(typeof v === 'string' ? Number(v) : v),
  money:       (v)    => Number.isInteger(typeof v === 'string' ? Number(v) : v),
}

// What an array column's elements have to be. Only the two kinds SQLite cannot
// tell apart from the outside: the column is a JSON document either way, so
// `Int[]` given ['a'] stores and reads back with nothing raised.
export const ARRAY_ELEMENTS = {
  Int:    { label: 'integers', test: (v) => Number.isInteger(v) },
  String: { label: 'strings',  test: (v) => typeof v === 'string' },
}

export const DEFAULT_MESSAGES = {
  email:      () => 'must be a valid email address',
  url:        () => 'must be a valid URL',
  phone:      () => 'must be a valid phone number',
  date:       () => 'must be a valid date in YYYY-MM-DD format (e.g. 2026-04-06)',
  datetime:   () => 'must be a valid ISO 8601 datetime',
  time:       (seconds) => seconds
                            ? 'must be a 24-hour time in HH:MM or HH:MM:SS format (e.g. 09:30 or 09:30:45)'
                            : 'must be a 24-hour time in HH:MM format (e.g. 09:30)',
  regex:      (p) => `must match pattern ${p}`,
  length:     (min, max) => {
    if (min != null && max != null) return `length must be between ${min} and ${max}`
    if (min != null) return `length must be at least ${min}`
    return `length must be at most ${max}`
  },
  startsWith: (t) => `must start with "${t}"`,
  endsWith:   (t) => `must end with "${t}"`,
  contains:   (t) => `must contain "${t}"`,
  lt:         (n) => `must be less than ${n}`,
  lte:        (n) => `must be at most ${n}`,
  gt:         (n) => `must be greater than ${n}`,
  gte:        (n) => `must be at least ${n}`,
  minItems:    (n) => `must have at least ${n} item(s)`,
  maxItems:    (n) => `must have at most ${n} item(s)`,
  uniqueItems: ()  => 'must have unique items',
  // The scale is named because it is the whole of what the caller has to know:
  // at 2 places £12.99 is 1299, and at 0 places ¥1235 is 1235.
  scale:       (n) => `must be a whole number of minor units — the column holds ${n} decimal place(s), so 12.99 is 1299`,
  money:       (c) => `must be a whole number of minor units${c ? ` of ${c}` : ''} — 12.99 is 1299`,
  // The two array rules that come from the TYPE rather than an attribute. They
  // are in this table for the same reason as the rest: it is the one definition
  // of the wording, and `x-messages` falls back to it.
  array:       ()  => 'must be an array',
  arrayItems:  (t) => `must contain only ${t}`,
}

// ─── Transform engine ─────────────────────────────────────────────────────────
// Mutates a copy of data — called BEFORE validation and write

// ─── Slugify ──────────────────────────────────────────────────────────────────
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // strip non-alphanumeric except spaces and hyphens
    .replace(/[\s_]+/g, '-')    // spaces/underscores → hyphens
    .replace(/-+/g, '-')        // collapse multiple hyphens
    .replace(/^-+|-+$/g, '')    // strip leading/trailing hyphens
}

export function applyTransforms(data, model) {
  const out = { ...data }

  for (const field of model.fields) {
    if (!(field.name in out) || out[field.name] == null) continue

    // Auto-coerce JS Date objects on DateTime fields to ISO 8601 strings.
    // Without this, `expiresAt: new Date()` would fail validation because
    // `String(new Date())` produces the human-readable form, not ISO.
    // Numbers (millisecond timestamps) get the same treatment for parity
    // with what `new Date(ms).toISOString()` would have produced if the
    // user had wrapped it themselves.
    if (field.type.name === 'DateTime') {
      const v = out[field.name]
      if (v instanceof Date) {
        out[field.name] = v.toISOString()
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        out[field.name] = new Date(v).toISOString()
      }
    }

    for (const attr of field.attributes) {
      switch (attr.kind) {
        case 'trim':  out[field.name] = String(out[field.name]).trim();          break
        case 'lower': out[field.name] = String(out[field.name]).toLowerCase();   break
        case 'upper': out[field.name] = String(out[field.name]).toUpperCase();   break
        case 'slug':  out[field.name] = slugify(out[field.name]);                break
      }
    }
  }

  return out
}

// ─── Typed JSON validation ───────────────────────────────────────────────────
// When a Json field has @type(T), validate the JSON value against the type's
// shape. Recursive — type fields can themselves be Json @type(Other).
//
// `value` should already be parsed (an object/array, not a JSON string).
// The path array is built up so error messages point at the right location.

function validateTypedJson(value, typeName, typeMap, strict, path, errors) {
  const type = typeMap?.get(typeName)
  if (!type) return  // unknown type — should have been caught at parse time

  // Null/undefined values are allowed at the field level (the field itself
  // governs nullability via the field type, not the @type annotation).
  if (value == null) return

  // The value must be an object (not an array, not a primitive).
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: `must be an object matching type ${typeName}` })
    return
  }

  // Strict mode: reject unknown keys.
  if (strict) {
    const declaredKeys = new Set(type.fields.map(f => f.name))
    for (const key of Object.keys(value)) {
      if (!declaredKeys.has(key)) {
        errors.push({ path: [...path, key], message: `unknown field — type ${typeName} has no '${key}' (set strict: false to allow)` })
      }
    }
  }

  // Validate each declared field.
  for (const field of type.fields) {
    const fieldValue = value[field.name]
    const fieldPath  = [...path, field.name]

    // Required vs optional
    if (fieldValue == null) {
      if (!field.type.optional) {
        // @required("…") carries the wording for this one rule. It does not
        // create it — the absence of `?` above did — so an @required on an
        // optional field is a parse error rather than a silently dead message.
        const custom = field.attributes?.find(a => a.kind === 'required')?.message
        errors.push({ path: fieldPath, message: custom ?? 'is required' })
      }
      continue
    }

    // Underlying-type check
    if (field.type.array) {
      if (!Array.isArray(fieldValue)) {
        errors.push({ path: fieldPath, message: `must be an array of ${field.type.name}` })
        continue
      }
    } else {
      const expected = field.type.name
      if (expected === 'String'     && typeof fieldValue !== 'string') errors.push({ path: fieldPath, message: 'must be a string' })
      else if (expected === 'Int' && (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue))) errors.push({ path: fieldPath, message: 'must be an integer' })
      else if (expected === 'Float'    && typeof fieldValue !== 'number') errors.push({ path: fieldPath, message: 'must be a number' })
      else if (expected === 'Boolean' && typeof fieldValue !== 'boolean') errors.push({ path: fieldPath, message: 'must be a boolean' })
      else if (expected === 'DateTime' && typeof fieldValue !== 'string') errors.push({ path: fieldPath, message: 'must be a string in ISO 8601 format' })
      else if (expected === 'DateTime' && typeof fieldValue === 'string' && !ISO_DATE_RE.test(fieldValue)) errors.push({ path: fieldPath, message: 'must be a valid ISO 8601 datetime' })
      else if (expected === 'Json') {
        // Nested Json @type(Other) — recurse
        const nestedTypeAttr = field.attributes.find(a => a.kind === 'type')
        if (nestedTypeAttr) {
          validateTypedJson(fieldValue, nestedTypeAttr.name, typeMap, nestedTypeAttr.strict !== false, fieldPath, errors)
        }
      }
    }

    // Field-level validators (@email, @regex, @length, ...) work the same
    // inside a type as on a column.
    const fieldErrors = validateField(field.name, fieldValue, field.attributes)
    for (const err of fieldErrors) {
      // Re-anchor the path under the JSON sub-tree.
      errors.push({ path: [...path, ...err.path], message: err.message })
    }
  }
}

// ─── Field validation ─────────────────────────────────────────────────────────

/**
 * Every field-level validator on one value, as the errors they raise.
 *
 * Exported for ONE caller and the reason is the repo's rule about second
 * copies: `generateValidationCases` has to know whether a value it invented
 * satisfies the OTHER rules on the same field, and the only honest answer to
 * *is this a valid email* is the function that decides it on a write. A table
 * of formats in the generator would be a second definition of every rule here,
 * drifting the moment one of them is tuned.
 */
export function validateField(fieldName, value, attributes) {
  const errors = []

  for (const attr of attributes) {
    const kind = attr.kind

    // Skip non-validator attrs
    if (!VALIDATORS[kind]) continue

    // Skip null/undefined — NOT NULL is enforced by the DB, not here
    if (value == null) continue

    // Get custom message if provided
    const customMsg = attr.message ?? null

    let pass = false
    let defaultMsg = ''

    switch (kind) {
      case 'email':
      case 'url':
      case 'phone':
      case 'date':
      case 'datetime':
        pass       = VALIDATORS[kind](value)
        defaultMsg = DEFAULT_MESSAGES[kind]()
        break

      case 'scale':
        pass       = VALIDATORS.scale(value)
        defaultMsg = DEFAULT_MESSAGES.scale(attr.places)
        break

      case 'money':
        pass       = VALIDATORS.money(value)
        defaultMsg = DEFAULT_MESSAGES.money(attr.currency)
        break

      case 'time':
        // @time(seconds: true) accepts HH:MM:SS as well as HH:MM. Default
        // (seconds: false) accepts HH:MM only — strict 24-hour clock format
        // with leading zeros required so admin tools can sort lexicographically.
        pass       = VALIDATORS.time(value, attr.seconds === true)
        defaultMsg = DEFAULT_MESSAGES.time(attr.seconds === true)
        break

      case 'regex':
        pass       = VALIDATORS.regex(value, attr.pattern)
        defaultMsg = DEFAULT_MESSAGES.regex(attr.pattern)
        break

      case 'length':
        pass       = VALIDATORS.length(value, attr.min, attr.max)
        defaultMsg = DEFAULT_MESSAGES.length(attr.min, attr.max)
        break

      case 'startsWith':
      case 'endsWith':
      case 'contains':
        pass       = VALIDATORS[kind](value, attr.text)
        defaultMsg = DEFAULT_MESSAGES[kind](attr.text)
        break

      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        pass       = VALIDATORS[kind](value, attr.value)
        defaultMsg = DEFAULT_MESSAGES[kind](attr.value)
        break

      case 'minItems':
      case 'maxItems':
      case 'uniqueItems':
        // A non-array here has already been reported for its shape; asking a
        // count rule about it would answer the same complaint twice in
        // different words.
        if (!Array.isArray(value)) continue
        pass       = VALIDATORS[kind](value, attr.value)
        defaultMsg = DEFAULT_MESSAGES[kind](attr.value)
        break

      default:
        continue
    }

    if (!pass) {
      errors.push({ path: [fieldName], message: customMsg ?? defaultMsg })
    }
  }

  return errors
}

// ─── Model validation ─────────────────────────────────────────────────────────
// Runs all field-level validators + model-level $validate rules from extensions.
// `typeMap` (optional) is a Map<typeName, typeDecl> used when a field has
// `Json @type(T)` — the JSON value is recursively validated against the type's
// shape. Throws ValidationError if anything fails.

export function validate(data, model, computedFns, typeMap) {
  const errors = []

  // Field-level validators
  for (const field of model.fields) {
    if (!(field.name in data)) continue
    const value = data[field.name]

    // Auto-validate DateTime fields — ISO 8601 is the enforced convention
    if (field.type.name === 'DateTime' && value != null) {
      if (!ISO_DATE_RE.test(String(value))) {
        errors.push({
          path:    [field.name],
          message: 'must be a valid ISO 8601 datetime (e.g. 2024-01-15T09:30:00Z)',
        })
      }
    }

    // An array column's SHAPE, before its rules. `@minItems` asked about a
    // string answers by its length, which is a plausible wrong answer rather
    // than a refusal; and the element check exists because SQLite stores the
    // column as a JSON document whichever type the elements are.
    if (field.type.array && value != null) {
      if (!Array.isArray(value)) {
        errors.push({ path: [field.name], message: DEFAULT_MESSAGES.array() })
        continue
      }
      const el = ARRAY_ELEMENTS[field.type.name]
      if (el && !value.every(el.test)) {
        errors.push({ path: [field.name], message: DEFAULT_MESSAGES.arrayItems(el.label) })
        continue
      }
    }

    const fieldErrors = validateField(field.name, value, field.attributes)
    errors.push(...fieldErrors)

    // Typed JSON: if this is a Json field with @type(T), validate the value
    // against the type's shape. Skips if no typeMap was passed.
    if (typeMap && field.type.name === 'Json' && value != null) {
      const typeAttr = field.attributes.find(a => a.kind === 'type')
      if (typeAttr) {
        validateTypedJson(value, typeAttr.name, typeMap, typeAttr.strict !== false, [field.name], errors)
      }
    }
  }

  // Model-level cross-field validators from extensions ($validate array)
  const modelExts  = computedFns?.[model.name]
  const modelRules = modelExts?.$validate ?? []

  for (const rule of modelRules) {
    let pass
    try {
      pass = rule.check(data)
    } catch (e) {
      errors.push({ path: rule.path ?? ['_model'], message: `Validator threw: ${e.message}` })
      continue
    }
    if (!pass) {
      errors.push({ path: rule.path ?? ['_model'], message: rule.message ?? 'Validation failed' })
    }
  }

  if (errors.length > 0) throw new ValidationError(errors)
}

// ─── Schema analysis ──────────────────────────────────────────────────────────
// Pre-compute which models have any validators — skip validate() call if none.

export function buildValidationMap(schema) {
  const VALIDATOR_KINDS = new Set([
    'email','url','phone','date','datetime','time','regex','length','startsWith','endsWith',
    'contains','lt','lte','gt','gte','trim','lower','upper',
    'minItems','maxItems','uniqueItems',
    // A scaled column's rule is *a whole number of minor units*, and without it
    // here the model skips the pass entirely and the refusal comes from SQLite
    // naming a physical column.
    'scale','money',
  ])

  const map = {}
  for (const model of schema.models) {
    // Flag if any explicit validator attribute OR any DateTime field
    // (DateTime fields get ISO-8601 auto-validation in validate())
    // OR any Json @type(T) field (typed JSON validates against the type's shape)
    const hasExplicitValidator = model.fields.some(
      f => f.attributes.some(a => VALIDATOR_KINDS.has(a.kind))
    )
    const hasDateTimeField = model.fields.some(
      f => f.type.name === 'DateTime'
    )
    const hasTypedJson = model.fields.some(
      f => f.type.name === 'Json' && f.attributes.some(a => a.kind === 'type')
    )
    // An array field with no attribute at all still needs validate() to run:
    // its shape and its element type are checked there, and a model whose only
    // array column is a bare `String[]` would otherwise skip the pass entirely.
    const hasArrayField = model.fields.some(f => f.type.array)
    map[model.name] = hasExplicitValidator || hasDateTimeField || hasTypedJson || hasArrayField
  }
  return map
}
