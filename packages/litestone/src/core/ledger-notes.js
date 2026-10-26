// ledger-notes.js — what a write tells the two commit-time grades: the
// parents a relation cardinality counts and the keys an exclusion scope
// compares. A note is cheap and the grade is not, so a table that declares
// neither pays one boolean per write.
//
// Built once per table by `makeTable`, which hands it the transaction manager
// and the write connection, and takes back the noters.

import { quoteIdent } from './query.js'

export function makeLedgerNotes(shape, deps) {
  const { tableName, modelName } = shape
  const { tx, writeDb } = deps

  // ── Relation cardinality ───────────────────────────────────────────────────
  //
  // Both ends move a count, so both are noted: writing a PARENT can leave one
  // with no children, and writing a CHILD moves the parent it names. The grade
  // itself is at the outermost commit (`cardinality.js`).
  const _cardNotes = tx.ledger
    && (shape.cardinality.byParent.length
      + shape.cardinality.byChild.length) > 0
  function noteCardinality(row, before = null) {
    if (!_cardNotes || !row) return
    tx.ledger.noteParent(modelName, row)
    tx.ledger.noteChild(modelName, row, before)
  }
  // A write that names its rows with a WHERE moves parents only the database
  // knows, and only BEFORE the statement runs. Takes the SQL the caller has
  // already built rather than a where object, so the rows noted are exactly the
  // rows written — a second compile of the same filter is a second answer.
  //
  // The columns are aliased back to FIELD names because that is what the ledger
  // reads; under `@map` the two differ and an unaliased row would note
  // `undefined` for every parent, which is silently no parents at all.
  function noteCardinalityBySql(whereSql, params) {
    if (!_cardNotes) return
    const rules = shape.cardinality.byChild
    if (!rules.length) return
    const pairs = [...new Map(rules.flatMap(r =>
      r.fkColumns.map((c, i) => [c, r.fkFields[i]]))).entries()]
    const sel = pairs.map(([c, f]) => `"${c}" AS "${f}"`).join(', ')
    const sql = `SELECT DISTINCT ${sel} FROM "${tableName}"${whereSql ? ` WHERE ${whereSql}` : ''}`
    for (const row of writeDb.query(sql).all(...params)) tx.ledger.noteChild(modelName, row)
  }

  // ── Exclusion scopes ───────────────────────────────────────────────────────
  //
  // A write that lands a row, or moves its key or its range, notes the key; the
  // grade over every member of the scope is at the outermost commit
  // (`exclusion.js`). A delete is never noted: removing a row cannot make two
  // overlap, and grading the key would refuse a delete for an overlap it did
  // not cause.
  const _exclMembers = tx.exclusions ? shape.exclusions : []
  // A parent whose column some member's range `@from`s: a Shift's time moves
  // every Assignment under it, and the write names none of them (`FJS-D989`).
  const _exclParents = tx.exclusions ? shape.exclusionParents : []
  const _exclNotes   = _exclMembers.length > 0 || _exclParents.length > 0
  const _exclFields  = new Set([
    ..._exclMembers.flatMap(m => [...m.keyFields, ...m.range, ...m.whereFields, ...m.viaFields]),
    ..._exclParents.flatMap(p => p.fields),
  ])
  // Only a write naming the key, an end of the range, a field of `where:` or
  // the relation a range is read through can move a row into another's range;
  // every other update keeps its fast path.
  const exclTouched = (data) => _exclNotes && data != null && Object.keys(data).some(k => _exclFields.has(k))
  const parentTouched = (p, data) => data == null || p.fields.some(f => Object.hasOwn(data, f))
  function noteExclusion(row) {
    if (!_exclNotes || !row) return
    if (_exclMembers.length) tx.exclusions.note(modelName, row)
    for (const p of _exclParents) if (parentTouched(p, row)) tx.exclusions.noteThrough(p, [row])
  }
  // The key a row holds BEFORE an update: a write that leaves the key alone
  // still moves the range under it, and the payload does not name it. A scope
  // of several fields is moved by a payload naming only one of them (a row to
  // another day), so the key it moves TO is the row's own with the payload laid
  // over it.
  function noteExclusionBySql(whereSql, params, data) {
    if (!_exclNotes) return
    const where = whereSql ? ` WHERE ${whereSql}` : ''
    if (_exclMembers.length) {
      const sel = [...new Map(_exclMembers.flatMap(m => m.keyColumns.map((c, i) => [c, m.keyFields[i]]))).entries()]
        .map(([c, f]) => `"${c}" AS "${f}"`).join(', ')
      for (const row of writeDb.query(`SELECT DISTINCT ${sel} FROM "${tableName}"${where}`).all(...params)) {
        tx.exclusions.note(modelName, row)
        if (data) tx.exclusions.note(modelName, { ...row, ...data })
      }
    }
    for (const p of _exclParents) {
      if (!parentTouched(p, data)) continue
      const sel = p.pairs.map(([, c], i) => `${quoteIdent(c)} AS ${quoteIdent(p.refFields[i])}`).join(', ')
      tx.exclusions.noteThrough(p, writeDb.query(`SELECT DISTINCT ${sel} FROM ${quoteIdent(tableName)}${where}`).all(...params))
    }
  }

  return { _cardNotes, noteCardinality, noteCardinalityBySql, _exclNotes, exclTouched, noteExclusion, noteExclusionBySql }
}
