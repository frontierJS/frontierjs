// @ts-check
// cardinality.js — how many children a parent must and may have
//
// `lines OrderLine[] @minItems(1) @maxItems(50)`. The declaration is read into
// two indexes by `buildCardinalityMap`; what is here is the runtime half — a
// ledger of the parents a write unit touched, and the grade run once when that
// unit ends.
//
// ── Why the grade is at the END of the write unit ───────────────────────────
//
// A minimum cannot be graded at the statement that creates the parent, because
// the children do not exist yet, and it cannot be graded at the statement that
// inserts the last child, because nothing says it was the last. SQL:92 named
// the same problem DEFERRABLE INITIALLY DEFERRED and SQLite has no such thing.
//
// So the grade happens where held announcements already fire: the outermost
// commit, the one moment the package already treats as *the write is real*
// (`FJS-D170`). Outside `$transaction` a single call IS the outermost unit, so
// there is one rule and not an immediate/deferred pair for anybody to learn.
//
// ── What it does not reach ──────────────────────────────────────────────────
//
// A COUNT over another table cannot be a SQLite CHECK — subqueries are
// prohibited there — so this is litestone's rule rather than the table's, and
// `asSystem().sql` goes around it exactly as it goes around a row policy. It is
// graded for `asSystem()` through the ORM, because a bound is a statement about
// the DATA and not about the caller, which is the line `@@check` and `@@arc`
// already sit on.
//
// A parent that already violates its bound is never re-graded: only parents a
// write unit TOUCHED are counted. Declaring a bound over rows that break it is
// a contract for `fli release:check`, and `verifyConstraints` is what grades
// the rows already there.

import { ValidationError } from './validate.js'
import { RateLimitError }  from './errors.js'
import { quoteIdent }      from './query.js'
import { parseDuration }   from './retention.js'

// The ledger is an ARRAY rather than a Set because a SAVEPOINT rollback
// truncates it to a mark, exactly as the announcement queue beside it does —
// a rolled-back savepoint that left its parent in the ledger would grade a row
// the transaction no longer holds.
export function createCardinalityLedger(/** @type {any} */ map, /** @type {any} */ readRow, /** @type {() => number} */ nowMs = Date.now) {
  /** @type {any[]} */
  const dirty = []

  const push = (/** @type {any} */ rule, /** @type {any} */ key, /** @type {any} */ via = null) => {
    if (key.some((/** @type {any} */ v) => v == null)) return        // an unparented child is nobody's count
    dirty.push({ rule, key, via })
  }

  return {
    get length() { return dirty.length },
    truncate(/** @type {any} */ mark) { dirty.length = mark },

    // A parent row was written. Its own id is what the bound is graded against.
    noteParent(/** @type {any} */ model, /** @type {any} */ row) {
      for (const rule of map.byParent[model] ?? [])
        push(rule, rule.refFields.map((/** @type {any} */ f) => row?.[f]))
    },

    // A child row was written, or is about to be. The parent it names is the
    // one whose count moved; `before` carries the parent it named BEFORE an
    // update, because moving a line between two orders changes two counts.
    noteChild(/** @type {any} */ model, /** @type {any} */ row, before = null) {
      for (const rule of map.byChild[model] ?? []) {
        push(rule, rule.fkFields.map((/** @type {any} */ f) => row?.[f]))
        if (before) push(rule, rule.fkFields.map((/** @type {any} */ f) => before?.[f]))
      }
    },

    // A row of a `@@rate` model was written; its own key is the count that moved.
    // Only a row LANDING is noted, never a delete: removing a row cannot take a
    // key over its limit, and grading it would refuse a delete for a flood it
    // did not cause.
    // A window or a limit read through a relation is the parent's that THIS
    // row names, so the parent's key rides with the note.
    noteRate(/** @type {any} */ model, /** @type {any} */ row) {
      for (const rule of map.byRate?.[model] ?? [])
        push(rule, rule.keyFields.map((/** @type {any} */ f) => row?.[f]),
          rule.viaFields.length ? rule.viaFields.map((/** @type {any} */ f) => row?.[f]) : null)
    },

    // A bulk write matched rows by a WHERE, so the parents are whatever those
    // rows name — which only the database knows, and only before the write.
    noteChildRows(/** @type {any} */ model, /** @type {any} */ rows) {
      for (const row of rows ?? []) this.noteChild(model, row)
    },

    grade(/** @type {any} */ db) {
      if (!dirty.length) return
      // One COUNT per distinct (rule, parent), not per row: a createMany of 500
      // lines on one order is one query.
      const seen = new Set()
      for (const { rule, key, via } of dirty) {
        const sig = `${rule.parent ?? rule.model}.${rule.field ?? rule.keyFields}\u0000${rule.per ?? ''}\u0000${key.join('\u0000')}\u0000${via?.join('\u0000') ?? ''}`
        if (seen.has(sig)) continue
        seen.add(sig)
        if (rule.keyFields) { gradeRate(db, rule, key, via, nowMs); continue }

        // A cascade took the parent with the children, so there is no row to
        // hold to a minimum. Asked of the parent table rather than assumed
        // from the operation, because a delete reaches here by several paths.
        if (!readRow(db, rule, key)) continue

        const where = [
          ...rule.fkColumns.map((/** @type {any} */ c) => `"${c}" = ?`),
          ...rule.filters,
        ].join(' AND ')
        const n = db.query(`SELECT COUNT(*) AS n FROM "${rule.childTable}" WHERE ${where}`).get(...key)?.n ?? 0

        if (rule.min != null && n < rule.min) throw refusal(rule, key, n, 'min')
        if (rule.max != null && n > rule.max) throw refusal(rule, key, n, 'max')
      }
    },
  }
}

