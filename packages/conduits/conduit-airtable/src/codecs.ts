// src/codecs.ts — what a field's value means, by the type the schema names it
// (Phase 3, from 0.4's table). Only measured types have a codec; every other
// type passes through untouched, read and write.
//
// Read: Airtable OMITS an empty cell (`""`, `[]`, `false`), so `fillRecord`
// puts back the type's empty value and the caller never confuses empty with
// unknown. A count is never omitted (`0`). Write: a computed field is refused
// by id before the send (C9), a date is ISO or refused (Airtable silently reads
// `11/10/2026` as a date), and `undefined` is refused because only an explicit
// `null` clears (Invariant 9).
//
// Currency (C7): a currency field's options carry a `symbol` and a `precision`
// and never an ISO code, and a `$` is USD, CAD or AUD; `precision` is display
// only and never rounds the stored value. So the cell becomes
// `{ amount, currency }` in minor units only for a field the caller named a code
// for (`currencies: { [fieldId]: 'USD' }`); with no code the number is
// Airtable's own, rounded to nothing, and no currency is guessed.

import { fromMinor, isKnownCurrency, roundMinor, toMinor } from '@frontierjs/toolbelt/units'
import type { AirtableRecord, Field, Money, Table } from './types.ts'

/** A type no write may carry: Airtable computes it and answers `422 … because the field is computed`. */
export const COMPUTED_TYPES: ReadonlySet<string> = new Set([
  'count', 'formula', 'rollup', 'lookup', 'multipleLookupValues', 'createdTime', 'lastModifiedTime', 'autoNumber',
])

export interface CodecOptions {
  /** ISO 4217 code per currency field id. A field with none is left as Airtable's number. */
  currencies?: Record<string, string>
}

const EMPTY: Record<string, () => unknown> = {
  singleLineText: () => '', multilineText: () => '', email: () => '', phoneNumber: () => '', url: () => '',
  multipleRecordLinks: () => [],
  singleSelect: () => null, date: () => null, number: () => null, currency: () => null, singleCollaborator: () => null,
  count: () => 0,
}

/** The empty value Airtable omits for a type, or `undefined` for a type nothing has measured. */
export const emptyOf = (type: string): unknown => EMPTY[type]?.()

function codeOf(field: Field, opts: CodecOptions): string | undefined {
  const code = opts.currencies?.[field.id]
  if (code === undefined) return undefined
  if (!isKnownCurrency(code)) throw new TypeError(`airtable: currencies['${field.id}'] is '${code}', which is not an ISO 4217 code`)
  return code.toUpperCase()
}

/** A cell as the caller reads it. */
export function readValue(field: Field, value: unknown, opts: CodecOptions = {}): unknown {
  if (field.type !== 'currency' || typeof value !== 'number') return value
  const code = codeOf(field, opts)
  if (!code) return value
  // `precision` is how Airtable displays the cell, not what it stores (1234.5 under precision 0 reads 1234.5), so the minor units are the stored value's.
  return { amount: toMinor(value, code), currency: code } satisfies Money
}

/** A record with every field the schema names present: a cell Airtable omitted is its type's empty value. `only` narrows to the fields a read asked for. */
export function fillRecord(record: AirtableRecord, table: Table, opts: CodecOptions & { only?: string[] } = {}): AirtableRecord {
  const fields: Record<string, unknown> = {}
  for (const id of opts.only ?? Object.keys(table.fields)) {
    const field = table.fields[id]
    if (!field) continue
    if (id in record.fields) fields[id] = readValue(field, record.fields[id], opts)
    else {
      const empty = emptyOf(field.type)
      if (empty !== undefined) fields[id] = empty
    }
  }
  return { ...record, fields }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const isoDate = (s: string) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/** One cell as the wire takes it. A refusal here is the vendor's, made first and in a sentence for the caller (C9). */
export function writeValue(field: Field | undefined, key: string, value: unknown, opts: CodecOptions = {}): unknown {
  if (value === undefined) throw new TypeError(`airtable: '${key}' is undefined; only an explicit null clears a cell`)
  if (!field) return value
  if (COMPUTED_TYPES.has(field.type)) throw new TypeError(`airtable: '${field.name}' (${key}) is a ${field.type} field, which Airtable computes and a write may not carry`)
  if (field.type === 'date') {
    if (value !== null && !(typeof value === 'string' && isoDate(value))) throw new TypeError(`airtable: '${field.name}' (${key}) is a date, YYYY-MM-DD, got ${JSON.stringify(value)}; Airtable would silently reinterpret anything else`)
    return value
  }
  if (field.type === 'currency' && value !== null) {
    const code = codeOf(field, opts)
    if (!code) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`airtable: '${field.name}' (${key}) is a currency, a number, got ${JSON.stringify(value)}`)
      return value
    }
    const m = value as Partial<Money>
    if (!m || typeof m !== 'object' || m.currency !== code || !Number.isSafeInteger(m.amount)) {
      throw new TypeError(`airtable: '${field.name}' (${key}) is ${code}; write { amount: <integer minor units>, currency: '${code}' }, never a major-unit number`)
    }
    return fromMinor(roundMinor(m.amount!), code)
  }
  return value
}

/** A write's fields, keyed by field id and nothing else: a name would stop matching on a rename (`FJS-D2053`). */
export function writeFields(fields: Record<string, unknown>, table?: Table, opts: CodecOptions = {}): Record<string, unknown> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('airtable: a record is { fields: { fldXXXXXXXXXXXXXX: value } }')
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!/^fld[A-Za-z0-9]{14}$/.test(key)) throw new TypeError(`airtable: a write keys a field by its id, fldXXXXXXXXXXXXXX, got '${key}'; a name stops matching when the base's owner renames it`)
    if (table && !table.fields[key]) throw new TypeError(`airtable: '${key}' is not a field of table '${table.name}'`)
    out[key] = writeValue(table?.fields[key], key, value, opts)
  }
  return out
}

/** The id of a field by its name in this schema, for a caller that holds names. A name is ambiguous only if the owner made two alike, and then it is refused. */
export function fieldId(table: Table, name: string): string {
  const hits = Object.values(table.fields).filter(f => f.name === name)
  if (hits.length !== 1) throw new TypeError(`airtable: table '${table.name}' has ${hits.length} fields named '${name}'`)
  return hits[0].id
}
