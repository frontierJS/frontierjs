// sink.ts — Airtable, standing in for `api.airtable.com`. One base, the scratch
// base Phase 0 measured (`appM9ah85uDdYnwCC`), three tables, a bearer token, and
// every answer built from `test/fixture/`'s measured bodies. The wire is parsed
// by hand (C10): the JSON body, the `records[]` query, the offset, and a formula
// evaluator for the one subset the connector's builder emits.
//
// What it holds to, as measured 2026-11-10: a record, table or base that is not
// there is `403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` alike; a cell that is
// empty is OMITTED on read, a count is never; a write keys a field by id or name
// and answers by id only when its BODY says `returnFieldsByFieldId`; `null`
// clears; a computed field refuses a write; an unknown select value is refused
// without `typecast`; a non-ISO date is silently read as a date (so only the
// connector stops it); an upsert on two matches is a 422 that writes nothing.
// The batch cap is 10 on every verb: Airtable took 25 on a create, but the
// connector's number is 10, so a raw 11 here is the refusal the drive needs.
//
// The schema answer is `tables.json`, the real `GET …/tables` of the scratch base
// (four tables, the reverse links, every choice id, the count definitions).
// Fabricated, because nothing measured it: a dead offset's words, a delete's
// answer and a replayed delete's (a 403 here, since a missing record is a 403),
// and `details.message` on a 2xx.
//
// Chaos under `/_sink/arm`, each for one request: `{ rateLimit }` the 429 with
// the PLURAL body and no `Retry-After`; `{ failNext }` a 500; `{ lost }` APPLIES
// the request and never answers; `{ offsetDies: n }` makes the next n requests that
// carry an `offset` answer `LIST_RECORDS_ITERATOR_NOT_AVAILABLE`; `{ partial }`
// ('partialSuccess' | 'cellsRedactedDueToLimitedPermissions') applies the next
// request and adds `details.message` to its 2xx. `/_sink/seed` (`{ table, count }`)
// appends rows; `/_sink/rename` (`{ id, name }`) renames a field; `/_sink/seen` is every request, recorded on ARRIVAL.

import { readFileSync } from 'node:fs'

export const BASE_ID = 'appM9ah85uDdYnwCC'
export const T = { clients: 'tblXOKo8QVlaAbSRo', projects: 'tbl7lWGJOf1ERTEOv', tasks: 'tblb9QlowzztTU60L', milestones: 'tbl4G2A7EcMx89xMV' } as const

type SchemaField = { id: string; name: string; type: string; options?: Record<string, any> }
type SchemaTable = { id: string; name: string; primaryFieldId: string; fields: SchemaField[]; views?: unknown[] }
/** The schema is `tables.json`, the real `GET …/tables` answer, reloaded on reset so a rename or a typecast choice never outlives its drive. */
let SCHEMA: SchemaTable[] = []
const loadSchema = () => { SCHEMA = fixture('tables').tables }
const COMPUTED = new Set(['count', 'formula', 'rollup', 'multipleLookupValues', 'createdTime', 'lastModifiedTime', 'autoNumber'])

