// core/env.ts
// Typed, validated environment variable loading.
//
// Define the shape of your environment once. The result is fully typed —
// required vars are `string`, optional ones are `string | undefined`,
// typed vars (number, boolean, url, etc.) are their actual types.
// Missing required vars throw at startup with a clear, actionable message.
//
// Usage:
//
//   import { defineEnv } from '@frontierjs/junction'
//
//   export const env = defineEnv({
//     DATABASE_URL:   { required: true },
//     AUTH_SECRET:    { required: true, minLength: 32 },
//     PORT:           { type: 'number', default: 3000 },
//     DEBUG:          { type: 'boolean', default: false },
//     NODE_ENV:       { default: 'development' },
//     RESEND_API_KEY: {},                                  // optional string
//   })
//
//   env.DATABASE_URL   // string (guaranteed present)
//   env.PORT           // number
//   env.DEBUG          // boolean
//   env.RESEND_API_KEY // string | undefined
//
// Generation:
//
//   printEnvExample(spec)  // prints an .env.example to stdout
//   generateEnvExample(spec)  // returns the string

import { colorEnabled } from './logger.ts'

// Env validation runs before an app — and therefore before its logger —
// exists, so these are written straight to stderr. The colour gate is
// logger.ts's rather than a second copy of the predicate.
const YELLOW = colorEnabled ? '\x1b[33m' : ''
const RED    = colorEnabled ? '\x1b[91m' : ''
const RESET  = colorEnabled ? '\x1b[0m'  : ''

// ─── Field spec ───────────────────────────────────────────────────────────

export type EnvType = 'string' | 'number' | 'boolean' | 'url' | 'port' | 'json'

export interface EnvFieldSpec {
  /** If true, throws at startup if the var is missing or empty. */
  required?:   boolean

  /** Runtime type. Coercion is applied before validation.
   *  Default: 'string' */
  type?:       EnvType

  /** Default value used when the env var is absent.
   *  Making a field required + default is allowed — the default is used
   *  in development if the var isn't set. */
  default?:    unknown

  /** Minimum string length (for type: 'string' or default 'string'). */
  minLength?:  number

  /** Maximum string length. */
  maxLength?:  number

  /** Allowed values. */
  enum?:       string[]

  /** Description — appears in generated .env.example comments. */
  description?: string

  /** Example value for .env.example generation. */
  example?:    string
}

export type EnvSpec = Record<string, EnvFieldSpec>

// ─── Inferred output types ────────────────────────────────────────────────
//
// These conditional types map each field spec to its TypeScript output type
// so the returned object is fully typed without any casting.
//
// Rules:
//  - required: true               → the raw type (never undefined)
//  - default present              → the raw type (never undefined)
//  - otherwise                    → raw type | undefined
//
// "raw type" is determined by the `type` field:
//   'string' | default            → string
//   'number' | 'port'             → number
//   'boolean'                     → boolean
//   'url'                         → string  (validated as URL)
//   'json'                        → unknown (parsed JSON)

type RawType<F extends EnvFieldSpec> =
  F['type'] extends 'number' | 'port' ? number :
  F['type'] extends 'boolean'          ? boolean :
  F['type'] extends 'json'             ? unknown :
  string   // 'string' | 'url' | undefined type

type IsDefinitelyPresent<F extends EnvFieldSpec> =
  F['required'] extends true ? true :
  'default' extends keyof F ? true : false

type EnvFieldOutput<F extends EnvFieldSpec> =
  IsDefinitelyPresent<F> extends true ? RawType<F> : RawType<F> | undefined

export type EnvOutput<S extends EnvSpec> = {
  readonly [K in keyof S]: EnvFieldOutput<S[K]>
}

// ─── checkEnvField ────────────────────────────────────────────────────────
//
// Does this raw value satisfy this field spec? One owner, because there are
// now two callers asking it — `defineEnv` over a whole spec, and the
// attachment check over the keys one declared service needs. A second copy
// would answer *is this a URL* twice, and the two would drift on the day
// somebody adds a type.
//
// It takes the raw value rather than reading `process.env` itself, which is
// what lets an attachment be graded against a hypothetical environment and
// what makes either caller testable at all.

export interface EnvFieldResult {
  /** The coerced value, or undefined when absent and not defaulted. */
  value:    unknown
  /** The failure, already worded for a person. Absent means it passed. */
  error?:   string
  /** Non-fatal notes, same wording rules. */
  warnings: string[]
  /** Was the variable actually set, before defaults were considered? */
  present:  boolean
}

