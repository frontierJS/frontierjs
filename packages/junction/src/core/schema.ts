// core/schema.ts
// Schema validation — validate request bodies, transform data, apply defaults.
// No external dep. Composable validators. Works as a before hook.
//
// Usage:
//   const UserSchema = createSchema({
//     name:     { type: 'string', required: true, minLength: 2 },
//     email:    { type: 'email',  required: true },
//     age:      { type: 'number', min: 0, max: 150, default: 18 },
//     role:     { type: 'string', enum: ['user', 'admin'], default: 'user' },
//     tags:     { type: 'array',  items: { type: 'string' } },
//     address:  { type: 'object', schema: AddressSchema }
//   })
//
//   service.hooks({
//     before: { create: [validateSchema(UserSchema)] }
//   })

import type { ServiceContext } from './context.ts'
import { partitionBulk }       from './envelope.ts'
import { BadRequest }          from './errors.ts'
import { fieldError }          from './field-errors.ts'

// ─── Field definition ─────────────────────────────────────────────────────

export type FieldType = 'string' | 'number' | 'boolean' | 'date' |
                        'email' | 'url' | 'uuid' | 'array' | 'object' | 'any'

export interface FieldDef {
  type:        FieldType
  required?:   boolean
  default?:    unknown
  nullable?:   boolean
  trim?:       boolean         // string: trim whitespace
  lowercase?:  boolean         // string: to lower
  uppercase?:  boolean         // string: to upper
  minLength?:  number          // string
  maxLength?:  number          // string
  pattern?:    RegExp | string // string regex
  min?:        number          // number: >= (inclusive)
  max?:        number          // number: <= (inclusive)
  exclusiveMin?: number        // number: > (exclusive) — from @gt() in Litestone
  exclusiveMax?: number        // number: < (exclusive) — from @lt() in Litestone
  integer?:    boolean         // number: must be integer
  minItems?:   number          // array: minimum length
  maxItems?:   number          // array: maximum length
  enum?:       unknown[]       // allowed values
  items?:      FieldDef        // array items schema
  schema?:     Schema          // object nested schema
  transform?:  (value: unknown) => unknown
  validate?:   (value: unknown) => string | null  // return error string or null

  /**
   * What a human calls this field — Litestone's `@label`, arriving as JSON
   * Schema `title`. Every generated message below uses it, so an error stops
   * reading `customerId` under a form label that says "customer".
   */
  label?:      string

  /**
   * Author-supplied wording, keyed by the JSON Schema keyword that failed —
   * Litestone's `@length(3, 20, "…")` / `@required("…")`, arriving as
   * `x-messages`. Consulted before the generated sentence, so one string
   * written in db/schema.lite is what the server AND the browser say.
   */
  messages?:   Record<string, string>
}

export type Schema = Record<string, FieldDef>

export interface SchemaOptions {
  /** If true, fields not defined in the schema are passed through unchanged.
   *  Default: false — unknown fields are silently stripped (safer for APIs). */
  passthrough?: boolean
}

// ─── Compiled schema ──────────────────────────────────────────────────────

export interface CompiledSchema<T = Record<string, unknown>> {
  validate:  (data: unknown) => ValidationResult<T>
  parse:     (data: unknown) => T                          // validate + throw on error
  hook:      () => import('./hooks.ts').Hook               // returns a before hook
  partial:   () => CompiledSchema<Partial<T>>              // make all fields optional
  pick:      (...fields: string[]) => CompiledSchema<Partial<T>>
  omit:      (...fields: string[]) => CompiledSchema<Partial<T>>
  /** The raw Schema object this was compiled from.
   *  Used by the OpenAPI generator to produce property-level docs. */
  _schema:   Schema
}

export interface ValidationResult<T = Record<string, unknown>> {
  valid:   boolean
  data:    T
  errors:  ValidationError[]
}

export interface ValidationError {
  field:   string
  message: string
}

// ─── createSchema ─────────────────────────────────────────────────────────

/**
 * Compile a field map into a validator.
 *
 * Optionally state what it parses TO — `createSchema<CreateOrder>({ … })` —
 * and `parse()` answers `CreateOrder` instead of `Record<string, unknown>`,
 * with the field map constrained to that type's keys so a missing or misspelt
 * one is a compile error.
 *
 * The type is stated rather than inferred, and that is the ruling (`FJS-D10`).
 * Deriving it from the field map means building zod inside a framework whose
 * whole thesis is that types come from the seed: a model service is validated
 * by `autoValidate` off the generated JSON Schema and writes no schema at all,
 * so this is the hatch for a shape `db/schema.lite` does not describe — and for
 * that shape the author already has the type.
 */
export function createSchema<T = Record<string, unknown>>(
  schema: T extends Record<string, unknown> ? SchemaFor<T> : Schema,
  opts:   SchemaOptions = {},
): CompiledSchema<T> {
  return buildCompiledSchema(schema as Schema, opts) as CompiledSchema<T>
}

