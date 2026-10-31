// state-guards.js — the rules that read the STORED row before a write lands:
// the transitions machine (where a row may start, which move a write is, who may
// make it, and the compare-and-swap that makes the move in the same statement)
// and the seal (a child of a sealed document, and the model's own frozen
// columns). Each is a predicate conjoined into the write's WHERE rather than a
// payload refusal, so a row that changed between the read and the write is not
// moved. A rule that reads the PAYLOAD is write-data.js.
//
// Built once per table by `makeTable`, which hands it the table-local facts in
// that closure — the read connection, the storage coercion, the immutable key
// set, the where compiler — and takes back the guards its verbs call.

import { modelToTableName, fieldToColumnName } from './ddl.js'
import { frozenAfterMove, machineWithMove } from './seal.js'
import { levelPasses } from '../plugins/gate.js'
import { requireCapability } from '../plugins/capability.js'
import { buildPolicyFilter } from './policy.js'
import { ident, sqlFragment, pairsOn } from './query.js'
import { ValidationError } from './validate.js'
import {
  TransitionViolationError, TransitionConflictError, TransitionGateError, TransitionSystemError,
  SoftDeleteWriteError, SealedDocumentError,
} from './errors.js'

// checkTransitions' answer for a row outside the caller's read scope — distinct
// from null, which means *no move applies* and lets the write go on.
export const NOT_VISIBLE = Symbol('not-visible')

// A key named in an error: its value for one column, the list for a composite.
const oneOrAll = (vals) => vals.length === 1 ? vals[0] : vals

