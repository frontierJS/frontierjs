// src/formula.ts — the ONE builder of `filterByFormula` (Invariant 8, applied to
// Airtable's formula language).
//
// A caller's value is always a quoted, escaped string literal; a field is always
// `{fldXXXXXXXXXXXXXX}` by id and a name never reaches the text; and a `Formula`
// is the only thing a read accepts, so a hand-built string is refused where it
// would be sent. A value holding `'` closes the literal early and what follows
// is formula text, so the quote and the backslash are escaped (Airtable's
// documented escapes: `\'`, `\"`, `\\`, `\n`).

const FIELD_ID = /^fld[A-Za-z0-9]{14}$/
const issued = new WeakSet<object>()

/** A formula the builder made. There is no constructor: the only way to one is a combinator below. */
export interface Formula { readonly text: string }

const make = (text: string): Formula => { const f = Object.freeze({ text }); issued.add(f); return f }

export const isFormula = (v: unknown): v is Formula => typeof v === 'object' && v !== null && issued.has(v)

export type FormulaValue = string | number | boolean

const ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** A string as a literal. Never exported: every caller's text goes through `eq`. */
const quote = (s: string): string => `'${s.replace(/[\\'\n\r\t]/g, c => ESCAPES[c])}'`

function ref(field: string): string {
  if (!FIELD_ID.test(field)) throw new TypeError(`airtable: a formula names a field by its id, fldXXXXXXXXXXXXXX, got '${String(field)}'`)
  return `{${field}}`
}

function literal(value: FormulaValue): string {
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE()' : 'FALSE()'
  throw new TypeError(`airtable: a formula value is a string, a finite number or a boolean, got ${String(value)}`)
}

function part(f: Formula): string {
  if (!isFormula(f)) throw new TypeError('airtable: a formula combinator takes formulas built here, never a string')
  return f.text
}

/** `{fldX} = 'value'` */
export const eq = (field: string, value: FormulaValue): Formula => make(`${ref(field)} = ${literal(value)}`)

export function and(...parts: Formula[]): Formula {
  if (!parts.length) throw new TypeError('airtable: and() needs at least one formula')
  return make(`AND(${parts.map(part).join(', ')})`)
}

export function or(...parts: Formula[]): Formula {
  if (!parts.length) throw new TypeError('airtable: or() needs at least one formula')
  return make(`OR(${parts.map(part).join(', ')})`)
}

export const not = (f: Formula): Formula => make(`NOT(${part(f)})`)

/** Rows created after an instant: `findCreated`'s window (C6). */
export function createdSince(when: string | number | Date): Formula {
  const ms = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when)
  if (!Number.isFinite(ms)) throw new TypeError(`airtable: createdSince takes a date, got '${String(when)}'`)
  return make(`IS_AFTER(CREATED_TIME(), ${quote(new Date(ms).toISOString())})`)
}