// ─── @@rate ─────────────────────────────────────────────────────────────────
//
// Graded inside the write unit, so SQLite's single writer makes the count and
// the INSERT one step: two callers cannot each see max - 1 and both land.
// `asSystem()` is held to it for `@@check`'s reason — the limit is about the
// data. The window is read off the client's clock, the one `@default(now())`
// stamps `at` with, so an injected clock moves both together.
//
// A window or a limit read through a relation is read here, inside the same
// unit, so a change to the parent's number holds from the next write. A null
// number, or a row naming no parent, has no window or no limit and so no cap
// (`FJS-D1119`, `FJS-D2295`).
function gradeRate(/** @type {any} */ db, /** @type {any} */ rule, /** @type {any[]} */ key, /** @type {any[]|null} */ via, /** @type {() => number} */ nowMs) {
  let per = rule.per, max = rule.max
  const perVia = via?.slice(0, rule.perFrom?.fkFields.length ?? 0) ?? null
  const maxVia = via?.slice(rule.perFrom?.fkFields.length ?? 0) ?? null
  if (rule.perFrom) {
    const days = readParentInt(db, rule.perFrom, perVia)
    if (days == null || days <= 0) return
    per = `${days}d`
  }
  if (rule.maxFrom) {
    max = readParentInt(db, rule.maxFrom, maxVia)
    if (max == null) return
  }
  const where  = [...rule.keyColumns.map((/** @type {string} */ c) => `${quoteIdent(c)} = ?`), ...rule.filters]
  const params = [...key]
  const now    = nowMs()
  const perMs  = per ? parseDuration(per, '@@rate') : null
  const at     = rule.atColumn ? quoteIdent(rule.atColumn) : null
  if (perMs != null) {
    where.push(`${at} > ?`)
    params.push(new Date(now - perMs).toISOString())
  }
  const from = `FROM ${quoteIdent(rule.table)} WHERE ${where.join(' AND ')}`
  const n = db.query(`SELECT COUNT(*) AS n ${from}`).get(...params)?.n ?? 0
  if (n <= max) return

  // The window reopens when enough of the rows in it have aged out for one
  // more to fit: the (n - max)th oldest leaves at its own `at` plus the window.
  let retryAt = null
  if (perMs != null) {
    const oldest = db.query(`SELECT ${at} AS at ${from} ORDER BY ${at} LIMIT 1 OFFSET ?`)
      .get(...params, n - max - 1)?.at
    const t = oldest != null ? Date.parse(oldest) : NaN
    if (!Number.isNaN(t)) retryAt = new Date(t + perMs).toISOString()
  }
  throw new RateLimitError(rule.model, {
    key:      Object.fromEntries(rule.keyFields.map((/** @type {string} */ f, /** @type {number} */ i) => [f, key[i]])),
    max,
    per,
    count:    n,
    retryAt,
    now,
  })
}

// The number a parent row holds for a window or a limit; a row naming no
// parent, or a parent holding no number, is null. A window of no more than
// zero days counts nothing, so the caller reads that as no window.
function readParentInt(/** @type {any} */ db, /** @type {any} */ from, /** @type {any[]|null} */ via) {
  if (!via || via.some(v => v == null)) return null
  const where = from.refColumns.map((/** @type {string} */ c) => `${quoteIdent(c)} = ?`).join(' AND ')
  const v     = db.query(`SELECT ${quoteIdent(from.column)} AS v FROM ${quoteIdent(from.table)} WHERE ${where}`).get(...via)?.v
  return typeof v === 'number' ? Math.floor(v) : null
}

function refusal(/** @type {any} */ rule, /** @type {any} */ key, /** @type {any} */ n, /** @type {any} */ which) {
  const bound = which === 'min' ? rule.min : rule.max
  const word  = which === 'min' ? 'at least' : 'at most'
  const id    = key.join(', ')
  return new ValidationError([{
    path: [rule.field],
    message:
      `${rule.parent}.${rule.field} must have ${word} ${bound} ${rule.child} row(s) and has ${n} ` +
      `(${rule.parent} ${id}). The count is graded when the outermost write commits, so the children ` +
      `can be written in the same call — ${rule.parent.toLowerCase()}.create({ data: { …, ${rule.field}: ` +
      `{ create: [ … ] } } }) — or anywhere inside one $transaction.`,
  }])
}

// A create that cannot possibly satisfy a minimum is refused before the INSERT,
// with no COUNT and no transaction. That is what keeps the single-row create
// fast path (`FJS-1106`) for every model that declares no bound: a create of a
// bounded model either carries children, and has already left that path, or is
// this refusal.
export function refuseChildlessCreate(/** @type {any} */ rules, /** @type {any} */ data) {
  for (const rule of rules) {
    const nested = data?.[rule.field]
    const n = Array.isArray(nested?.create) ? nested.create.length
            : nested?.create ? 1
            : Array.isArray(nested?.connect) ? nested.connect.length
            : nested?.connect ? 1
            : 0
    if (n < rule.min)
      return new ValidationError([{
        path: [rule.field],
        message:
          `${rule.parent}.${rule.field} must have at least ${rule.min} ${rule.child} row(s) and this ` +
          `create names ${n}. Write them in the same call — ${rule.parent.toLowerCase()}.create({ data: ` +
          `{ …, ${rule.field}: { create: [ … ] } } }) — or open a $transaction and add them there.`,
      }])
  }
  return null
}