export function makeStateGuards(shape, ctx, deps) {
  const { tableName, modelName, softDelete, enumFields, fieldPolicy } = shape
  const {
    readDb, col, _ecp, plugins, _immutableWriteKeys, _modelForKeys,
    resolveGlobalFilter, buildWhereWithEncryption,
  } = deps
  // ── Transition enforcement ───────────────────────────────────────────────
  //
  // Runs on update() and upsert() when the data touches a transitions-typed field.
  // Returns { transitionName, field, from, to } or null if no transition field touched.
  // Throws TransitionViolationError or TransitionConflictError.
  //
  // A BULK write may not name a transitions field at all (`FJS-671`).
  //
  // `updateMany` matches rows with a WHERE and never reads them, so there is no
  // `from` to grade — which made the state machine, its per-move `@gate`s and
  // its `@system` markings unreachable through one verb. Measured: a level-4
  // caller holding no capability made a `@gate(5)` move, a `@system` move, and
  // a move the schema does not declare, all by asking `updateMany` instead of
  // `update`. `FJS-044` ruled that skip deliberate and the reasoning survives
  // for every OTHER column; what it could not weigh is the capability grid and
  // `access.snapshot.md`, which arrived later and state a move's gate with no
  // per-verb qualification — so the artefact a reviewer reads certified
  // enforcement one verb did not apply. Refusing one KEY is narrower than
  // removing the tool.
  //
  // Refused for `asSystem()` as for everyone: the machine is integrity, not
  // authority, and a system principal lifts only authority (`FJS-D502`). A row
  // put where no move leads goes through `sys.sql`, the bypass that says so.
  //
  const _tableTransitions = shape.transitions
  const _tableCapabilities = shape.capabilities

  // Which transitions-typed column a bulk payload names, or null. `verb` is
  // carried into the message so the refusal names the call that was made.
  function _bulkTransitionField(data, verb) {
    if (!_tableTransitions || !data) return null
    for (const field of Object.keys(_tableTransitions)) {
      if (!(field in data)) continue
      return field
    }
    return null
  }

  // `deletedAt` belongs to remove()/restore(), never to a patch (`FJS-2578`).
  // `fields` is a payload, or the column list an upsertMany's update half
  // names. An `undefined` value is an omitted key, as everywhere else.
  function refuseSoftDeleteWrite(fields, verb) {
    if (!softDelete || !fields) return
    const named = Array.isArray(fields) ? fields.includes('deletedAt') : fields.deletedAt !== undefined
    if (named) throw new SoftDeleteWriteError(modelName, verb)
  }

  // Where a row may START (`FJS-D470`): the column's @default and nowhere else,
  // for every principal. `create` is the one write with no from-state, so a
  // gated destination named on the way in was reached without the move — a
  // USER(4) created a LeaveRequest `approved`, and nothing on the row said how
  // (`FJS-1257`). A row that belongs further along is created at the entry and
  // walked there by its declared moves.
  //
  // A declared machine's entries are rows (`fromId` null), so the row starts at
  // one of its scope's entries, and naming none takes the one there is. The
  // rows come back with that default filled, before the create policy grades
  // them, so a filled state cannot escape it (`FJS-1307`).
  function refuseOffEntry(rows) {
    if (!_tableTransitions) return rows
    for (const [field, spec] of Object.entries(_tableTransitions)) {
      if (spec.declaredBy) { rows = enterDeclared(field, spec, rows); continue }
      const norm = spec.isBoolean ? (v) => (v == null ? v : !!v) : (v) => v
      // A value the enum does not name is writeData's refusal, which lists the
      // members; answering it here would say where the row starts instead.
      const members = enumFields[field]?.values
      for (const row of rows) {
        if (row == null || !(field in row) || row[field] == null) continue
        if (members && !members.has(row[field])) continue
        if (norm(row[field]) !== spec.entry)
          throw new TransitionViolationError(modelName, field, null, row[field], [spec.entry])
      }
    }
    return rows
  }

  function enterDeclared(field, spec, rows) {
    return rows.map(row => {
      if (row == null) return row
      const entries = declaredTransitions(field, row[spec.scope]).filter(m => m.from == null).map(m => m.to)
      if (row[field] != null) {
        if (!entries.includes(row[field]))
          throw new TransitionViolationError(modelName, field, null, row[field], entries)
        return row
      }
      if (entries.length === 1) return { ...row, [field]: entries[0] }
      const whose = `${spec.scope} '${row[spec.scope]}'`
      throw new ValidationError([{ path: [field], message: entries.length
        ? `${modelName}.${field}: ${whose} has ${entries.length} entries in ${spec.declaredBy}, so a new row names one — ${entries.map(e => `'${e}'`).join(', ')}`
        : `${modelName}.${field}: ${whose} has no entry in ${spec.declaredBy}, so no ${modelName} can start there` }])
    })
  }

  // A declared machine, resolved once per table: the declarer's table and
  // column names, so a move is SQL with no lookup.
  const _declaredMachines = (() => {
    if (!_tableTransitions) return null
    const out = {}
    for (const [field, spec] of Object.entries(_tableTransitions)) {
      if (!spec.declaredBy) continue
      const decl = ctx.models[spec.declaredBy]
      const c = n => ident(fieldToColumnName(decl.fields.find(f => f.name === n))).sql
      out[field] = {
        table:      ident(modelToTableName(decl, ctx.pluralize ?? false)).sql,
        from:       c('fromId'),
        to:         c('toId'),
        gate:       decl.fields.some(f => f.name === 'gate') ? c('gate') : null,
        scope:      c(spec.scope),
        // The row's own scope column, as the move's correlated subquery names it.
        outer:      `${ident(tableName).sql}.${ident(col(spec.scope)).sql}`,
        // A move soft-deleted out of the table is a move the team removed.
        live:       decl.attributes.some(a => a.kind === 'softDelete') ? ' AND "deletedAt" IS NULL' : '',
      }
    }
    return Object.keys(out).length ? out : null
  })()

  // Every move a scope declares. A raw read, as @@extensible reads its
  // declarations: the machine binds every caller alike, so the declarer's own
  // gate and policy do not decide whether a move exists.
  function declaredTransitions(field, scopeValue) {
    if (scopeValue == null) return []
    const d = _declaredMachines[field]
    return readDb.query(
      `SELECT ${d.from} AS "from", ${d.to} AS "to", ${d.gate ?? 'NULL'} AS "gate" ` +
      `FROM ${d.table} WHERE ${d.scope} = ?${d.live}`,
    ).all(scopeValue).map(r => ({ from: r.from, to: r.to, gate: r.gate ?? null }))
  }

  // Resolve the caller's gate level for this model. GatePlugin owns the scale and
  // the per-request cache (ctx.levelFor). When a transition declares @gate the
  // plugin is guaranteed present — createClient auto-installs one — so a missing
  // resolver means something is misconfigured, and refusing is the safe read.
  async function transitionLevel() {
    if (typeof ctx.levelFor !== 'function') return 0
    return await ctx.levelFor(modelName, ctx)
  }

  // What this caller could READ of the table, as one WHERE fragment beside the
  // caller's own: the global filter, the plugins' read filters, then the read
  // policy — the composition `exists()` uses, in its bind order. Soft delete and
  // templates are not here because the update's own where already carries them.
  // null when nothing narrows.
  function callerReadScope() {
    const params  = []
    const filters = [resolveGlobalFilter(), ...(plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : [])].filter(Boolean)
    const filterSql = filters.length
      ? buildWhereWithEncryption(filters.length === 1 ? filters[0] : { AND: filters }, params)
      : ''
    const policy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx) : null
    if (policy) params.push(...policy.params)
    const parts = [filterSql, policy?.sql].filter(Boolean)
    return parts.length ? { sql: parts.map(p => `(${p})`).join(' AND '), params } : null
  }

  async function checkTransitions(data, whereParams, whereSql, systemFields = null, requestedMove = null) {
    if (!_tableTransitions) return null

    // Whether this CALLER may make this MOVE — the three refusals that are
    // true whatever the row is doing. One function because two paths reach it:
    // a move matched from (from, to) on an ordinary update, and a move asked
    // for by NAME through transition(). Two copies would be two answers to one
    // question the first time either learned something (Invariant 4).
    const gradeMove = async (fieldName, moveName, move) => {
      // @gate(9) is a move declared for its from-state and made by nobody, the
      // system client included, as a 9 is on @@gate.
      if (move.gate === 9) throw new TransitionGateError(tableName, fieldName, moveName, 9, ctx.isSystem ? 8 : await transitionLevel())

      // Everything below is authority — who may make the move — which is what
      // `asSystem()` lifts. The move itself, its from-state and its
      // compare-and-swap, still holds (`FJS-D502`).
      if (ctx.isSystem) return

      // A transition gate is a floor on top of @@gate's update level, which has
      // already passed to get here: shipping an order and refunding one are not
      // the same authority.
      //
      // levelPasses() and not `level < required`: 8 and 9 are sentinels rather
      // than rungs, so a comparison spelled by hand reads @gate(8) as *7 is
      // nearly enough* on the day a resolver stops clamping.
      if (move.gate != null) {
        const level = await transitionLevel()
        if (!levelPasses(move.gate, level))
          throw new TransitionGateError(tableName, fieldName, moveName, move.gate, level)
      }

      // ── The capability half of the same question ────────────────────────
      // A named move is one of the four things a capability can refer to
      // (`FJS-D139`), and it is graded HERE rather than in the plugin because
      // this is the only place that knows which move a write turned out to be:
      // `transition(id, 'pay')` and an update setting the column are the same
      // move, and both arrive as a payload. ANDed with the gate above it
      // (`FJS-D146`) — the gate is a floor, so both have to pass.
      if (_tableCapabilities?.transitions.has(moveName))
        requireCapability(modelName, moveName, ctx)

      // ── @system, the move half ──────────────────────────────────────────
      // The same statement `@system` makes about a column, made about a MOVE:
      // the application decides it and a caller may only ask. The escape is the
      // column mechanism unchanged — name the field on the write — because a
      // move IS a write to that column and there is no reason for two hatches.
      if (move.system) {
        const named = Array.isArray(systemFields) ? systemFields : systemFields ? [systemFields] : []
        if (!named.includes(fieldName))
          throw new TransitionSystemError(tableName, fieldName, moveName)
      }
    }

    // Find the first transitions-typed field in the data being written
    for (const [fieldName, spec] of Object.entries(_tableTransitions)) {
      if (!(fieldName in data)) continue
      let newValue = data[fieldName]
      if (newValue == null) continue

      // ── A machine whose moves are rows ───────────────────────────────────
      // The same ladder as below, with the moves read from the row's scope.
      // A move has no name in the file, so it is named for its target, as an
      // unnamed move onto an enum member is.
      if (spec.declaredBy) {
        const scope = callerReadScope()
        const current = readDb.query(
          `SELECT ${ident(col(fieldName)).sql} AS "v", ${ident(col(spec.scope)).sql} AS "s" FROM ${ident(tableName).sql} WHERE (${whereSql})${scope ? ` AND (${scope.sql})` : ''}`,
        ).get(...whereParams, ...(scope?.params ?? []))
        if (!current) return NOT_VISIBLE
        const from = current.v
        if (from == null) return null
        const moves   = declaredTransitions(fieldName, current.s)
        const targets = () => moves.filter(m => m.from === from).map(m => m.to)
        const move    = moves.find(m => m.from === from && m.to === newValue)
        if (requestedMove != null) {
          // Graded before the row's state, for the reason the named path below is.
          const into = move ?? moves.find(m => m.from != null && m.to === newValue)
          if (into) await gradeMove(fieldName, newValue, { gate: into.gate, system: false })
          if (from === newValue)
            throw new TransitionConflictError(tableName, fieldName,
              moves.filter(m => m.from != null && m.to === newValue).map(m => m.from), newValue,
              { actual: from, move: requestedMove })
        } else if (from === newValue) return null
        if (!move) throw new TransitionViolationError(tableName, fieldName, from, newValue, targets())
        if (requestedMove == null) await gradeMove(fieldName, newValue, { gate: move.gate, system: false })
        return { transitionName: newValue, field: fieldName, from, to: newValue, declared: true }
      }

      // Fetch current value — needed to validate from-state — through the
      // caller's READ scope. Every refusal below names the move, its gate or the
      // row's state, so reaching one on a row this caller cannot read tells them
      // the row exists (`FJS-1093`). Outside the scope it is NOT_VISIBLE, and
      // update() answers null before any refusal reader runs, exactly as for a
      // row that is not there — § Rule one in access-control.md.
      const scope = callerReadScope()
      const current = readDb.query(
        `SELECT "${col(fieldName)}" AS "${fieldName}" FROM "${tableName}" WHERE (${whereSql})${scope ? ` AND (${scope.sql})` : ''}`,
      ).get(...whereParams, ...(scope?.params ?? []))
      if (!current) return NOT_VISIBLE
      // The raw column, not a read() row, so a boolean arrives as 1/0; the write
      // payload is coerced the same way and the declaration holds real booleans.
      // Unnormalized, `0 === false` is false so a no-op looked like a move, and
      // `to === 1` matched no transition so every real move looked illegal.
      const norm = spec.isBoolean ? (v) => (v == null ? v : !!v) : (v) => v
      const currentValue = norm(current[fieldName])
      newValue = norm(newValue)
      if (currentValue == null) return null   // null current — no from-state to check

      const transitions = spec.transitions

      // ── A move asked for by NAME ─────────────────────────────────────────
      // `transition(id, 'calculate')` and `update({ data: { status } })` are
      // the same write and they are not the same QUESTION, and until now the
      // difference was lost on the way down: transition() desugars into
      // update(), so all that arrived was a column and a value.
      //
      // It matters at exactly one row state — the one the move was taking it
      // to. Carrying the value a row ALREADY holds is legitimate on an update,
      // because a form round-trips the whole row, so the check returned early
      // and enforced nothing. Asked for by NAME the same state means the
      // opposite: the move did not happen here, somebody else made it, and the
      // caller was told it succeeded (`FJS-611`).
      //
      // The early return took the gate, the capability and `@system` with it,
      // so a move `@gate(5)` and a move `@system` were both makeable by any
      // caller who could update the model, as long as the row was already at
      // the target. Measured: both succeeded.
      const named = requestedMove ? transitions[requestedMove] : null
      if (named) {
        // Graded BEFORE the row's state, and the order is the substance. A
        // gate, a capability and `@system` are statements about the CALLER and
        // the declared move — true whatever the row is doing — so a caller who
        // could never have made this move is told that, rather than being told
        // somebody beat them to it, which is both wrong and a fact about the
        // row they were not owed.
        await gradeMove(fieldName, requestedMove, named)

        if (currentValue === named.to)
          throw new TransitionConflictError(tableName, fieldName, named.from, named.to,
            { actual: currentValue, move: requestedMove })

        if (!named.from.includes(currentValue))
          throw new TransitionViolationError(tableName, fieldName, currentValue, named.to,
            Object.values(transitions).filter(t => t.from.includes(currentValue)).map(t => t.to))

        return { transitionName: requestedMove, field: fieldName, from: currentValue, to: named.to, stamps: named.stamps ?? [], stampBy: named.stampBy ?? null }
      }

      if (currentValue === newValue) return null   // no change — nothing to enforce

      // Find a valid transition: from includes currentValue, to === newValue
      let matchedName = null
      for (const [tName, { from, to }] of Object.entries(transitions)) {
        if (to === newValue && from.includes(currentValue)) { matchedName = tName; break }
      }

      if (!matchedName) {
        // Build list of valid target values from currentValue for error message
        const validTargets = Object.values(transitions)
          .filter(t => t.from.includes(currentValue))
          .map(t => t.to)
        throw new TransitionViolationError(tableName, fieldName, currentValue, newValue, validTargets)
      }

      // The move is legal — is this caller allowed to make it?
      await gradeMove(fieldName, matchedName, transitions[matchedName])

      return { transitionName: matchedName, field: fieldName, from: currentValue, to: newValue, stamps: transitions[matchedName].stamps ?? [], stampBy: transitions[matchedName].stampBy ?? null }
    }
    return null
  }

  // ── Seal guards ───────────────────────────────────────────────────────────
  //
  // `@sealed` on a parent's relation, plus a `@seals` move on that parent, says
  // these child rows are part of a document. The check has to read the PARENT's
  // current state, so it is a predicate rather than a payload refusal — the same
  // tier as the transition compare-and-swap above and composed the same way.
  //
  // It is deliberately NOT lifted by asSystem(). A seal is the @immutable tier —
  // a statement about what the row IS — where the gate, the row policies and
  // @guarded are all statements about who is asking.
  const _sealSelf    = shape.seal.self
  const _sealParents = shape.seal.parents

  // Correlated: every sealed parent of the row being written is still unsealed.
  // Goes in a WHERE, so it works for update and for delete, where the child row
  // is what supplies the foreign key.
  function sealWhereClause(whereSql, whereParams) {
    if (!_sealParents.length) return sqlFragment(whereSql, whereParams)
    const parts  = []
    const params = [...whereParams]
    _sealParents.forEach((p, i) => {
      const a = `_seal${i}`
      parts.push(
        `NOT EXISTS (SELECT 1 FROM "${p.parentTable}" "${a}" WHERE ${pairsOn(p.foreignKeys, `"${tableName}".`, p.referencedKeys, `"${a}".`)} ` +
        `AND "${a}"."${p.column}" IN (${p.states.map(() => '?').join(', ')}))`)
      params.push(...p.states.map(_ecp))
    })
    const guard = parts.join(' AND ')
    return sqlFragment(whereSql ? `(${whereSql}) AND ${guard}` : guard, params)
  }

  // The create half. There is no child row yet, so the parent is named by the
  // foreign key in the PAYLOAD — and an absent one is no parent to be sealed by,
  // which is what makes an optional relation keep working.
  // The SQL is the same for every row of the model, so it is built once; only
  // the bound foreign key varies. A NULL one matches no parent, which makes
  // NOT EXISTS true — an optional relation has no document to be sealed by, and
  // that falls out rather than being special-cased.
  const _sealInsertSql = _sealParents.length
    ? _sealParents.map(p =>
        `NOT EXISTS (SELECT 1 FROM "${p.parentTable}" WHERE ${p.referencedKeys.map(r => `"${r}" = ?`).join(' AND ')} AND ` +
        `"${p.column}" IN (${p.states.map(() => '?').join(', ')}))`).join(' AND ')
    : null

  function sealInsertGuard(row) {
    if (!_sealInsertSql) return null
    const params = []
    const named  = []
    for (const p of _sealParents) {
      const key = p.foreignKeys.map(f => row?.[f] ?? null)
      params.push(...key, ...p.states.map(_ecp))
      if (key.every(v => v != null)) named.push({ ...p, key })
    }
    return { sql: _sealInsertSql, params, parents: named }
  }

  // Why did that write touch nothing? Asked only on the failure path, and only
  // after everything else has had its say — a caller refused by a policy has to
  // be told THAT, not told the document is sealed.
  function sealRefusal(parents, operation) {
    for (const p of parents ?? []) {
      const row = readDb.query(
        `SELECT "${p.column}" AS s FROM "${p.parentTable}" WHERE ${p.referencedKeys.map(r => `"${r}" = ?`).join(' AND ')} LIMIT 1`).get(...p.key)
      if (row && p.states.some(s => _ecp(s) === row.s))
        return new SealedDocumentError(modelName, {
          parent: p.parentModel, parentId: oneOrAll(p.key), state: row.s,
          relation: p.relation, operation, idField: oneOrAll(p.referencedKeys),
        })
    }
    return null
  }

  // The same question for a write the guard rode in a WHERE: re-run the caller's
  // own criteria WITHOUT the seal conjunct, and if a row comes back the seal is
  // what refused it.
  function sealRefusalFor(whereSql, whereParams, operation) {
    if (!_sealParents.length) return null
    for (const p of _sealParents) {
      // A correlated subquery rather than a JOIN: the caller's own where is
      // unqualified (`"id" = ?`), so a second table in the FROM makes it
      // ambiguous — and on a self-referential @sealed relation it is the SAME
      // table, where no qualification could have helped.
      const ph  = p.states.map(() => '?').join(', ')
      const sql =
        `SELECT ${p.foreignKeys.map((f, i) => `"${f}" AS fk${i}`).join(', ')}, ` +
        `(SELECT "_p"."${p.column}" FROM "${p.parentTable}" "_p" WHERE ${pairsOn(p.foreignKeys, `"${tableName}".`, p.referencedKeys, '"_p".')}) AS s ` +
        `FROM "${tableName}" WHERE ${whereSql || '1=1'} AND EXISTS (SELECT 1 FROM "${p.parentTable}" "_q" ` +
        `WHERE ${pairsOn(p.foreignKeys, `"${tableName}".`, p.referencedKeys, '"_q".')} AND "_q"."${p.column}" IN (${ph})) LIMIT 1`
      const row = readDb.query(sql).get(...whereParams, ...p.states.map(_ecp))
      if (row)
        return new SealedDocumentError(modelName, {
          parent: p.parentModel, parentId: oneOrAll(p.foreignKeys.map((_, i) => row[`fk${i}`])), state: row.s,
          relation: p.relation, operation, idField: oneOrAll(p.referencedKeys),
        })
    }
    return null
  }

  // The model's OWN frozen columns, each frozen from a state rather than from
  // create. `@immutable` on a model that declares a `@seals` move means *frozen
  // at the seal*, and `@immutable(after: <move>)` means *frozen from that move's
  // target* (`FJS-D568`). Either way it stops being answerable from the payload
  // and becomes a state guard like the rest of them: one group per freeze instant.
  // A column a `@seals` move stamps joins the group: it is the instant a reader
  // trusts as when the row became a document, and without it a signed note can
  // be back-dated by a payload (`FJS-3713`). A later move stamping the same
  // column still lands, since a move writes its stamps in SET, not the payload.
  const _selfFreezes = []
  if (_sealSelf) {
    const machine = _modelForKeys?.attributes?.find(a => a.kind === 'transitions' && a.field === _sealSelf.column)
    const stamped = Object.values(machine?.transitions ?? {}).filter(t => t.seals).flatMap(t => t.stamps ?? [])
    const keys    = new Set([..._immutableWriteKeys, ...stamped])
    if (keys.size) _selfFreezes.push({ keys, column: _sealSelf.column, states: _sealSelf.states })
  }
  {
    const byMove = new Map()
    for (const [name, p] of Object.entries(fieldPolicy))
      if (p.immutableAfter) byMove.set(p.immutableAfter, [...(byMove.get(p.immutableAfter) ?? []), name])
    for (const [move, names] of byMove) {
      const frozen = frozenAfterMove(machineWithMove(_modelForKeys, move), move)
      if (frozen) _selfFreezes.push({ keys: new Set(names), column: frozen.field, states: [...frozen.states] })
    }
  }

  // It applies ONLY where the payload names a frozen column. Narrowing every
  // update on the model would refuse `settle: issued -> paid`, which is a move
  // the machine declares out of a state the seal put the row in.
  function sealSelfClause(data, whereSql, whereParams) {
    if (!_selfFreezes.length || !data || typeof data !== 'object' || Array.isArray(data))
      return { ...sqlFragment(whereSql, whereParams), frozen: [] }
    let sql = whereSql, params = whereParams
    const frozen = []
    for (const g of _selfFreezes) {
      const named = Object.keys(data).filter(k => g.keys.has(k))
      if (!named.length) continue
      frozen.push(...named)
      sql    = `(${sql}) AND "${g.column}" NOT IN (${g.states.map(() => '?').join(', ')})`
      params = [...params, ...g.states.map(_ecp)]
    }
    return { ...sqlFragment(sql, params), frozen }
  }

  function throwIfSealedSelf(frozen, whereSql, whereParams) {
    if (!frozen?.length) return
    for (const g of _selfFreezes) {
      const named = frozen.filter(k => g.keys.has(k))
      if (!named.length) continue
      const row = readDb.query(
        `SELECT "${g.column}" AS s FROM "${tableName}" WHERE ${whereSql} LIMIT 1`).get(...whereParams)
      if (row && g.states.some(v => _ecp(v) === row.s))
        throw new SealedDocumentError(modelName, {
          parent: modelName, parentId: null, state: row.s, operation: 'freeze', fields: named,
        })
    }
  }

  function throwIfSealed(whereSql, whereParams, operation) {
    const refusal = sealRefusalFor(whereSql, whereParams, operation)
    if (refusal) throw refusal
  }

  function applyTransitionWhereClause(transitionResult, finalWhereSql, finalWhereParams) {
    if (!transitionResult) return { sql: finalWhereSql, params: finalWhereParams }
    // A declared move is checked in the same statement, so a move a team
    // removes between the read and the write is not made (`FJS-D365`).
    const d = transitionResult.declared ? _declaredMachines[transitionResult.field] : null
    if (d) return {
      sql:    `(${finalWhereSql}) AND ${ident(col(transitionResult.field)).sql} = ? AND EXISTS (SELECT 1 FROM ${d.table} ` +
              `WHERE ${d.from} = ? AND ${d.to} = ? AND ${d.scope} = ${d.outer}${d.live})`,
      params: [...finalWhereParams, transitionResult.from, transitionResult.from, transitionResult.to],
    }
    // Add WHERE field = currentValue for optimistic concurrency
    return {
      sql:    `(${finalWhereSql}) AND "${col(transitionResult.field)}" = ?`,
      // _ecp: a boolean state is stored 1/0, and a raw `false` binds as nothing
      // the column ever equals — the swap would match no row and every move on a
      // Boolean machine would report a conflict.
      params: [...finalWhereParams, _ecp(transitionResult.from)],
    }
  }

  return {
    _tableTransitions, _sealSelf, _sealInsertSql, _selfFreezes,
    _bulkTransitionField, refuseSoftDeleteWrite, refuseOffEntry, checkTransitions, transitionLevel, declaredTransitions,
    sealWhereClause, sealInsertGuard, sealRefusal, throwIfSealed, sealSelfClause, throwIfSealedSelf,
    applyTransitionWhereClause,
  }
}
