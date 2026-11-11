// @frontierjs/conduit-airtable — Airtable over conduit (`IDEAS/conduit-airtable.md`).
//
// ─── One target, a bearer ────────────────────────────────────────────────
// `airtableTarget({ ref })` is a personal access token spent as `Authorization:
// Bearer` at `https://api.airtable.com` (C1; the builder returns, the app
// installs). A PAT reaches every base its owner shared with it, so the BASE is
// a call's argument, not the target's. An OAuth person's token is Phase 5.
//
// ─── Fields are keyed by id, always ──────────────────────────────────────
// `returnFieldsByFieldId: true` is in the BODY of every `POST …/listRecords`,
// create, `PATCH` and upsert: the query form is ignored on a single-record
// write (measured), so the body is the one place it works. `getRecord` is the
// one GET and takes it as a query. Every write keys fields by id and sends
// `typecast: false`, so a value is never coerced silently.
//
// ─── Writes ──────────────────────────────────────────────────────────────
// Airtable collapses nothing under a key, so `createRecords` is unkeyed and
// unreplayable and a lost answer is `findCreated`'s case (C6). `updateRecords`
// is `PATCH` and replayable: it writes the values given, not deltas. `PUT` is
// never sent, not even as an option, because one field omitted from it clears
// the cell. An upsert keyed on the caller's own field is replayable (C5,
// mattermost's body key). A batch is at most 10 on every verb: Airtable took 25
// on a create (measured) and the documented cap is 10 on the rest, so the
// caller has one number and the smaller is never exceeded.
//
// Airtable's limit is 5 requests a second per BASE and conduit holds no limiter
// per target, so pacing is the caller's.

import type { ConduitRequest, ConduitResult, ResponseValidator, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type AirtableFailure } from './errors.ts'
import { createdSince, and, isFormula, type Formula } from './formula.ts'
import { fillRecord, writeFields, type CodecOptions } from './codecs.ts'
import type { AirtableBase, AirtableRecord, Field, Table } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './formula.ts'
export * from './codecs.ts'