/** A field map that covers every key of `T` and invents none. */
export type SchemaFor<T> = { [K in keyof T]-?: FieldDef }

// Nested object schemas are compiled ONCE per schema object and cached —
// previously buildCompiledSchema() ran on every validate() call for every
// nested field, rebuilding the entire compiled closure set per request.
// WeakMap keying means schema literals shared across createSchema() calls
// compile once and the cache never pins garbage.
const _nestedCompiled = new WeakMap<Schema, CompiledSchema>()

function compileNested(schema: Schema): CompiledSchema {
  let c = _nestedCompiled.get(schema)
  if (!c) {
    c = buildCompiledSchema(schema)
    _nestedCompiled.set(schema, c)
  }
  return c
}

function buildCompiledSchema(schema: Schema, opts: SchemaOptions = {}): CompiledSchema {

  // Pre-compile any string patterns to RegExp once at build time,
  // not on every validate() call.
  for (const def of Object.values(schema)) {
    if (def.pattern && typeof def.pattern === 'string') {
      def.pattern = new RegExp(def.pattern)
    }
  }

  const compiled: CompiledSchema = {

    validate(raw: unknown): ValidationResult {
      const errors: ValidationError[] = []
      const data:   Record<string, unknown> = {}

      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { valid: false, data: {}, errors: [{ field: '_', message: 'Expected an object' }] }
      }

      const input = raw as Record<string, unknown>

      for (const [field, def] of Object.entries(schema)) {
        const rawValue  = input[field]
        const fieldErrs: string[] = []

        let value = rawValue

        // Default
        if (value === undefined || value === null) {
          if (def.default !== undefined) {
            value = typeof def.default === 'function'
              ? (def.default as () => unknown)()
              : def.default
          }
        }

        // Absent key.
        //
        // Presence and nullability are different questions: `nullable` says the
        // VALUE may be null, not that the key must be present. Guarding this
        // branch with `!def.nullable` made it unreachable for nullable fields,
        // so an absent optional field fell through to type validation and was
        // rejected as the wrong type. In Litestone every `String?` is nullable,
        // which meant a model with one optional field could not be created
        // without sending an explicit null for it:
        //
        //   POST /posts {"title":"Hi"}   → 400 body: body must be a string
        //   POST /posts {"title":"Hi","body":null}  → 201
        //
        // i.e. optional fields were mandatory.
        if (value === undefined) {
          if (def.required) {
            errors.push({ field, message: _say(def, 'required', `${_label(field, def)} is required`) })
          }
          continue
        }

        // Explicit null on a field that does not accept it.
        if (value === null && !def.nullable && def.required) {
          errors.push({ field, message: _say(def, 'required', `${_label(field, def)} is required`) })
          continue
        }

        // Null allowed
        if (value === null && def.nullable) {
          data[field] = null
          continue
        }

        // Type coercion + validation
        const result = validateField(field, value, def)
        if (result.errors.length) {
          errors.push(...result.errors)
          continue
        }

        value = result.value

        // Custom validator
        if (def.validate) {
          const msg = def.validate(value)
          if (msg) {
            errors.push({ field, message: msg })
            continue
          }
        }

        // Custom transform
        if (def.transform) {
          value = def.transform(value)
        }

        data[field] = value
      }

      // passthrough: copy unknown keys from input that weren't in the schema
      if (opts.passthrough) {
        for (const key of Object.keys(input)) {
          if (!(key in schema)) data[key] = input[key]
        }
      }

      return { valid: errors.length === 0, data, errors }
    },

    parse(raw: unknown): Record<string, unknown> {
      const result = compiled.validate(raw)
      // Through fieldError() rather than building the throwable here: an app's
      // own business rules produce the same shape through the same function, so
      // a declared rule and a hand-written one cannot report differently.
      if (!result.valid) throw fieldError(result.errors)
      return result.data
    },

    hook() {
      return function validateSchema(ctx: ServiceContext): void {
        if (!ctx.data) throw new BadRequest('Request body is required')

        // A bulk write sends an array. parse() validates one object and
        // rejects an array outright with "Expected an object", so every bulk
        // create 400'd before the service ever saw it — element-wise is the
        // only reading that makes sense here.
        //
        // PARTITIONED, not mapped: throwing on the first bad row would make
        // partial success unreachable. Rejected rows are parked on ctx.locals
        // for the service to pair with their errors in the envelope.
        if (Array.isArray(ctx.data)) {
          ctx.data = partitionBulk(ctx, ctx.data, row => compiled.parse(row) as Record<string, unknown>)
          return
        }

        ctx.data = compiled.parse(ctx.data)
      }
    },

    partial(): CompiledSchema {
      const partialSchema: Schema = {}
      for (const [key, def] of Object.entries(schema)) {
        partialSchema[key] = { ...def, required: false }
      }
      return buildCompiledSchema(partialSchema, opts)
    },

    pick(...fields: string[]): CompiledSchema {
      const picked: Schema = {}
      for (const f of fields) {
        if (schema[f]) picked[f] = schema[f]
      }
      return buildCompiledSchema(picked)
    },

    omit(...fields: string[]): CompiledSchema {
      const omitted: Schema = {}
      for (const [key, def] of Object.entries(schema)) {
        if (!fields.includes(key)) omitted[key] = def
      }
      return buildCompiledSchema(omitted)
    },

    // Exposed for OpenAPI generator — raw schema before compilation
    _schema: schema,
  }

  return compiled
}

