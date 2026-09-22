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
// So the grade happens where `flushPending` already fires: the outermost
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

// The ledger is an ARRAY rather than a Set because a SAVEPOINT rollback
// truncates it to a mark, exactly as the announcement queue beside it does —
// a rolled-back savepoint that left its parent in the ledger would grade a row
// the transaction no longer holds.
export function createCardinalityLedger(map, readRow) {
  const dirty = []

  const push = (rule, key) => {
    if (key.some(v => v == null)) return        // an unparented child is nobody's count
    dirty.push({ rule, key })
  }

  return {
    get length() { return dirty.length },
    truncate(mark) { dirty.length = mark },

    // A parent row was written. Its own id is what the bound is graded against.
    noteParent(model, row) {
      for (const rule of map.byParent[model] ?? [])
        push(rule, rule.refFields.map(f => row?.[f]))
    },

    // A child row was written, or is about to be. The parent it names is the
    // one whose count moved; `before` carries the parent it named BEFORE an
    // update, because moving a line between two orders changes two counts.
    noteChild(model, row, before = null) {
      for (const rule of map.byChild[model] ?? []) {
        push(rule, rule.fkFields.map(f => row?.[f]))
        if (before) push(rule, rule.fkFields.map(f => before?.[f]))
      }
    },

    // A bulk write matched rows by a WHERE, so the parents are whatever those
    // rows name — which only the database knows, and only before the write.
    noteChildRows(model, rows) {
      for (const row of rows ?? []) this.noteChild(model, row)
    },

    grade(db) {
      if (!dirty.length) return
      // One COUNT per distinct (rule, parent), not per row: a createMany of 500
      // lines on one order is one query.
      const seen = new Set()
      for (const { rule, key } of dirty) {
        const sig = `${rule.parent}.${rule.field}\u0000${key.join('\u0000')}`
        if (seen.has(sig)) continue
        seen.add(sig)

        // A cascade took the parent with the children, so there is no row to
        // hold to a minimum. Asked of the parent table rather than assumed
        // from the operation, because a delete reaches here by several paths.
        if (!readRow(db, rule, key)) continue

        const where = [
          ...rule.fkColumns.map(c => `"${c}" = ?`),
          ...rule.filters,
        ].join(' AND ')
        const n = db.query(`SELECT COUNT(*) AS n FROM "${rule.childTable}" WHERE ${where}`).get(...key)?.n ?? 0

        if (rule.min != null && n < rule.min) throw refusal(rule, key, n, 'min')
        if (rule.max != null && n > rule.max) throw refusal(rule, key, n, 'max')
      }
    },
  }
}

function refusal(rule, key, n, which) {
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
export function refuseChildlessCreate(rules, data) {
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