type Cells = Record<string, unknown>
type Row = { id: string; createdTime: string; f: Cells }
type Json = Record<string, any>
export interface AirtableSinkOptions { port?: number; token?: string }

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./test/fixture/${name}.json`, import.meta.url), 'utf8'))
const tableOf = (id: string) => SCHEMA.find(t => t.id === id)
const emptyCell = (v: unknown) => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)
const rid = (n: number) => `recSink${String(n).padStart(10, '0')}`
const now = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()

class Refusal { constructor(readonly status: number, readonly type: string, readonly message: string) {} }
const refuse = (status: number, type: string, message: string): never => { throw new Refusal(status, type, message) }
const MISSING = () => refuse(403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', 'Invalid permissions, or the requested model was not found. Check that both your user and your token have the required permissions, and that the model names and/or ids are correct.')

// ─── The formula subset the builder emits ─────────────────────────────────
type Tok = { t: 'str' | 'num' | 'ref' | 'id' | 'op' | 'p'; v: string }
function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < src.length;) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === "'" || c === '"') {
      let s = '', j = i + 1
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\' && j + 1 < src.length) { j++; s += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[src[j]] ?? src[j] } else s += src[j]
      }
      if (j >= src.length) refuse(422, 'INVALID_FILTER_BY_FORMULA', 'unterminated string')
      out.push({ t: 'str', v: s }); i = j + 1; continue
    }
    if (c === '{') { const j = src.indexOf('}', i); if (j < 0) refuse(422, 'INVALID_FILTER_BY_FORMULA', 'unterminated field'); out.push({ t: 'ref', v: src.slice(i + 1, j) }); i = j + 1; continue }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i)); if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue }
    const id = /^[A-Z_]+/.exec(src.slice(i)); if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue }
    if (src.startsWith('!=', i)) { out.push({ t: 'op', v: '!=' }); i += 2; continue }
    if (c === '=') { out.push({ t: 'op', v: '=' }); i++; continue }
    if ('(),'.includes(c)) { out.push({ t: 'p', v: c }); i++; continue }
    refuse(422, 'INVALID_FILTER_BY_FORMULA', `unexpected '${c}'`)
  }
  return out
}
const eqv = (a: unknown, b: unknown) => typeof a === typeof b ? a === b : String(a) === String(b)
function evaluate(src: string, row: Row): unknown {
  const toks = tokenize(src); let p = 0
  const peek = () => toks[p], take = () => toks[p++] ?? refuse(422, 'INVALID_FILTER_BY_FORMULA', 'unexpected end')
  const expect = (v: string) => { const t = take(); if (t.v !== v) refuse(422, 'INVALID_FILTER_BY_FORMULA', `expected '${v}'`) }
  function atom(): unknown {
    const t = take()
    if (t.t === 'str') return t.v
    if (t.t === 'num') return Number(t.v)
    if (t.t === 'ref') { const v = row.f[t.v]; return v === undefined ? '' : v }
    if (t.t === 'p' && t.v === '(') { const v = cmp(); expect(')'); return v }
    if (t.t !== 'id') return refuse(422, 'INVALID_FILTER_BY_FORMULA', `unexpected '${t.v}'`)
    expect('(')
    const args: unknown[] = []
    if (peek()?.v !== ')') for (;;) { args.push(cmp()); if (peek()?.v === ',') { take(); continue } break }
    expect(')')
    switch (t.v) {
      case 'AND': return args.every(Boolean)
      case 'OR': return args.some(Boolean)
      case 'NOT': return !args[0]
      case 'TRUE': return true
      case 'FALSE': return false
      case 'CREATED_TIME': return row.createdTime
      case 'IS_AFTER': return Date.parse(String(args[0])) > Date.parse(String(args[1]))
      default: return refuse(422, 'INVALID_FILTER_BY_FORMULA', `unknown function ${t.v}`)
    }
  }
  function cmp(): unknown {
    let v = atom()
    while (peek()?.t === 'op') { const op = take().v, r = atom(); v = op === '=' ? eqv(v, r) : !eqv(v, r) }
    return v
  }
  const v = cmp()
  if (p < toks.length) refuse(422, 'INVALID_FILTER_BY_FORMULA', 'trailing text')
  return v
}

export function startAirtableSink(opts: AirtableSinkOptions = {}) {
  const TOKEN = opts.token ?? 'pat_dev'
  const seen: { method: string; path: string; authorization: string | null; body: unknown; status: number }[] = []
  let rows: Record<string, Row[]> = {}, counter = 0
  let armed: { rateLimit?: boolean; failNext?: boolean; lost?: boolean; offsetDies?: number; partial?: string } = {}
  const reset = () => {
    seen.length = 0; armed = {}; counter = 0
    loadSchema()
    const idOfName = (t: string, name: string) => tableOf(t)!.fields.find(f => f.name === name)?.id ?? name
    const ingest = (t: string, rec: { id: string; createdTime: string; fields: Cells }) => {
      const f: Cells = {}
      for (const [k, v] of Object.entries(rec.fields)) { const id = k.startsWith('fld') ? k : idOfName(t, k); if (!COMPUTED.has(tableOf(t)!.fields.find(x => x.id === id)?.type ?? '')) f[id] = v }
      return { id: rec.id, createdTime: rec.createdTime, f }
    }
    rows = {
      [T.clients]: [fixture('get-client-filled'), ...fixture('create-10').records].map(r => ingest(T.clients, r)),
      [T.projects]: [...fixture('list-projects-p1').records, ...fixture('list-projects-p2').records].map(r => ingest(T.projects, r)),
      [T.tasks]: fixture('list-tasks').records.map((r: any) => ingest(T.tasks, r)),
      [T.milestones]: [],
    }
  }
  reset()

  const schemaOf = (tid: string) => tableOf(tid) ?? MISSING() as never
  const fieldOf = (t: ReturnType<typeof schemaOf>, key: string) => t.fields.find(f => f.id === key || f.name === key) ?? refuse(422, 'UNKNOWN_FIELD_NAME', `Unknown field name: "${key}"`)

  /** Stored cells, with the computed ones filled in, as one record's fields. Empty cells are omitted; a count never is. */
  function out(tid: string, row: Row, byId: boolean, only?: string[]) {
    const t = schemaOf(tid), fields: Cells = {}
    for (const f of t.fields) {
      if (only && !only.includes(f.id)) continue
      let v: unknown = row.f[f.id]
      if (f.type === 'count') {
        // The count's own definition: links in `recordLinkFieldId`, kept when the filter's `=` holds.
        const links = (row.f[f.options!.recordLinkFieldId] as string[] | undefined) ?? []
        const [field, choice] = f.options!.filters?.operands?.[0]?.operands ?? []
        const linked = tableOf(t.fields.find(x => x.id === f.options!.recordLinkFieldId)!.options!.linkedTableId)!
        const want = field && linked.fields.find(x => x.id === field)?.options?.choices?.find((c: any) => c.id === choice)?.name
        v = links.filter(l => !field || rows[linked.id].find(r => r.id === l)?.f[field] === want).length
      } else if (emptyCell(v)) continue
      fields[byId ? f.id : f.name] = v
    }
    return { id: row.id, createdTime: row.createdTime, fields }
  }

  /** Applies `fields` to a copy of the row's cells; the caller commits it only when nothing refused. */
  function apply(tid: string, base: Cells, fields: Json, typecast: boolean): Cells {
    const t = schemaOf(tid), cells = { ...base }
    for (const [key, value] of Object.entries(fields)) {
      const f = fieldOf(t, key)
      if (COMPUTED.has(f.type)) refuse(422, 'INVALID_VALUE_FOR_COLUMN', `Field "${f.name}" cannot accept a value because the field is computed`)
      let v = value
      if (value === null || value === '') { delete cells[f.id]; continue }
      if (f.type === 'singleSelect') {
        const choices = (f.options as any).choices as { id: string; name: string }[]
        const hit = choices.find(c => c.name === value || c.id === value)
        if (hit) v = hit.name
        else if (typecast) { choices.push({ id: `sel${String(9000 + choices.length).padStart(14, '0')}`, name: String(value) }); v = value }
        else refuse(422, 'INVALID_MULTIPLE_CHOICE_OPTIONS', `Insufficient permissions to create new select option ""${value}""`)
      } else if (f.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
          if (typecast) refuse(422, 'INVALID_VALUE_FOR_COLUMN', `Field "${f.name}" cannot accept the provided value`)
          const d = new Date(`${value} UTC`)
          if (Number.isNaN(d.getTime())) refuse(422, 'INVALID_VALUE_FOR_COLUMN', `Field "${f.name}" cannot accept the provided value`)
          v = d.toISOString().slice(0, 10)
        }
      } else if (f.type === 'multipleRecordLinks') {
        const target = f.options!.linkedTableId as string
        for (const l of v as unknown[]) {
          if (typeof l !== 'string' || !/^rec/.test(l)) refuse(422, 'INVALID_RECORD_ID', `Field ${f.id} cannot accept the provided value`)
          if (!rows[target].some(r => r.id === l)) refuse(422, 'ROW_DOES_NOT_EXIST', `Record ID ${l} does not exist`)
        }
      }
      cells[f.id] = v
    }
    return cells
  }

  const cap = (n: number, what: string) => { if (n > 10) refuse(422, 'INVALID_RECORDS', `A maximum of 10 records can be ${what} per request but you have provided ${n}.`) }

  function route(req: Request, url: URL, body: Json): { status: number; body: unknown } {
    const m = url.pathname
    if (req.method === 'GET' && m === '/v0/meta/bases') return { status: 200, body: fixture('list-bases') }
    let g = /^\/v0\/meta\/bases\/(app\w+)\/tables$/.exec(m)
    if (g && req.method === 'GET') return g[1] === BASE_ID ? { status: 200, body: { tables: SCHEMA.map(t => ({ ...t, views: [] })) } } : MISSING()
    g = /^\/v0\/(app\w+)\/(tbl\w+)(?:\/(listRecords|rec\w+))?$/.exec(m)
    if (!g) return { status: 404, body: { error: 'NOT_FOUND' } }
    const [, base, tid, tail] = g
    if (base !== BASE_ID) MISSING()
    schemaOf(tid)
    const list = rows[tid], byId = body.returnFieldsByFieldId === true || url.searchParams.get('returnFieldsByFieldId') === 'true'
    const typecast = body.typecast === true
    const only = tail === 'listRecords' ? body.fields : url.searchParams.getAll('fields')
    const one = (r: Row) => out(tid, r, byId, only?.length ? only : undefined)

    if (tail === 'listRecords' && req.method === 'POST') {
      const size = body.pageSize ?? 100
      if (!Number.isInteger(size) || size < 1 || size > 100) refuse(422, 'INVALID_PAGE_SIZE_ARGUMENT', 'Invalid pageSize')
      if (body.offset !== undefined) {
        if (armed.offsetDies) { armed.offsetDies--; refuse(422, 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE', 'The requested iterator is no longer available') }
        if (!/^itr\d+\/rec/.test(body.offset)) refuse(422, 'INVALID_OFFSET_VALUE', 'Invalid offset value')
      }
      for (const f of body.fields ?? []) fieldOf(schemaOf(tid), f)
      const hits = list.filter(r => body.filterByFormula === undefined || Boolean(evaluate(body.filterByFormula, r)))
      const at = body.offset ? Number(/^itr(\d+)/.exec(body.offset)![1]) : 0
      const page = hits.slice(at, at + size)
      const next = at + size < hits.length ? { offset: `itr${at + size}/${page[page.length - 1].id}` } : {}
      return { status: 200, body: { records: page.map(one), ...next } }
    }

    if (tail === undefined) {
      if (req.method === 'POST') {
        const recs: Json[] = body.records ?? [{ fields: body.fields ?? {} }]
        cap(recs.length, 'created')
        const made: Row[] = []
        const staged = recs.map(r => apply(tid, {}, r.fields ?? {}, typecast))
        for (const f of staged) { const row = { id: rid(++counter), createdTime: now(), f }; list.push(row); made.push(row) }
        return { status: 200, body: body.records ? { records: made.map(one) } : one(made[0]) }
      }
      if (req.method === 'PATCH') {
        const recs: Json[] = body.records ?? []
        cap(recs.length, 'updated')
        const merge: string[] | undefined = body.performUpsert?.fieldsToMergeOn
        const plan = recs.map(r => {
          if (!merge) { const row = list.find(x => x.id === r.id) ?? MISSING(); return { row, cells: apply(tid, row.f, r.fields ?? {}, typecast) } }
          const keys = merge.map(k => fieldOf(schemaOf(tid), k).id), given = apply(tid, {}, r.fields ?? {}, typecast)
          const matches = list.filter(x => keys.every(k => eqv(x.f[k], given[k])))
          if (matches.length > 1) refuse(422, 'INVALID_VALUE_FOR_COLUMN', 'Cannot update more than one record for fields to merge on')
          return matches[0] ? { row: matches[0], cells: { ...matches[0].f, ...given } } : { row: null, cells: given }
        })
        const created: string[] = [], updated: string[] = [], result: Row[] = []
        for (const p of plan) {
          if (p.row) { p.row.f = p.cells; updated.push(p.row.id); result.push(p.row) }
          else { const row = { id: rid(++counter), createdTime: now(), f: p.cells }; list.push(row); created.push(row.id); result.push(row) }
        }
        return { status: 200, body: { records: result.map(one), ...(merge ? { updatedRecords: updated, createdRecords: created } : {}) } }
      }
      if (req.method === 'DELETE') {
        const ids = url.searchParams.getAll('records[]')
        cap(ids.length, 'deleted')
        // A replayed delete answers 403 here because a missing record does; what Airtable answers is unmeasured.
        for (const i of ids) if (!list.some(r => r.id === i)) MISSING()
        rows[tid] = list.filter(r => !ids.includes(r.id))
        return { status: 200, body: { records: ids.map(id => ({ id, deleted: true })) } }
      }
      return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
    }

    const row = list.find(r => r.id === tail) ?? MISSING()
    if (req.method === 'GET') return { status: 200, body: one(row) }
    if (req.method === 'PATCH') { row.f = apply(tid, row.f, body.fields ?? {}, typecast); return { status: 200, body: one(row) } }
    // PUT clears every field not given, and nothing here is allowed to send one.
    return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/_sink/seen') return Response.json(seen)
      if (url.pathname === '/_sink/reset') { reset(); return Response.json({ ok: true }) }
      if (url.pathname === '/_sink/arm') { armed = { ...armed, ...(await req.json()) }; return Response.json({ ok: true }) }
      // The base's owner renames a field whenever they like; a read keyed by id must not notice.
      if (url.pathname === '/_sink/rename') {
        const { id, name } = await req.json() as { id: string; name: string }
        const f = SCHEMA.flatMap(t => t.fields).find(x => x.id === id)
        if (f) f.name = name
        return Response.json({ ok: !!f })
      }
      if (url.pathname === '/_sink/seed') {
        const { table, count, prefix = 'Seed' } = await req.json() as { table: string; count: number; prefix?: string }
        const primary = schemaOf(table).primaryFieldId
        for (let i = 1; i <= count; i++) rows[table].push({ id: rid(++counter), createdTime: now(), f: { [primary]: `${prefix} ${i}` } })
        return Response.json({ ok: true, total: rows[table].length })
      }
      const text = await req.text()
      let body: Json = {}
      try { body = text ? JSON.parse(text) : {} } catch { /* a body that is not JSON is the route's 422 */ }
      const entry = { method: req.method, path: url.pathname + url.search, authorization: req.headers.get('authorization'), body: text ? body : null, status: 0 }
      seen.push(entry)
      const answer = (status: number, b: unknown) => { entry.status = status; return Response.json(b, { status }) }
      if (entry.authorization !== `Bearer ${TOKEN}`) return answer(401, { error: { type: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } })
      if (armed.rateLimit) { armed.rateLimit = false; return answer(429, fixture('rate-limit-429')) }
      if (armed.failNext) { armed.failNext = false; return answer(500, {}) }
      const lost = armed.lost, partial = armed.partial
      armed.lost = false; armed.partial = undefined
      try {
        const r = route(req, url, body)
        if (partial) (r.body as Json).details = { message: partial, ...(partial === 'partialSuccess' ? { reasons: ['someRecordsFailed'] } : {}) }
        if (lost) { entry.status = -1; await Bun.sleep(4000) }
        return answer(r.status, r.body)
      } catch (e) {
        if (e instanceof Refusal) return answer(e.status, { error: { type: e.type, message: e.message } })
        throw e
      }
    },
  })
  const origin = `http://localhost:${server.port}`
  return { port: server.port, url: origin, token: TOKEN, baseId: BASE_ID, tables: T, stop: () => server.stop(true) }
}