// ─── Field validator ──────────────────────────────────────────────────────

interface FieldResult {
  value:  unknown
  errors: ValidationError[]
}

/** What to call a field in a message: `@label`, else the field name. */
const _label = (field: string, def?: FieldDef) => def?.label ?? field

/**
 * The message for a failed rule: whatever the schema declared for it, else the
 * generated sentence. `keyword` is the JSON Schema keyword that failed, which
 * is exactly how `x-messages` is keyed — no mapping table on this side.
 */
const _say = (def: FieldDef | undefined, keyword: string, fallback: string) =>
  def?.messages?.[keyword] ?? fallback

function validateField(field: string, value: unknown, def: FieldDef): FieldResult {
  const errors: ValidationError[] = []

  // Type coercion
  let v = coerce(value, def.type)

  switch (def.type) {

    case 'string': {
      if (typeof v !== 'string') {
        errors.push({ field, message: _say(def, 'type', `${_label(field, def)} must be a string`) })
        break
      }
      if (def.trim)      v = (v as string).trim()
      if (def.lowercase) v = (v as string).toLowerCase()
      if (def.uppercase) v = (v as string).toUpperCase()

      if (def.minLength !== undefined && (v as string).length < def.minLength)
        errors.push({ field, message: _say(def, 'minLength', `${_label(field, def)} must be at least ${def.minLength} characters`) })

      if (def.maxLength !== undefined && (v as string).length > def.maxLength)
        errors.push({ field, message: _say(def, 'maxLength', `${_label(field, def)} must be at most ${def.maxLength} characters`) })

      if (def.pattern) {
        // def.pattern is always a RegExp — pre-compiled in buildCompiledSchema
        if (!(def.pattern as RegExp).test(v as string))
          errors.push({ field, message: _say(def, 'pattern', `${_label(field, def)} format is invalid`) })
      }
      break
    }

    case 'email': {
      if (typeof v !== 'string' || !EMAIL_RE.test(v as string))
        errors.push({ field, message: _say(def, 'format', `${_label(field, def)} must be a valid email address`) })
      else
        v = (v as string).toLowerCase().trim()
      break
    }

    case 'url': {
      try {
        new URL(v as string)
      } catch {
        errors.push({ field, message: _say(def, 'format', `${_label(field, def)} must be a valid URL`) })
      }
      break
    }

    case 'uuid': {
      if (!UUID_RE.test(v as string))
        errors.push({ field, message: `${field} must be a valid UUID` })
      break
    }

    case 'number': {
      if (typeof v !== 'number' || isNaN(v as number))
        errors.push({ field, message: _say(def, 'type', `${_label(field, def)} must be a number`) })
      else {
        if (def.integer && !Number.isInteger(v))
          errors.push({ field, message: _say(def, 'type', `${_label(field, def)} must be an integer`) })
        if (def.min         !== undefined && (v as number) <  def.min)         errors.push({ field, message: _say(def, 'minimum', `${_label(field, def)} must be at least ${def.min}`) })
        if (def.max         !== undefined && (v as number) >  def.max)         errors.push({ field, message: _say(def, 'maximum', `${_label(field, def)} must be at most ${def.max}`) })
        if (def.exclusiveMin !== undefined && (v as number) <= def.exclusiveMin) errors.push({ field, message: _say(def, 'exclusiveMinimum', `${_label(field, def)} must be greater than ${def.exclusiveMin}`) })
        if (def.exclusiveMax !== undefined && (v as number) >= def.exclusiveMax) errors.push({ field, message: _say(def, 'exclusiveMaximum', `${_label(field, def)} must be less than ${def.exclusiveMax}`) })
      }
      break
    }

    case 'boolean': {
      if (typeof v !== 'boolean')
        errors.push({ field, message: _say(def, 'type', `${_label(field, def)} must be a boolean`) })
      break
    }

    case 'date': {
      if (!(v instanceof Date) || isNaN((v as Date).getTime()))
        errors.push({ field, message: `${field} must be a valid date` })
      break
    }

    case 'array': {
      if (!Array.isArray(v)) {
        errors.push({ field, message: _say(def, 'type', `${_label(field, def)} must be an array`) })
        break
      }
      if (def.minItems !== undefined && (v as unknown[]).length < def.minItems)
        errors.push({ field, message: _say(def, 'minItems', `${_label(field, def)} must have at least ${def.minItems} item${def.minItems === 1 ? '' : 's'}.`) })
      if (def.maxItems !== undefined && (v as unknown[]).length > def.maxItems)
        errors.push({ field, message: _say(def, 'maxItems', `${_label(field, def)} must have at most ${def.maxItems} item${def.maxItems === 1 ? '' : 's'}.`) })
      if (def.items) {
        const itemErrors: ValidationError[] = []
        const validated: unknown[] = []
        ;(v as unknown[]).forEach((item, idx) => {
          const r = validateField(`${field}[${idx}]`, item, def.items!)
          if (r.errors.length) itemErrors.push(...r.errors)
          else validated.push(r.value)
        })
        if (itemErrors.length) errors.push(...itemErrors)
        else v = validated
      }
      break
    }

    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        errors.push({ field, message: `${field} must be an object` })
        break
      }
      if (def.schema) {
        const nested = compileNested(def.schema).validate(v)
        if (!nested.valid) {
          errors.push(...nested.errors.map(e => ({ field: `${field}.${e.field}`, message: e.message })))
        } else {
          v = nested.data
        }
      }
      break
    }

    // 'any' — pass through
  }

  // Enum check (after coercion)
  if (!errors.length && def.enum && !def.enum.includes(v)) {
    errors.push({ field, message: _say(def, 'enum', `${_label(field, def)} must be one of: ${def.enum.join(', ')}`) })
  }

  return { value: v, errors }
}

