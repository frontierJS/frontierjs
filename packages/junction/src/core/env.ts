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

// ─── defineEnv ────────────────────────────────────────────────────────────

export function defineEnv<S extends EnvSpec>(spec: S): EnvOutput<S> {

  const errors:   string[] = []
  const warnings: string[] = []
  const result:   Record<string, unknown> = {}

  for (const [key, field] of Object.entries(spec)) {

    const raw     = process.env[key]
    const present = raw !== undefined && raw !== ''
    const type    = field.type ?? 'string'

    // ── Resolve value (raw → default → undefined) ────────────────
    let value: unknown = present ? raw : field.default

    // ── Required check ────────────────────────────────────────────
    if (field.required && !present && field.default === undefined) {
      errors.push(
        `  ${key} is required but not set` +
        (field.description ? `  (${field.description})` : '') +
        (field.example     ? `\n    example: ${key}="${field.example}"` : '')
      )
      continue
    }

    // ── Nothing to coerce ─────────────────────────────────────────
    if (value === undefined) {
      result[key] = undefined
      continue
    }

    const strValue = String(value)

    // ── Type coercion ─────────────────────────────────────────────
    switch (type) {

      case 'number':
      case 'port': {
        const n = Number(strValue)
        if (isNaN(n)) {
          errors.push(`  ${key}: expected a number, got "${strValue}"`)
          continue
        }
        if (type === 'port' && (n < 1 || n > 65535)) {
          errors.push(`  ${key}: port must be between 1 and 65535, got ${n}`)
          continue
        }
        value = n
        break
      }

      case 'boolean': {
        const t = strValue.toLowerCase()
        if (t === 'true' || t === '1' || t === 'yes') {
          value = true
        } else if (t === 'false' || t === '0' || t === 'no') {
          value = false
        } else {
          errors.push(`  ${key}: expected boolean (true/false/1/0/yes/no), got "${strValue}"`)
          continue
        }
        break
      }

      case 'url': {
        try {
          new URL(strValue)
          value = strValue
        } catch {
          errors.push(`  ${key}: expected a valid URL, got "${strValue}"`)
          continue
        }
        break
      }

      case 'json': {
        try {
          value = JSON.parse(strValue)
        } catch {
          errors.push(`  ${key}: expected valid JSON, got "${strValue.slice(0, 40)}..."`)
          continue
        }
        break
      }

      default: {
        // 'string' — no coercion needed
        value = strValue
      }
    }

    // ── String constraints ─────────────────────────────────────────
    if (typeof value === 'string') {
      if (field.minLength !== undefined && value.length < field.minLength) {
        errors.push(`  ${key}: must be at least ${field.minLength} characters (got ${value.length})`)
        continue
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        errors.push(`  ${key}: must be at most ${field.maxLength} characters (got ${value.length})`)
        continue
      }
      if (field.enum && !field.enum.includes(value)) {
        errors.push(`  ${key}: must be one of [${field.enum.join(', ')}], got "${value}"`)
        continue
      }
    }

    // ── Soft warnings (non-fatal) ─────────────────────────────────
    if (key === 'AUTH_SECRET' || key === 'JWT_SECRET' || key === 'SESSION_SECRET') {
      if (typeof value === 'string' && value.length < 32) {
        warnings.push(`  ${key} is only ${value.length} chars — use at least 32 for security`)
      }
      const weakValues = ['change-me', 'secret', 'password', 'demo', 'dev', 'test', '12345']
      if (typeof value === 'string' && weakValues.some(w => value.toLowerCase().includes(w))) {
        if (process.env.NODE_ENV === 'production') {
          errors.push(`  ${key} looks like a placeholder — set a real secret in production`)
        } else {
          warnings.push(`  ${key} looks like a placeholder — replace before going to production`)
        }
      }
    }

    result[key] = value
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
