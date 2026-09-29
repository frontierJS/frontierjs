// exclusion.js — no two rows sharing a scope's key may overlap on their range
//
// `scope person(employeeId)` declared once; `@@exclude(person, range: [a, b])`
// on every model that holds a slice of that person's time (`FJS-D474`). What is
// here is the runtime half: a ledger of the keys a write unit touched, and the
// grade run over every member when that unit ends.
//
// ── Why at the END of the write unit, and why that is the lock ──────────────
//
// The grade runs where the cardinality grade runs: the outermost commit, with
// `BEGIN IMMEDIATE` held on every file a write can reach. That write lock is
// what the hand-written `$lock('person:…')` in each scheduling service was
// standing in for, and it covers more than the key does — so a second writer,
// in this process or another, cannot land a row between the read and the
// COMMIT. A `_locks` row taken on top would serialize nothing more.
//
// ── Under the Data boundary ─────────────────────────────────────────────────
//
// The members are read on the raw connection, never through the caller's row
// policy. The manager assigning a shift may not read the employee's leave, and
// the leave still decides whether the shift may exist (FJS-1215 finding 5).
// What leaves the grade is the refusal, which names both rows by model and id
// and carries neither row's contents.
//
// ── What a range is ─────────────────────────────────────────────────────────
//
// Half-open, `[start, end)`, the interval `@@effective` already reads by: a
// shift ending at 17:00 and one starting at 17:00 do not overlap. A null start
// is *always has been* and a null end is *still going*, which is the clock-in
// with no clock-out. A day crosses to an instant at UTC midnight, the one
// crossing `FJS-D351` allows until somebody says whose midnight it is.
//
// A key that already holds an overlap is graded whole the next time a write
// touches it, as a touched parent's count is. Rows no write touched are
// `verifyConstraints`' question, not this one's.

import { OverlapConflictError } from './errors.js'

// The ledger is an ARRAY for the reason cardinality's is: a SAVEPOINT rollback
// truncates it to a mark, and a key noted by a rolled-back write must go with it.
export function createExclusionLedger(map, connFor) {
  const dirty = []

  return {
    get length() { return dirty.length },
    truncate(mark) { dirty.length = mark },

    // A row was written, is about to be, or was removed. Its key is the one
    // whose members are graded; a removal grades clean, and costs one read.
    note(model, row) {
      if (!row) return
      for (const name of map.byModel[model] ?? []) {
        const member = map.scopes[name].members.find(m => m.model === model)
        const key = row[member.keyField] ?? row[member.keyColumn]
        if (key == null) continue                 // a row with no person excludes nothing
        // An operator payload (`{ increment: 1 }`) is not the stored key, and an
        // object bound into a statement voids every binding in it (FJS-199).
        // The key the row held before is noted from the table instead.
        if (typeof key === 'object') continue
        dirty.push({ scope: name, key, model })
      }
    },

    grade() {
      if (!dirty.length) return
      const touched = new Map()
      for (const { scope, key, model } of dirty) {
        const sig = `${scope}\u0000${typeof key}\u0000${key}`
        if (!touched.has(sig)) touched.set(sig, { scope, key, models: new Set() })
        touched.get(sig).models.add(model)
      }
      for (const { scope, key, models } of touched.values())
        gradeKey(map.scopes[scope], key, connFor, models)
    },
  }
}

function gradeKey(scope, key, connFor, written) {
  const spans = []
  for (const m of scope.members) {
    const conn = connFor(m.model)
    if (!conn) continue
    const id  = m.idColumn ? `"${m.idColumn}"` : 'rowid'
    const sql = `SELECT ${id} AS "id", "${m.columns[0]}" AS "a", "${m.columns[1]}" AS "b" ` +
                `FROM "${m.table}" WHERE ${[`"${m.keyColumn}" = ?`, ...m.filters].join(' AND ')}`
    for (const r of conn.query(sql).all(key)) {
      const start = toPoint(r.a, m.kinds[0], -Infinity)
      const end   = toPoint(r.b, m.kinds[1],  Infinity)
      // An end before its start covers nothing, and NaN compares false both
      // ways — either would let the row through every check in silence.
      if (Number.isNaN(start) || Number.isNaN(end) || end < start)
        throw new OverlapConflictError(m.model,
          `${m.model} ${r.id} has ${m.range[0]} ${JSON.stringify(r.a)} and ${m.range[1]} ${JSON.stringify(r.b)}, ` +
          `which is not a range — its end must not be before its start`,
          { scope: scope.name, key, field: m.range[1] })
      if (start === end) continue                 // [a, a) is empty and overlaps nothing
      spans.push({ member: m, id: r.id, start, end })
    }
  }
  // Sorted by start, one sweep: a span that begins before the furthest end seen
  // so far overlaps the span that reached it.
  spans.sort((x, y) => x.start - y.start)
  let open = null
  for (const s of spans) {
    if (open && s.start < open.end) {
      // Marked on the model this write touched, so a form puts it under its box.
      const [mine, other] = written.has(s.member.model) ? [s, open] : [open, s]
      throw overlap(scope, key, mine, other)
    }
    if (!open || s.end > open.end) open = s
  }
}

// The other row may be on a model the caller cannot read, so it is named by
// model and id and nothing of it is quoted.
function overlap(scope, key, mine, other) {
  const m = mine.member, o = other.member
  const range = (x) => `[${x.range.join(', ')}]`
  return new OverlapConflictError(m.model,
    `${m.model} ${mine.id} overlaps ${o.model} ${other.id} on ${range(m)}` +
    (o.model === m.model ? '' : ` against ${range(o)}`) +
    ` — @@exclude(${scope.name}) allows no two rows with the same ${scope.field} ${JSON.stringify(key)} to overlap`,
    { scope: scope.name, key, field: m.range[0], with: { model: o.model, id: other.id } })
}

function toPoint(v, kind, none) {
  if (v == null) return none
  if (kind === 'number' || typeof v === 'number') return Number(v)
  if (kind === 'day') return Date.parse(`${String(v).slice(0, 10)}T00:00:00.000Z`)
  return Date.parse(v)
}