// ─── Type coercion ────────────────────────────────────────────────────────

function coerce(value: unknown, type: FieldType): unknown {
  if (value === undefined || value === null) return value

  switch (type) {
    case 'number':
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        if (!isNaN(n)) return n
      }
      return value

    case 'boolean':
      if (value === 'true'  || value === '1' || value === 1)  return true
      if (value === 'false' || value === '0' || value === 0)  return false
      return value

    case 'date':
      if (typeof value === 'string' || typeof value === 'number') {
        const d = new Date(value)
        if (!isNaN(d.getTime())) return d
      }
      return value

    default:
      return value
  }
}

// ─── Compiled regexes ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Convenience validators ───────────────────────────────────────────────

export const v = {
  string:  (opts?: Partial<FieldDef>): FieldDef => ({ type: 'string',  ...opts }),
  number:  (opts?: Partial<FieldDef>): FieldDef => ({ type: 'number',  ...opts }),
  boolean: (opts?: Partial<FieldDef>): FieldDef => ({ type: 'boolean', ...opts }),
  email:   (opts?: Partial<FieldDef>): FieldDef => ({ type: 'email',   ...opts }),
  url:     (opts?: Partial<FieldDef>): FieldDef => ({ type: 'url',     ...opts }),
  uuid:    (opts?: Partial<FieldDef>): FieldDef => ({ type: 'uuid',    ...opts }),
  date:    (opts?: Partial<FieldDef>): FieldDef => ({ type: 'date',    ...opts }),
  array:   (items?: FieldDef, opts?: Partial<FieldDef>): FieldDef => ({ type: 'array', items, ...opts }),
  object:  (schema?: Schema, opts?: Partial<FieldDef>): FieldDef => ({ type: 'object', schema, ...opts }),
  any:     (opts?: Partial<FieldDef>): FieldDef => ({ type: 'any',     ...opts }),

  // Shorthand required variants — mirrors every type in v.* above
  required: {
    string:  (opts?: Partial<FieldDef>): FieldDef => ({ type: 'string',  required: true, ...opts }),
    number:  (opts?: Partial<FieldDef>): FieldDef => ({ type: 'number',  required: true, ...opts }),
    boolean: (opts?: Partial<FieldDef>): FieldDef => ({ type: 'boolean', required: true, ...opts }),
    email:   (opts?: Partial<FieldDef>): FieldDef => ({ type: 'email',   required: true, ...opts }),
    url:     (opts?: Partial<FieldDef>): FieldDef => ({ type: 'url',     required: true, ...opts }),
    uuid:    (opts?: Partial<FieldDef>): FieldDef => ({ type: 'uuid',    required: true, ...opts }),
    date:    (opts?: Partial<FieldDef>): FieldDef => ({ type: 'date',    required: true, ...opts }),
    array:   (items?: FieldDef, opts?: Partial<FieldDef>): FieldDef => ({ type: 'array', items, required: true, ...opts }),
    object:  (schema?: Schema, opts?: Partial<FieldDef>): FieldDef => ({ type: 'object', schema, required: true, ...opts }),
  }
}