export const AIRTABLE_TARGET  = 'provider:airtable'
export const AIRTABLE_ADDRESS = 'https://api.airtable.com'
/** Records in one write, the same on create, update, upsert and delete. */
export const MAX_BATCH = 10

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string = AIRTABLE_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/** `ref` names the credential the app's resolver holds; `address` is for a sink. */
export function airtableTarget(opts: { ref: string; address?: string }): TargetDescriptor {
  if (!opts?.ref?.trim()) throw new TypeError('airtable: ref is the name of the credential holding the personal access token')
  return {
    id:            AIRTABLE_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? AIRTABLE_ADDRESS).replace(/\/+$/, ''),
    auth:          { type: 'bearer', ref: opts.ref },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── C4: a 2xx that is a failure ──────────────────────────────────────────
// A write that landed in part, or a read with cells withheld, answers 200 with
// `details.message`. Reading `records` off it gives a plausible short list.
// Both words are the docs'; neither was provoked on an owner's own token.
const PARTIAL = new Set(['partialSuccess', 'cellsRedactedDueToLimitedPermissions'])
export const noPartial: ResponseValidator = {
  validate(data) {
    const word = (data as { details?: { message?: unknown } } | null)?.details?.message
    return typeof word === 'string' && PARTIAL.has(word) ? { ok: false, errors: [`Airtable answered ${word}`] } : { ok: true, value: data }
  },
}

const failure = (r: ConduitResult<unknown>): AirtableFailure => translate(r.error!, r.meta.status)
const malformed = (what: string): AirtableFailure => ({ kind: 'invalid_response', message: `Airtable answered something that is not ${what}`, retryable: false })

const BASE = /^app[A-Za-z0-9]{14}$/, TABLE = /^tbl[A-Za-z0-9]{14}$/, RECORD = /^rec[A-Za-z0-9]{14}$/, FIELD = /^fld[A-Za-z0-9]{14}$/
function id(re: RegExp, v: unknown, what: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw new TypeError(`airtable: ${what} is an id like ${re.source.slice(1, 4)}XXXXXXXXXXXXXX, got ${JSON.stringify(v)}`)
  return v
}
const where = (baseId: string, table: string) => `/v0/${id(BASE, baseId, 'a base')}/${id(TABLE, table, 'a table')}`

function batch<T>(items: T[], what: string): T[] {
  if (!Array.isArray(items) || !items.length) throw new TypeError(`airtable: ${what} needs at least one record`)
  if (items.length > MAX_BATCH) throw new TypeError(`airtable: ${what} takes at most ${MAX_BATCH} records, got ${items.length}; split the batch`)
  return items
}

// ─── Schema (3.1) ─────────────────────────────────────────────────────────

/** `GET /v0/meta/bases`, every page. */
export async function listBases(send: Send): Promise<{ bases?: AirtableBase[]; error?: AirtableFailure }> {
  const bases: AirtableBase[] = []
  let offset: string | undefined
  do {
    const r = await send<{ bases: AirtableBase[]; offset?: string }>({ method: 'GET', path: '/v0/meta/bases', replayable: true, validate: noPartial, ...(offset ? { query: { offset } } : {}) })
    if (r.error) return { error: failure(r) }
    if (!Array.isArray(r.data?.bases)) return { error: malformed('a list of bases') }
    bases.push(...r.data.bases)
    offset = r.data.offset
  } while (offset)
  return { bases }
}

/** `GET /v0/meta/bases/{base}/tables`: each table with its fields keyed by id. Read it once and hand the tables to the reads and writes; it is how a rename changes nothing. */
export async function baseSchema(send: Send, baseId: string): Promise<{ tables?: Table[]; error?: AirtableFailure }> {
  const r = await send<{ tables: { id: string; name: string; primaryFieldId: string; fields: Field[] }[] }>({
    method: 'GET', path: `/v0/meta/bases/${id(BASE, baseId, 'a base')}/tables`, replayable: true, validate: noPartial,
  })
  if (r.error) return { error: failure(r) }
  if (!Array.isArray(r.data?.tables)) return { error: malformed('a list of tables') }
  return {
    tables: r.data.tables.map(t => ({
      id: t.id, name: t.name, primaryFieldId: t.primaryFieldId,
      fields: Object.fromEntries((t.fields ?? []).map(f => [f.id, f])),
    })),
  }
}

// ─── Reads (2.3) ──────────────────────────────────────────────────────────

export interface ReadOptions extends CodecOptions {
  baseId: string
  /** The table's id, `tblXXXXXXXXXXXXXX`; a name in a path is the rename Q5 exists to avoid. */
  table:  string
  /** The table from `baseSchema`. With it, a read fills every field it names; without it a record is what Airtable sent. */
  schema?: Table
  /** Field ids to return. Absent fields among them are filled too. */
  fields?: string[]
}

export interface ListOptions extends ReadOptions {
  formula?:  Formula
  pageSize?: number
  /** Stop after this many records. */
  max?:      number
}

const fieldList = (fields: string[] | undefined) => fields?.map(f => id(FIELD, f, 'a field'))
const shape = (rec: AirtableRecord, o: ReadOptions): AirtableRecord => o.schema ? fillRecord(rec, o.schema, { currencies: o.currencies, only: o.fields }) : rec

/**
 * `POST …/listRecords`, walked by `offset`. A POST so a long formula never
 * meets the URL's 16,000 characters, and `replayable: true` because it moves
 * nothing. An `offset` that died (`iterator_expired`) starts the walk over,
 * ONCE; a second death is the caller's.
 */
export async function listRecords(send: Send, o: ListOptions): Promise<{ records?: AirtableRecord[]; error?: AirtableFailure }> {
  const path = `${where(o.baseId, o.table)}/listRecords`
  if (o.formula !== undefined && !isFormula(o.formula)) throw new TypeError('airtable: formula is built with eq/and/or/not, never a string — a caller\'s text must be escaped')
  if (o.pageSize !== undefined && !(Number.isInteger(o.pageSize) && o.pageSize >= 1 && o.pageSize <= 100)) throw new TypeError('airtable: pageSize is 1 to 100')
  const base = {
    returnFieldsByFieldId: true,
    ...(o.formula ? { filterByFormula: o.formula.text } : {}),
    ...(o.fields ? { fields: fieldList(o.fields) } : {}),
    ...(o.pageSize ? { pageSize: o.pageSize } : {}),
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const records: AirtableRecord[] = []
    let offset: string | undefined, expired = false
    do {
      const r = await send<{ records: AirtableRecord[]; offset?: string }>({ method: 'POST', path, replayable: true, validate: noPartial, body: { ...base, ...(offset ? { offset } : {}) } })
      if (r.error) {
        const f = failure(r)
        if (f.code === 'iterator_expired' && attempt === 0) { expired = true; break }
        return { error: f }
      }
      if (!Array.isArray(r.data?.records)) return { error: malformed('a page of records') }
      records.push(...r.data.records.map(rec => shape(rec, o)))
      offset = r.data.offset
      if (o.max !== undefined && records.length >= o.max) return { records: records.slice(0, o.max) }
    } while (offset)
    if (!expired) return { records }
  }
  return { error: { kind: 'refused', code: 'iterator_expired', message: 'Airtable killed the offset twice', retryable: false } }
}

/** `GET …/{record}`. The one read that is a GET, so `returnFieldsByFieldId` is a query here. A record that is not there is a 403, `forbidden`, as a missing table is. */
export async function getRecord(send: Send, o: ReadOptions & { id: string }): Promise<{ record?: AirtableRecord; error?: AirtableFailure }> {
  const r = await send<AirtableRecord>({
    method: 'GET', path: `${where(o.baseId, o.table)}/${id(RECORD, o.id, 'a record')}`, replayable: true, validate: noPartial,
    query: { returnFieldsByFieldId: 'true', ...(o.fields ? { fields: fieldList(o.fields) } : {}) },
  })
  if (r.error) return { error: failure(r) }
  if (!r.data || typeof r.data.id !== 'string' || typeof r.data.fields !== 'object') return { error: malformed('a record') }
  return { record: shape(r.data, o) }
}

// ─── Writes (2.5) ─────────────────────────────────────────────────────────

export interface WriteOptions extends CodecOptions { baseId: string; table: string; schema?: Table }
type Written = { records?: AirtableRecord[]; error?: AirtableFailure }

const wire = (o: WriteOptions, records: { id?: string; fields: Record<string, unknown> }[]) =>
  records.map(r => ({ ...(r.id !== undefined ? { id: id(RECORD, r.id, 'a record') } : {}), fields: writeFields(r.fields, o.schema, o) }))
const WRITE = { typecast: false, returnFieldsByFieldId: true } as const

/** What a create sent, enough for `findCreated` to find it (C6). `records` are the wire fields, by id. */
export interface Attempt { baseId: string; table: string; startedAt: string; records: Record<string, unknown>[] }

/** `POST`, up to 10. Unkeyed and unreplayable: a lost answer is `indeterminate` and `findCreated(send, attempt)` says whether it landed. */
export async function createRecords(send: Send, o: WriteOptions & { records: { fields: Record<string, unknown> }[] }): Promise<Written & { attempt: Attempt }> {
  const records = wire(o, batch(o.records, 'createRecords'))
  const attempt: Attempt = { baseId: o.baseId, table: o.table, startedAt: new Date().toISOString(), records: records.map(r => r.fields) }
  const r = await send<{ records: AirtableRecord[] }>({ method: 'POST', path: where(o.baseId, o.table), validate: noPartial, body: { records, ...WRITE } })
  if (r.error) return { attempt, error: failure(r) }
  if (!Array.isArray(r.data?.records)) return { attempt, error: malformed('created records') }
  return { attempt, records: r.data.records }
}

/** `PATCH`, up to 10: the fields given are set and `null` clears; every other field is untouched. Replayable, since it writes values and not deltas. */
export async function updateRecords(send: Send, o: WriteOptions & { records: { id: string; fields: Record<string, unknown> }[] }): Promise<Written> {
  const records = wire(o, batch(o.records, 'updateRecords'))
  const r = await send<{ records: AirtableRecord[] }>({ method: 'PATCH', path: where(o.baseId, o.table), replayable: true, validate: noPartial, body: { records, ...WRITE } })
  if (r.error) return { error: failure(r) }
  if (!Array.isArray(r.data?.records)) return { error: malformed('updated records') }
  return { records: r.data.records }
}

/**
 * `PATCH` with `performUpsert`: a record matching on `mergeOn` (one to three
 * field ids, each in every record) is updated, none is created, and more than
 * one is `conflict` / `ambiguous_match` with nothing written. The caller's own
 * key is in the body, so a replay lands the same row: replayable, and a lost
 * answer needs no `findCreated`, only the same call again.
 */
export async function upsertRecords(send: Send, o: WriteOptions & { records: { fields: Record<string, unknown> }[]; mergeOn: string[] }): Promise<Written & { createdIds?: string[]; updatedIds?: string[] }> {
  if (!Array.isArray(o.mergeOn) || o.mergeOn.length < 1 || o.mergeOn.length > 3) throw new TypeError('airtable: mergeOn is one to three field ids')
  const keys = o.mergeOn.map(f => id(FIELD, f, 'a merge field'))
  const records = wire(o, batch(o.records, 'upsertRecords'))
  for (const [i, rec] of records.entries()) for (const k of keys) {
    if (!(k in rec.fields)) throw new TypeError(`airtable: record ${i} does not carry mergeOn field ${k}; Airtable would refuse it`)
  }
  const r = await send<{ records: AirtableRecord[]; createdRecords?: string[]; updatedRecords?: string[] }>({
    method: 'PATCH', path: where(o.baseId, o.table), replayable: true, validate: noPartial,
    body: { performUpsert: { fieldsToMergeOn: keys }, records, ...WRITE },
  })
  if (r.error) return { error: failure(r) }
  if (!Array.isArray(r.data?.records)) return { error: malformed('upserted records') }
  return { records: r.data.records, createdIds: r.data.createdRecords ?? [], updatedIds: r.data.updatedRecords ?? [] }
}

/** `DELETE`, up to 10 ids. Replayable: deleting twice deletes nothing more. What a replay of an already-deleted record answers is unmeasured, and `translate` does not call it `gone`. */
export async function deleteRecords(send: Send, o: { baseId: string; table: string; ids: string[] }): Promise<{ deleted?: { id: string; deleted: boolean }[]; error?: AirtableFailure }> {
  const ids = batch(o.ids, 'deleteRecords').map(i => id(RECORD, i, 'a record'))
  const r = await send<{ records: { id: string; deleted: boolean }[] }>({ method: 'DELETE', path: where(o.baseId, o.table), replayable: true, validate: noPartial, query: { 'records[]': ids } })
  if (r.error) return { error: failure(r) }
  if (!Array.isArray(r.data?.records)) return { error: malformed('deleted records') }
  return { deleted: r.data.records }
}

// ─── C6: did a lost create land? ──────────────────────────────────────────

/** How far this machine's clock may run ahead of Airtable's `createdTime` and a lost create still be found. */
const CLOCK_SKEW_MS = 120_000

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const emptyCell = (v: unknown) => v === null || v === '' || v === false || (Array.isArray(v) && !v.length)

/**
 * Reads the table for rows created since the attempt, through `listRecords`
 * with a `CREATED_TIME()` formula, and matches each written record to one of
 * them by the fields it wrote. `found` is aligned with `attempt.records`: a row,
 * or `null` where none matched, so `null` means that record did not land and the
 * caller may create it again. A match, not a key: Airtable stores none, so two
 * identical rows in the window are indistinguishable, and each row is used for
 * one record only, the newest first. An upsert needs none of this.
 */
export async function findCreated(send: Send, attempt: Attempt): Promise<{ found?: (AirtableRecord | null)[]; error?: AirtableFailure }> {
  const read = await listRecords(send, { baseId: attempt.baseId, table: attempt.table, formula: and(createdSince(Date.parse(attempt.startedAt) - CLOCK_SKEW_MS)) })
  if (read.error) return { error: read.error }
  const rows = [...read.records!].sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
  const used = new Set<string>()
  const found = attempt.records.map(written => {
    const row = rows.find(r => !used.has(r.id) && Object.entries(written).every(([k, v]) => emptyCell(v) ? emptyCell(r.fields[k]) : same(r.fields[k], v)))
    if (row) used.add(row.id)
    return row ?? null
  })
  return { found }
}