export function checkEnvField(key: string, field: EnvFieldSpec, raw: string | undefined): EnvFieldResult {
  const warnings: string[] = []
  const present = raw !== undefined && raw !== ''
  const type    = field.type ?? 'string'

  const fail = (error: string): EnvFieldResult => ({ value: undefined, error, warnings, present })

  let value: unknown = present ? raw : field.default

  if (field.required && !present && field.default === undefined)
    return fail(
      `${key} is required but not set` +
      (field.description ? `  (${field.description})` : '') +
      (field.example     ? `\n    example: ${key}="${field.example}"` : '')
    )

  if (value === undefined) return { value: undefined, warnings, present }

  const strValue = String(value)

  switch (type) {
    case 'number':
    case 'port': {
      const n = Number(strValue)
      if (isNaN(n)) return fail(`${key}: expected a number, got "${strValue}"`)
      if (type === 'port' && (n < 1 || n > 65535))
        return fail(`${key}: port must be between 1 and 65535, got ${n}`)
      value = n
      break
    }

    case 'boolean': {
      const t = strValue.toLowerCase()
      if (t === 'true' || t === '1' || t === 'yes') value = true
      else if (t === 'false' || t === '0' || t === 'no') value = false
      else return fail(`${key}: expected boolean (true/false/1/0/yes/no), got "${strValue}"`)
      break
    }

    case 'url': {
      try { new URL(strValue); value = strValue }
      catch { return fail(`${key}: expected a valid URL, got "${strValue}"`) }
      break
    }

    case 'json': {
      try { value = JSON.parse(strValue) }
      catch { return fail(`${key}: expected valid JSON, got "${strValue.slice(0, 40)}..."`) }
      break
    }

    default:
      value = strValue
  }

  if (typeof value === 'string') {
    if (field.minLength !== undefined && value.length < field.minLength)
      return fail(`${key}: must be at least ${field.minLength} characters (got ${value.length})`)
    if (field.maxLength !== undefined && value.length > field.maxLength)
      return fail(`${key}: must be at most ${field.maxLength} characters (got ${value.length})`)
    if (field.enum && !field.enum.includes(value))
      return fail(`${key}: must be one of [${field.enum.join(', ')}], got "${value}"`)
  }

  // Graded BY NAME and only when the app declares them. Junction reads none of
  // them — a session issued by @frontierjs/auth is a row found by a random
  // token, and there is no `auth.secret` in AppConfig — so this is a courtesy
  // to an app holding its own signing key, never a sign that the framework is
  // using the value. Reading it the other way is how `AUTH_SECRET` came to be
  // generated, declared and required across three packages with no reader
  // anywhere (FJS-360).
  if (key === 'AUTH_SECRET' || key === 'JWT_SECRET' || key === 'SESSION_SECRET') {
    if (typeof value === 'string' && value.length < 32)
      warnings.push(`${key} is only ${value.length} chars — use at least 32 for security`)
    const weakValues = ['change-me', 'secret', 'password', 'demo', 'dev', 'test', '12345']
    if (typeof value === 'string' && weakValues.some(w => value.toLowerCase().includes(w))) {
      if (process.env.NODE_ENV === 'production')
        return fail(`${key} looks like a placeholder — set a real secret in production`)
      warnings.push(`${key} looks like a placeholder — replace before going to production`)
    }
  }

  return { value, warnings, present }
}

// ─── defineEnv ────────────────────────────────────────────────────────────

export function defineEnv<S extends EnvSpec>(spec: S): EnvOutput<S> {

  const errors:   string[] = []
  const warnings: string[] = []
  const result:   Record<string, unknown> = {}

  for (const [key, field] of Object.entries(spec)) {
    const r = checkEnvField(key, field, process.env[key])
    // Two spaces, because these are rendered as an indented block below.
    for (const w of r.warnings) warnings.push(`  ${w}`)
    if (r.error) { errors.push(`  ${r.error}`); continue }
    result[key] = r.value
  }

  // ── Emit warnings ─────────────────────────────────────────────────
  if (warnings.length) {
    for (const w of warnings) {
      process.stderr.write(`${YELLOW}[env warn]${RESET} ${w}\n`)
    }
  }

  // ── Throw on errors ───────────────────────────────────────────────
  if (errors.length) {
    const lines = [
      '',
      `${RED}[env] Environment configuration errors${RESET}`,
      '',
      ...errors,
      '',
      'Set the missing variables in your .env file and restart.',
      '',
    ]
    throw new Error(lines.join('\n'))
  }

  return result as EnvOutput<S>
}

// ─── generateEnvExample ───────────────────────────────────────────────────
// Produces the contents of a .env.example file from a spec.
// Generates once during init or by running `node -e "require('./env').printEnvExample()"`

export function generateEnvExample(spec: EnvSpec): string {
  const lines: string[] = [
    '# Environment variables',
    '# Copy this file to .env and fill in your values.',
    '# Lines starting with # are comments.',
    '',
  ]

  for (const [key, field] of Object.entries(spec)) {
    if (field.description) {
      lines.push(`# ${field.description}`)
    }

    const required = field.required ? 'required' : ''
    const typeNote = field.type && field.type !== 'string' ? ` [${field.type}]` : ''
    const meta     = `${required}${typeNote}`.trim()
    if (meta) lines.push(`# ${meta}`)

    const exampleVal  = field.example
      ?? (field.default !== undefined ? String(field.default) : '')
    const placeholder = field.required && !exampleVal ? 'your_value_here' : exampleVal

    lines.push(`${key}="${placeholder}"`)
    lines.push('')
  }

  return lines.join('\n')
}

export function printEnvExample(spec: EnvSpec): void {
  process.stdout.write(generateEnvExample(spec))
}
