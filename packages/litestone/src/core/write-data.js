// write-data.js — the payload boundary of a write: what a caller may name,
// what the row must carry, and the stored shape every value takes.
//
// `writeData` is the one place every payload passes through, and the refusals
// here are the rules that read the PAYLOAD rather than the stored row: the
// mass-assignment strip, @guarded and @system's write halves, @immutable,
// @sequence, the column capability tier, required and clearing checks,
// encryption and hashing, enum membership, @allow(write) on a create, and the
// bind-safety floor. @rank's minting sits beside them because a create lands
// at the end of its scope on the write connection, inside the unit.
//
// Built once per table by `makeTable`, which hands it the table-local facts
// it cannot derive from `shape` — the write connection, the @@extensible slot
// helpers, the seal — and takes back the functions its verbs call. A rule
// that reads the STORED row (a row policy, a transition, a seal) is not here.

import { modelToAccessor, isStoredField } from './ddl.js'
import { AccessDeniedError } from './plugin.js'
import { GATE_LIFT } from '../plugins/gate.js'
import { requireCapability, requireGrantSubset } from '../plugins/capability.js'
import { evalJs } from './policy.js'
import { encryptField, encryptDeterministic, hashField, parseEnvelope, verifiesAs } from './encryption.js'
import { isServerAssignedId, isServerFilled } from './ids.js'
import { validate, applyTransforms, applyTypedDefaults, ValidationError } from './validate.js'
import { after as rankAfter, isRankKey } from '@frontierjs/toolbelt/rank'
import { ident, serializeRow, serializeBooleans } from './query.js'
import { noteStamp } from './stamps.js'
import { enumOptions } from './args.js'

// ─── Strip unwritable fields ──────────────────────────────────────────────────

function stripVirtual(data, generatedFields, computedFields, fromFieldNames = null) {
  if (!data) return data
  const out = { ...data }
  for (const f of generatedFields) delete out[f]
  for (const f of computedFields)  delete out[f]
  if (fromFieldNames) for (const f of fromFieldNames) delete out[f]
  return out
}


// The key sets a write grades against, all from the schema. Built where
// makeTable needs them at table build, before the factory below exists.
export function writeKeySets(shape) {
  const { fieldPolicy } = shape
  // Pre-build allowed write keys for this model. Used by writeData to detect
  // typos before SQL — a typo would otherwise surface as the cryptic SQLite
  // error "table X has no column named Y". This set covers:
  //   - all scalar field names                       (user.email)
  //   - all relation names                           (user.account, user.posts)
  //     — relations with nested op shape are extracted before writeData,
  //       but they may also appear with scalar values during a typo
  //       (e.g. user wrote `account: 1` meaning accountId), and the
  //       suggestion machinery is still useful.
  //   - all FK columns derived from belongsTo relations (user.accountId)
  //   - "id" — always allowed as primary key
  //
  // Computed and generated fields are NOT writable, so they're omitted; if a
  // user passes one we want to surface the typo with a helpful hint.
  const _modelForKeys = shape.model
  const _allowedWriteKeys = new Set()
  // name → why it cannot be written. Kept separately because these names are
  // absent from _allowedWriteKeys and would otherwise be dropped by the
  // unknown-key strip, which is silent by design — so a caller who set a
  // @generated column learned nothing, on a write that could never land.
  const _virtualWriteKeys = new Map()
  if (_modelForKeys) {
    for (const f of _modelForKeys.fields) {
      const isComputed  = f.attributes?.find(a => a.kind === 'computed')
      const isGenerated = f.attributes?.find(a => a.kind === 'generated' || a.kind === 'funcCall')
      const isDerived   = f.attributes?.find(a => a.kind === 'derived')
      const isTransient = f.attributes?.find(a => a.kind === 'transient')
      const isFrom      = f.attributes?.find(a => a.kind === 'from')
      if (!isComputed && !isGenerated && !isDerived && !isTransient && !isFrom) _allowedWriteKeys.add(f.name)
      else _virtualWriteKeys.set(f.name,
          isComputed  ? `${f.name} is @computed — it is derived in JS on read and is not a column, so it cannot be written`
        : isDerived   ? `${f.name} is @derived — its value comes from its expression over this row, so writing it would be overwritten by the next read`
          // A @from field is a subquery over the TARGET, so a value written here
          // has nowhere to land and the next read answers the aggregate anyway.
          // Seed the target's rows instead.
        : isFrom?.op === 'column' ? `${f.name} is @from(${isFrom.rel}, ${isFrom.opValue}) — it is a column of the ${isFrom.rel} row read on demand, not a column here, so it cannot be written. Write ${isFrom.opValue} on the ${isFrom.rel} row instead`
        : isFrom      ? `${f.name} is @from(${isFrom.target}, ${isFrom.op}) — it is a subquery over ${isFrom.target} evaluated on read, not a column, so it cannot be written. Write the ${isFrom.target} rows it counts instead`
          // The one of these that a CALLER is meant to send. It reached the Data
          // boundary because nothing lifted it off the payload — an app writing
          // through the client directly, or a service that took the value from
          // ctx.transients and passed ctx.data on whole.
        : isTransient ? `${f.name} is @transient — the API accepts it and nothing stores it, so it has no column. Read it from ctx.transients and leave it out of the write`
        :               `${f.name} is @generated — its value comes from its ${isGenerated?.template ? 'template' : 'expression'} and cannot be written`)
    }
  }
  // The write half of @guarded. Precomputed because the set is empty on most
  // models, so the per-write cost is a size test.
  const _guardedWriteKeys = new Set(
    Object.keys(fieldPolicy).filter(name => fieldPolicy[name].guarded)
  )
  // @system — the same lock on the write side and nothing on the read side.
  const _systemWriteKeys = new Set(
    Object.keys(fieldPolicy).filter(name => fieldPolicy[name].system)
  )
  // @immutable — written at create and frozen after, for everybody including
  // asSystem(). Precomputed for the same reason the two above are.
  const _immutableWriteKeys = new Set(
    Object.keys(fieldPolicy).filter(name => fieldPolicy[name].immutable)
  )
  // @sequence — the counter's number, frozen after create with no `@immutable`
  // beside it and no seal to wait for. A renumbered row takes a value the
  // counter has not reached; the next create collides on it, the failed insert
  // rolls the counter back to the same value, and the scope 409s for ever
  // (`FJS-1988`).
  const _sequenceWriteKeys = new Set(
    (_modelForKeys?.fields ?? []).filter(f => f.attributes?.some(a => a.kind === 'sequence')).map(f => f.name)
  )
  // @capability — the column tier of the grid. Precomputed for the same reason:
  // empty on almost every model, so the per-write cost is a size test.
  const _capabilityWriteKeys = shape.capabilities?.columns ?? new Set()
  // The columns that HOLD capabilities, as opposed to the ones a capability grades.
  // Typed `Capability[]` — litestone synthesizes that enum from the schema's own
  // surface, so the type carries both the typo refusal and the escalation guard.
  const _grantColumns = new Set(
    (_modelForKeys?.fields ?? []).filter(f => f.type?.name === 'Capability').map(f => f.name))
  const _edgeNamespaces = new Set(Object.values(shape.edges).map(d => d.as))
  return { _allowedWriteKeys, _virtualWriteKeys, _guardedWriteKeys, _systemWriteKeys, _immutableWriteKeys,
           _sequenceWriteKeys, _capabilityWriteKeys, _grantColumns, _edgeNamespaces }
}

export function makeWriteData(shape, ctx, {
  writeDb, T, col, plugins, computedFns, hasFieldPolicy, _hasEnumFields,
  _extensible, _sealSelf, _tableTransitions, _fieldsByName, _authDefaultOf, _authFillsNull,
  allocateExtSlot, mirrorExtSlots, remirrorMovedRow, pathWriteRefusal, requiredFailure, storesWhatOmissionStores,
  keys,
}) {
  const { _allowedWriteKeys, _virtualWriteKeys, _guardedWriteKeys, _systemWriteKeys, _immutableWriteKeys,
          _sequenceWriteKeys, _capabilityWriteKeys, _grantColumns, _edgeNamespaces } = keys
  const { modelName, fieldPolicy, enumFields, jsonFields, generatedFields, computedFields, boolFields, fromFields } = shape
  const _hasFrom = Object.keys(fromFields).length > 0


  // A MINTED column is spelt `@guarded @system` (`FJS-D1133`): naming it in
  // `system:` lifts the write half, so a grant's digest is written by the
  // caller's own create and keeps the gate, the policies and the audit actor
  // (`FJS-1749`); the read half stays locked. Plain `@guarded` is asSystem()
  // only, and a `system:` naming of one is refused rather than honored, so the
  // schema alone says which columns the application fills on a caller's write.
  function refuseGuardedWrite(data, stamped, system) {
    const named  = new Set(Array.isArray(system) ? system : system ? [system] : [])
    const denied = Object.keys(data).filter(k =>
      _guardedWriteKeys.has(k) && !stamped?.has(k) && !(named.has(k) && _systemWriteKeys.has(k)))
    if (!denied.length) return
    const list     = (ks) => ks.map(f => `"${f}"`).join(', ')
    const are      = (ks) => ks.length > 1 ? 'are' : 'is'
    const unminted = denied.filter(k => named.has(k))
    if (unminted.length) throw new AccessDeniedError(
      `${modelName}: ${list(unminted)} ${are(unminted)} @guarded without @system, so naming it in system: lifts ` +
      `nothing — plain @guarded is written through asSystem() only. A column the application mints on the ` +
      `caller's own write is spelt @guarded @system.`,
      { model: modelName, operation: 'write' }
    )
    throw new AccessDeniedError(
      `${modelName}: ${list(denied)} ${are(denied)} @guarded — a system-context column on write as well as read. ` +
      `Write it through asSystem() or leave it out of the payload; a column the application mints on the ` +
      `caller's own write is spelt @guarded @system and named on the call (system: [${denied.map(f => `'${f}'`).join(', ')}]). ` +
      `For a column some callers may write, @allow(write, …) is the tool; @guarded answers both ` +
      `halves at once, which is why the two cannot sit on one field.`,
      { model: modelName, operation: 'write' }
    )
  }

  function refuseSystemWrite(data, system, stamped) {
    const allowed = new Set(Array.isArray(system) ? system : system ? [system] : [])
    // `stamped` for @guarded's reason — a @system column with a generated
    // default is written by the application in the most literal sense.
    const denied  = Object.keys(data).filter(k => _systemWriteKeys.has(k) && !allowed.has(k) && !stamped?.has(k))
    if (!denied.length) return
    // `message` crosses junction's boundary as the 403 body to a caller who can
    // do neither remedy; the author's remedy rides on `hint`, which stays server-side.
    const err = new AccessDeniedError(
      `${modelName}: ${denied.map(f => `"${f}"`).join(', ')} ${denied.length > 1 ? 'are' : 'is'} @system — ` +
      `written by the application rather than by its caller.`,
      { model: modelName, operation: 'write' }
    )
    err.hint =
      `Name the column on the call to write it and keep every other rule:\n\n` +
      `    db.${modelName.charAt(0).toLowerCase() + modelName.slice(1)}.update({ where, data, system: [${denied.map(f => `'${f}'`).join(', ')}] })\n\n` +
      `asSystem() writes it too, and drops the gate, the row policies and the person as the audit actor's kind with it.`
    throw err
  }

  // ── system: [...], what a call may name ─────────────────────────────────
  // A @system column, a @guarded column (its write half), a field whose moves
  // are declared, or the gate (`FJS-D575`). An entry naming nothing a call lifts is refused rather than
  // ignored: a misspelled or renamed column then reads as permission in review
  // and grants none, and `system: true` — transition()'s spelling, which knows
  // its own column — was accepted on a write and allowed nothing.
  function refuseSystemEntries(system, ops) {
    if (system == null) return
    const lower = modelName.charAt(0).toLowerCase() + modelName.slice(1)
    for (const e of Array.isArray(system) ? system : [system]) {
      if (typeof e !== 'string') throw new Error(
        `${modelName}: system names what the call writes as the application, as a list — got ${JSON.stringify(e)}. ` +
        `A @system column by name, or '${GATE_LIFT}' to grade the call SYSTEM against the model's own gate:\n\n` +
        `    db.${lower}.${ops[0]}({ data, system: ['${GATE_LIFT}'] })\n\n` +
        `transition() takes system: true because the move already names its column.`)
      if (e === GATE_LIFT) {
        if (ctx.gateFor?.(modelName, ops[0]) == null) throw new Error(
          `${modelName}: system: ['${GATE_LIFT}'] — the model declares no @@gate, so there is nothing to lift.`)
        continue
      }
      if (e.startsWith('@')) throw new Error(
        `${modelName}: system: ['${e}'] — '${GATE_LIFT}' is the one guarantee a call may lift by name. ` +
        `asSystem() lifts the rest, and lifts them together.`)
      if (!_systemWriteKeys.has(e) && !_guardedWriteKeys.has(e) && !_tableTransitions?.[e]) throw new Error(
        `${modelName}: system: ['${e}'] — "${e}" is not a @system or @guarded column` +
        `${_tableTransitions ? ' or a field with declared moves' : ''}, so naming it lifts nothing.`)
    }
  }

  function refuseImmutableWrite(data, stamped) {
    const denied = Object.keys(data).filter(k => _immutableWriteKeys.has(k) && !stamped?.has(k))
    if (denied.length) throw new ValidationError(
      denied.map(f => ({
        path: [f],
        message: `${f} is @immutable — written once, when the row was created, and not again. ` +
                 `Leave it out of the payload; to correct the value, write a new row that supersedes this one.`,
      })),
      { model: modelName, operation: 'write' }
    )
  }

  // ─── @rank ─────────────────────────────────────────────────────────────────
  //
  // A create with no key lands at the END of its scope, and so does an update
  // that moves a row to another scope without stating one (`FJS-D366`). Both
  // read the scope's last key, so both run where the INSERT or UPDATE runs:
  // on the write connection, inside the unit. Read anywhere else, two creates
  // in one scope mint the same key.
  //
  // The scope compares with IS, so every row whose parentId is NULL is one
  // scope. The lookup is raw — no policy, no soft-delete — because a key a
  // caller cannot see is still a key a new row must not tie with.
  const _ranks = shape.ranks
  const _rankFields = new Set(_ranks.map(r => r.field))
  const _rankBind = v => typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v ?? null
  const _sameScopeValue = (stored, v) => {
    const b = _rankBind(v)
    return stored == null || b == null ? stored == null && b == null : String(stored) === String(b)
  }
  // The scope a create lands in: a column left out takes its literal
  // @default, which the DDL would fill after this has already looked.
  const _rankScopeOf = (data, scope) =>
    scope.map(f => data?.[f] !== undefined ? data[f] : (shape.literalDefaults.find(d => d.field === f)?.value ?? null))

  function lastRankIn(field, scope, values) {
    const where = scope.map(f => `${ident(col(f)).sql} IS ?`).join(' AND ')
    const r = writeDb.query(`SELECT max(${ident(col(field)).sql}) AS k FROM ${T.sql}${where ? ` WHERE ${where}` : ''}`)
      .get(...values.map(_rankBind))
    const last = r?.k ?? null
    if (last != null && !isRankKey(last)) throw new ValidationError([{
      path: [field],
      message: `${field}: the last key in this scope is ${JSON.stringify(last)}, which is not a rank key, so nothing can be minted after it. ` +
               `db.${modelToAccessor(modelName)}.rebalance({ where }) rewrites the scope with keys @rank can extend.`,
    }], { model: modelName, operation: 'create' })
    return last
  }

  // `@default(sibling)`: copy the sibling's value when the column is unnamed.
  // Runs before writeData so @slug and the other transforms see the copy; every
  // create-shaped verb calls it, since a bulk row that skipped it hit NOT NULL.
  function applyFieldRefDefaults(data, stamped) {
    const refs = shape.fieldRefDefaults
    if (!refs?.length) return data
    const stamps = {}
    for (const { field, sourceField } of refs) {
      if ((data == null || data[field] == null) && data?.[sourceField] != null) {
        noteStamp(stamped, data, field)
        stamps[field] = data[sourceField]
      }
    }
    return Object.keys(stamps).length ? { ...(data ?? {}), ...stamps } : data
  }

  // `memo` carries a batch's own keys forward: the rows of a createMany are
  // stamped before any of them is inserted, so the table cannot answer for them.
  function applyRanks(data, stamped, memo = null) {
    if (!_ranks.length || !data) return data
    let out = data
    for (const { field, scope } of _ranks) {
      const values = _rankScopeOf(out, scope)
      const key    = memo && field + '\0' + JSON.stringify(values.map(_rankBind))
      if (out[field] != null) {
        if (memo && isRankKey(out[field]) && !(memo.get(key) >= out[field])) memo.set(key, out[field])
        continue
      }
      const last = memo?.has(key) ? memo.get(key) : lastRankIn(field, scope, values)
      const next = rankAfter(last)
      memo?.set(key, next)
      noteStamp(stamped, data, field)
      if (out === data) out = { ...data }
      out[field] = next
    }
    return out
  }

  // An update moving the row to another scope, with no key stated, takes the
  // end of the scope it lands in. One stating both is taken as written, and
  // one naming its own scope again does not move.
  const rankScopeTouched = data => !!data && _ranks.some(r =>
    data[r.field] === undefined && r.scope.some(f => data[f] !== undefined))

  function rankOnScopeChange(data, selAll, whereParams, stamped) {
    if (!rankScopeTouched(data)) return data
    const cur = writeDb.query(selAll).get(...whereParams)
    if (!cur) return data
    let out = data
    for (const { field, scope } of _ranks) {
      if (out[field] !== undefined) continue
      if (scope.every(f => out[f] === undefined || _sameScopeValue(cur[col(f)], out[f]))) continue
      const values = scope.map(f => out[f] !== undefined ? out[f] : cur[col(f)])
      if (out === data) out = { ...data }
      out[field] = rankAfter(lastRankIn(field, scope, values))
      noteStamp(stamped, data, field)
    }
    return out
  }

  function refuseRankBulkMove(data, verb) {
    const moved = _ranks.filter(r => data?.[r.field] === undefined && r.scope.some(f => data?.[f] !== undefined))
    if (moved.length) throw new ValidationError(moved.map(r => ({
      path: [r.field],
      message: `${verb} moves rows to another ${r.scope.join(' + ')} without stating ${r.field}, and one statement would give ` +
               `every row the same key. Move each row with update(), which puts it at the end of its new scope.`,
    })), { model: modelName, operation: 'update' })
  }

  function refuseSequenceWrite(data) {
    const denied = Object.keys(data).filter(k => _sequenceWriteKeys.has(k))
    if (denied.length) throw new ValidationError(
      denied.map(f => ({
        path: [f],
        message: `${f} is a @sequence — the counter assigned it when the row was created, and nobody writes it after. ` +
                 `Leave it out of the payload; a create may state one, which moves the counter past it.`,
      })),
      { model: modelName, operation: 'write' }
    )
  }

  function refuseMissingRequired(model, data) {
    const missing = []
    for (const f of model.fields) {
      if (f.type.optional || f.type.kind === 'relation' || f.type.kind === 'implicitM2M') continue
      const attrs = f.attributes ?? []
      // `@default(auth().x)` is server-filled only when there is a principal
      // carrying x: the stamp ran before this, so a gap here is a create no
      // principal could fill, and it reached the INSERT as SQLite's raw
      // NOT NULL — a 500 for what an anonymous caller asked (FJS-1793).
      const authField = _authDefaultOf.get(f.name)
      if (authField && data?.[f.name] === null && !_authFillsNull.has(f.name)) {
        missing.push({ path: [f.name], message: `${f.name} is required — a null beats its auth().${authField} default; omit ${f.name} to take the principal's` })
        continue
      }
      if (authField && data?.[f.name] == null) {
        if (!ctx.auth && !ctx.isSystem) refuseAnonymousAuthDefault(f.name, authField)
        missing.push({
          path: [f.name],
          message: `${f.name} defaults to auth().${authField} and ` +
            `${ctx.auth ? `the principal carries no ${authField}` : 'this create has no principal'} — name ${f.name} on the call`,
        })
        continue
      }
      if (isServerFilled(f, model)) continue
      // A required @transient field is required OF THE CALLER, on the wire,
      // where the API validates it. It is lifted off the payload before the
      // write, so demanding it here would refuse every write that obeyed it.
      if (attrs.some(a => a.kind === 'transient')) continue
      // An `@id` the SERVER assigns — an autoincrementing rowid alias, or a
      // declared default. One owner with the create-mode JSON Schema, because
      // the two answered it separately and disagreed: this tested the TYPE and
      // not the key, so an `Int` member of a composite key was treated as a
      // rowid alias, and a create that omitted it reached SQLite and came back
      // as a raw `NOT NULL constraint failed` naming a physical table
      // (`FJS-608`). `PRIMARY KEY (a, b)` is never a rowid alias.
      if (isServerAssignedId(f, model)) continue
      if (data?.[f.name] == null) missing.push(requiredFailure(f))
    }
    if (missing.length) throw new ValidationError(missing)
  }

  // A 401 and not the gate's 403: the create is open to this caller, and a
  // signed-in one would succeed. Junction reads `status` before the class name.
  function refuseAnonymousAuthDefault(field, authField) {
    const err = new AccessDeniedError(
      `${modelName}.create needs a principal: ${field} defaults to auth().${authField}, and the caller is not signed in. ` +
      `Sign in, or name ${field} on the call.`,
      { model: modelName, operation: 'create' })
    err.status = 401
    throw err
  }

  function refuseClearingRequired(data) {
    const clearing = []
    for (const key of Object.keys(data ?? {})) {
      if (data[key] !== null) continue
      const f = _fieldsByName.get(key)
      // A virtual column is refused by name upstream (`_virtualWriteKeys`) and
      // is not a column here either; an optional one is what `null` is for.
      if (!f || f.type.optional || !isStoredField(f)) continue
      clearing.push(requiredFailure(f))
    }
    if (clearing.length) throw new ValidationError(clearing)
  }

  function protectEncryptedFields(transformed) {
    for (const [fieldName, policy] of Object.entries(fieldPolicy)) {
      if (!policy.encrypted && !policy.hashed) continue
      if (!(fieldName in transformed)) continue
      const val = transformed[fieldName]
      if (val == null) continue
      // ── Is this already protected, or does it merely LOOK it? ──────────
      //
      // `isCiphertext(val)` read three characters and answered yes, so a
      // caller sending `v1.` plus their own text had it stored VERBATIM in a
      // column the app promises is encrypted — and read back as `null`, since
      // the decrypt then failed. The same one function gated the HASH path,
      // so a `v1.` value skipped hashing too and a `@hashed` column ended up
      // holding something that is not a digest of anything (`FJS-715`).
      //
      // Three things replace it. The MODE must match the column's own
      // protection. The value must actually VERIFY — GCM's tag is the answer
      // and a forgery cannot produce one. And a non-system caller may not
      // send one at all: a caller never legitimately holds ciphertext, so the
      // shape is either an accident (a value that starts `v1.`) or an
      // attempt, and both are better refused by name than stored in clear.
      const wantMode = policy.hashed ? 'hash' : 'enc'
      const env      = parseEnvelope(val)
      if (env) {
        if (!ctx.isSystem)
          throw new ValidationError([{ path: [fieldName], message:
            `${fieldName} looks like a stored ${env.mode === 'hash' ? 'digest' : 'ciphertext'} ` +
            `(it begins '${env.prefix}'). A caller sends the value itself — this column is ` +
            `${policy.hashed ? '@hashed' : '@encrypted'} and the encoding is the database's.` }])
        // A system write MAY carry one: a re-save, a restore, a backfill. It
        // is skipped only where it is genuinely that value's own encoding —
        // otherwise it falls through and is protected like any other string,
        // which is what makes a `v1.` in a `@hashed` column get hashed.
        if (verifiesAs(val, ctx.enc.ring ?? ctx.enc.key, wantMode)) continue
      }

      // A Json field is serialized to text BEFORE encryption, because
      // encryptField's String(plaintext) turns an object into
      // '[object Object]' and encrypts that — destroying the value with
      // nothing thrown. serializeRow() runs AFTER this block and stringifies
      // the ciphertext again, and read() mirrors it exactly (JSON.parse then
      // decrypt), so the round trip is symmetric and the stored column is
      // still a JSON string as the column type says.
      const plain = policy.json ? JSON.stringify(val) : val

      transformed[fieldName] = policy.hashed                 ? hashField(plain, ctx.enc.key)
                             : policy.encrypted.deterministic ? encryptDeterministic(plain, ctx.enc.key)
                             :                                  encryptField(plain, ctx.enc.key)
    }
  }

  function refuseBadEnums(transformed) {
    for (const [field, meta] of Object.entries(enumFields)) {
      const val = transformed[field]
      // An enum ARRAY has no CHECK behind it — SQLite cannot read the elements
      // of a JSON array without a subquery, and a CHECK may not contain one. So
      // this loop IS the boundary for a set-valued enum, not a nicer message in
      // front of one. Array-ness, @minItems and friends were checked in
      // validate() above.
      if (meta.array) {
        if (!Array.isArray(val)) continue
        const bad = val.filter(v => !meta.values.has(String(v)))
        if (bad.length) {
          throw new ValidationError([{
            path:    [field],
            message: `invalid ${meta.enumName} value${bad.length > 1 ? 's' : ''} ` +
                     `${bad.map(v => `"${v}"`).join(', ')} — ${enumOptions(meta, bad[0])}`,
          }])
        }
        continue
      }
      if (val == null) {
        if (!meta.optional && field in transformed)
          throw new ValidationError([{ path: [field], message: `must be one of: ${[...meta.values].join(', ')}` }])
        continue
      }
      if (!meta.values.has(String(val))) {
        throw new ValidationError([{
          path:    [field],
          message: `invalid ${meta.enumName} value "${val}" — ${enumOptions(meta, val)}`,
        }])
      }
    }
  }

  function dropFieldWriteDenied(transformed) {
    const refused = []
    for (const [fieldName, policy] of Object.entries(fieldPolicy)) {
      if (!policy.allow?.write?.length) continue
      if (!(fieldName in transformed)) continue
      const permitted = policy.allow.write.some(expr =>
        evalJs(expr, ctx, transformed, modelName, 'create')
      )
      if (permitted) continue
      delete transformed[fieldName]
      // A dropped column nothing else fills leaves the INSERT without a value
      // for a NOT NULL column, and SQLite's answer is a 500 that reads as a
      // crash. The caller was refused that column, so the write is refused.
      const f = shape.model.fields.find(x => x.name === fieldName)
      if (f && !f.type.optional && !isServerFilled(f, shape.model) && !isServerAssignedId(f, shape.model)
          && !f.attributes?.some(a => a.kind === 'transient')) refused.push(fieldName)
    }
    if (refused.length) throw new AccessDeniedError(
      `${modelName}: ${refused.map(f => JSON.stringify(f)).join(', ')} ${refused.length > 1 ? 'are' : 'is'} required, ` +
      `and this caller may not write ${refused.length > 1 ? 'them' : 'it'}.`,
      { model: modelName, operation: 'create' })
  }

  // A `File` column is a storage reference, and turning the bytes a caller
  // hands it into one is FileStorage's work. With no FileStorage installed a
  // single File reached `refuseUnbindable` and was refused about atomic
  // operators, naming neither the type nor the plugin; a `File[]` was worse —
  // it went through the Json path and stored `[{}]` (`FJS-1898`).
  const _fileFields = shape.model.fields.filter(f => f.type?.name === 'File').map(f => f.name)
  // A single File is parsed on read like a Json column, but its stored text is
  // FileStorage's to write: stringifying an object here would store a ref a
  // caller sent, which `refuseUnbindable` below refuses by name (FJS-D666).
  // A protected column's value is already its stored text: the ciphertext, or
  // the hash a deterministic lookup compares against.
  const _jsonWriteFields = new Set([...jsonFields].filter(f => {
    const t = shape.model.fields.find(m => m.name === f)?.type
    if (fieldPolicy[f]?.encrypted || fieldPolicy[f]?.hashed) return false
    return !(t?.name === 'File' && !t.array)
  }))
  // A string is storage's too: a data URL is bytes and anything else but ref
  // text (`{` first, the one thing FileStorage passes through) is refused there,
  // so with none installed the column would keep a caller's URL as-is and a
  // reader trusting it would render a stranger's address (`FJS-2699`).
  const _needsStorage = (v) => typeof v === 'string'
    ? !v.trimStart().startsWith('{')
    : v !== null && typeof v === 'object' && !(v instanceof Date)
  function refuseFileWithoutStorage(data) {
    if (!_fileFields.length || plugins?.handles('File')) return
    for (const k of _fileFields) {
      const v = data[k]
      if (!(Array.isArray(v) ? v.some(_needsStorage) : _needsStorage(v))) continue
      throw new ValidationError([{ path: [k], message:
        `${k} is a File column, and storing what it was given takes FileStorage, which this client does not install. ` +
        `Add FileStorage({ provider }) to the client's plugins: the bytes go to the provider and the column keeps the reference` }])
    }
  }

  function refuseUnbindable(row) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'function')
        throw new ValidationError([{ path: [k], message: `${k} was given a function — you probably forgot to call it` }])
      if (typeof v === 'symbol')
        throw new ValidationError([{ path: [k], message: `${k} was given a symbol — symbols cannot be stored` }])
      // FileStorage takes every file value before this, so an object left on a
      // File column is one it does not read, a stored ref most often. A ref is
      // the server's to write (FJS-D666), and the operators below are not what
      // a caller holding a file needs to hear about.
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && _fileFields.includes(k))
        throw new ValidationError([{ path: [k], message:
          `${k} is a File column and was given an object that is not a file. A stored reference is written by the ` +
          `server, never sent. Send the bytes: a data URL (data:<type>;base64,<data>) or { name, type, data } with base64 data` }])
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !ArrayBuffer.isView(v))
        throw new ValidationError([{ path: [k], message:
          `${k} was given an object where a value was expected. The atomic operators — ` +
          `increment, decrement, multiply, divide on a numeric column, push on an array one — ` +
          `apply on update only, and only to a column whose declared type carries them; ` +
          `anything else is a value, read it, change it and write it back` }])
    }
  }

  function writeData(data, { requireAll = false, system = null, fieldWrite = 'js', stamped = null, creating = false, where = null } = {}) {
    const model = shape.model

    // Unknown keys in the data payload are silently stripped — mass-assignment
    // protection, so a form/request body can be passed straight in without
    // whitelisting. (Deliberate policy choice 2026-08-01; typos in required
    // fields still surface via the required-field check below, and typo'd
    // *filters* are handled separately in where validation.)
    // A key set to `undefined` is dropped with them. The column list comes from
    // Object.keys, so a present-but-undefined key becomes an explicit NULL bind
    // — which defeats the DDL DEFAULT and fails a NOT NULL column. `{ views:
    // form.views }` off a form that had no views field is the shape that hits
    // it. Only `null` clears (Invariant 9).
    if (model && data && typeof data === 'object' && !Array.isArray(data)) {
      let cleaned = null
      for (const k of Object.keys(data)) {
        if (data[k] === undefined) {
          if (!cleaned) cleaned = { ...data }
          delete cleaned[k]
          continue
        }
        if (_allowedWriteKeys.has(k) || _edgeNamespaces.has(k)) continue
        // Stripping an UNKNOWN key silently is the mass-assignment protection.
        // Stripping a key the model declares but cannot store is a different
        // thing wearing the same clothes, and the caller has to hear about it.
        const why = _virtualWriteKeys.get(k)
        if (why) throw new ValidationError([{ path: [k], message: why }])
        // A PATH is the third thing wearing those clothes, and it was being read
        // as the first: `{ 'settings.commute': … }` names a column this model
        // has, so it is not a form body passing through — it is a caller who
        // meant something the boundary could have named (FJS-658).
        const dot = k.indexOf('.')
        const head = dot > 0 ? k.slice(0, dot) : null
        const headField = head && _fieldsByName.get(head)
        if (headField) throw new ValidationError([{ path: [k], message: pathWriteRefusal(k, head, headField) }])
        if (!cleaned) cleaned = { ...data }
        delete cleaned[k]
      }
      if (cleaned) data = cleaned
    }

    // A write to a table somebody DECLARES from invalidates every cached list:
    // a field declared at three o'clock has to be projected by the next write,
    // not by the next process.
    if (ctx.extDeclarers?.has(modelName)) ctx.extDecl?.clear()

    // ── @@extensible — the slot a declaration takes ───────────────────────
    //
    // Allocated here rather than by the app, because the three things it takes
    // are all facts the schema states: the pool, the order, and which slots are
    // already spoken for. An app writing this by hand has to read `max:` back
    // out of the parsed seed to get the pool and off the generated `@@index` to
    // get the order, which is the same fact restated in a second place — and
    // the place it goes wrong is silent, since a declaration with no slot
    // stores, renders and edits exactly like one that has one. Every field then
    // reads as *the pool is full*, every query still answers correctly, and
    // only the plan is different.
    //
    // Absent means allocate; a slot the payload STATES is honored. An import
    // restoring declarations has to be able to say which slot each one held,
    // and re-deriving them would repoint live fields onto slots whose mirrors
    // were written for somebody else — which does not self-heal the way the
    // mirror does, because the values are already in the wrong columns.
    if (creating && ctx.extDeclarers?.has(modelName)
        && data && typeof data === 'object' && !Array.isArray(data)
        && !('slot' in data) && _fieldsByName.has('slot')) [data, stamped] = allocateExtSlot(data, stamped)

    // ── @@extensible — the slot mirror ────────────────────────────────────
    //
    // The tenant's keys go in the blob; the mirror is the same values re-keyed
    // onto the pooled columns so a query can reach an index. It is DERIVED, so
    // the caller never sends it and never has to know a slot exists.
    //
    // Here rather than in each write verb because `writeData` is the one place
    // every payload passes through: `makeTable` hand-restates its rule sequence
    // per method, so a derived column added at eight call sites has a ninth
    // nobody noticed, and a mirror that is not rebuilt is a query that matches
    // the value a row used to hold.
    //
    // Rebuilt WHOLE rather than merged: a key removed from the blob has to
    // leave the mirror too, or a query goes on finding a row by a value it no
    // longer has. Absent means leave it alone — a patch naming other columns is
    // not a statement about these — and Invariant 9's explicit null clears.
    //
    // Under `scope:` the mirror is built from the PARENT ROW's declarations, so
    // a write moving a row to another parent rebuilds it even when the blob
    // is not in the payload.
    if (_extensible && data && typeof data === 'object' && !Array.isArray(data)) {
      if (_extensible.column in data) [data, stamped] = mirrorExtSlots(data, stamped, where)
      else if (_extensible.scope && !creating && _extensible.scope in data) [data, stamped] = remirrorMovedRow(data, stamped, where)
    }

    // ── @guarded, the write half ──────────────────────────────────────────
    // @guarded is a system-context lock in both directions. The read strips the
    // column; without this the same caller could still SET it, so the column was
    // invisible and writable at once — nobody could see what they overwrote and
    // the owner could not see that they had (FJS-235). The strip made a landed
    // write look exactly like a refusal, which is why it went unnoticed.
    //
    // Refused by name rather than dropped the way a field @allow(write) is:
    // naming a guarded column is not a form body passing through, and a silent
    // drop is the shape being fixed. @encrypted alone does NOT reach here — it
    // hides a value from a reader, and the caller supplying a secret is
    // routinely not the system.
    //
    // It grades the CALLER's keys, which is not the same set as the payload's:
    // by the time writeData is handed one, the create path has stamped
    // @default(uuid()) / @createdBy / @version / @sequence / @default(auth().x)
    // into it. Grading the payload made a guarded column refuse its own stamp,
    // so `@guarded @default(nanoid())` — a token the engine mints and no caller
    // may set, which is the shape this pairing exists for — made the model
    // uncreatable by anyone below system (FJS-565). `stamped` is what the
    // stamps injected; every caller of writeData that stamps passes one, and an
    // entry point that forgets is refused rather than let through, which is the
    // safe direction for a fail-closed rule.
    if (!ctx.isSystem && _guardedWriteKeys.size && data && typeof data === 'object' && !Array.isArray(data)) refuseGuardedWrite(data, stamped, system)

    // ── @system, the write half ───────────────────────────────────────────
    // The column reads like any other and is written by the application, not by
    // the person using it — a tracking code a courier job books, an API key's
    // hint, a workspace stamped from a header. Before this the schema could not
    // say so, so a generated form offered a text box whose value a worker
    // overwrote a second later (FJS-095).
    //
    // Refused by name rather than dropped, for @guarded's reason: the client is
    // told `readOnly` and a generated form does not offer the column at all, so
    // a payload naming it is code that meant to write it. A field
    // @allow(write, …) still DROPS — there the same payload is legitimate for
    // another caller, and a form body passing through an ordinary one is
    // expected traffic.
    //
    // Nothing above this refuses it earlier. Junction's autoValidate does not
    // read `readOnly`, and must not start: `@version` is readOnly in the update
    // schema and a patch is REQUIRED to carry it back. So this is the boundary
    // that answers, and it answers 403 rather than 400.
    //
    // The narrow hatch is `system: ['col']` on the call, which keeps every
    // other protection — the gate, the row policies, soft-delete, the audit
    // actor's kind — where asSystem() drops all of them to write one column. Naming
    // the field IS the statement: an escape hatch may not disable a guarantee
    // silently.
    if (!ctx.isSystem && _systemWriteKeys.size && data && typeof data === 'object' && !Array.isArray(data)) refuseSystemWrite(data, system, stamped)

    // ── @immutable, the write half ────────────────────────────────────────
    // Written once, at create, and frozen after — what a DOCUMENT is
    // (`FJS-D162`). An invoice's number, the instant it was issued and the
    // total it was issued for are a statement about a moment, and a correction
    // is a credit note rather than an edit.
    //
    // It refuses the KEY and never compares the value, which is the only thing
    // a rule here could do: nothing in this language can see the stored row
    // beside the incoming one. So *I sent the same total back* is refused too,
    // and that is the behavior wanted — a form that round-trips a frozen
    // column is a form that would have overwritten it the day somebody changed
    // the box.
    //
    // Outside the `!ctx.isSystem` guard the two blocks above share, and that is
    // the whole substance of the ruling: a renewal job and a payment settler
    // both run as system, so a rule they may drop is a rule absent from every
    // caller that actually writes an invoice. `@check` and `@@check` are the
    // company it keeps (`FJS-519`); a raw UPDATE still bypasses it, as it does
    // one of those.
    //
    // `creating` defaults to false, so an entry point that forgets to say it is
    // a create refuses rather than lets through — @guarded's own reasoning, and
    // the safe direction for a fail-closed rule.
    // On a SEALING model the freeze has a moment, so it cannot be answered from
    // the payload: `@immutable` there means *frozen at the seal*, and the row is
    // editable while it is still a draft. The refusal moves into the WHERE with
    // the other state guards; `_sealImmutable` below is where the keys go.
    if (!creating && _immutableWriteKeys.size && !_sealSelf && data && typeof data === 'object' && !Array.isArray(data)) refuseImmutableWrite(data, stamped)
    if (!creating && _sequenceWriteKeys.size && data && typeof data === 'object' && !Array.isArray(data)) refuseSequenceWrite(data)

    // ── @capability, the column tier ──────────────────────────────────────
    // `Server.update` says a caller may write the row; `Server.hostname` says
    // this one column needs a grant of its own (`FJS-D147`). Opt-in per column
    // rather than derived, because deriving every writable column gives basecamp
    // 461 capabilities and no picker can show that.
    //
    // Refused by name rather than dropped, which is the difference between this
    // and a field @allow(write, …) that happens to name a capability: a
    // capability THROWS (`FJS-D146`), because it is verb-scoped and refusing
    // leaks nothing about any row.
    //
    // Only the WRITE tier is here. A per-column READ wants the predicate
    // spelling — @allow(read, 'X' in auth().capabilities) — because a column
    // read must STRIP rather than refuse, or a caller who never named the column
    // gets a 403 on an ordinary list.
    //
    // The payload this reads is the one AFTER the create path applies its stamps,
    // which is why @capability beside @default(auth().x) is refused at parse: the
    // stamp would refuse itself and take every create with it.
    // CREATE only. On an update the plugin's `_checkUpdate` owns this, because
    // there the column grant REPLACES `Model.update` for the keys it covers and
    // that partition needs the whole payload in one place. A create is the other
    // shape: `Model.create` is the grant for making the row exist at all and is
    // not the one a column grant was meant to withhold, so both apply.
    //
    // The grant is charged for WRITING the column. A key carrying what leaving
    // it out would store (`null` on a column with no default, the literal
    // default itself) writes nothing, and a generated create form names every
    // column `make()` seeded, so charging it refused the form for a field it
    // does not show (`FJS-1517`). An update cannot make this test: the stored
    // value is not in hand, and a `null` there may be a clear.
    if (!ctx.isSystem && requireAll && _capabilityWriteKeys.size &&
        data && typeof data === 'object' && !Array.isArray(data)) {
      for (const k of Object.keys(data))
        if (_capabilityWriteKeys.has(k) && !storesWhatOmissionStores(k, data[k])) requireCapability(modelName, k, ctx)
    }

    // ── The escalation guard on a grant column ────────────────────────────
    // The values are already known to be REAL capabilities — that is the enum's
    // job, one layer down. This asks the other question: may this caller hand
    // them out. Subset, never a rank (`FJS-529`).
    if (!ctx.isSystem && _grantColumns.size && data && typeof data === 'object' && !Array.isArray(data)) {
      for (const k of Object.keys(data))
        if (_grantColumns.has(k)) requireGrantSubset(modelName, k, data[k], ctx)
    }

    // Required-field pre-flight. The schema knows requiredness; without this
    // a missing NOT NULL field surfaced as SQLite's raw "NOT NULL constraint
    // failed" instead of a ValidationError shaped like every other field rule.
    // A server fill (`@default`, an array's `[]`) is for an ABSENT key, so the
    // pre-flight exempts those columns and an explicit `null` on one reached
    // SQLite's NOT NULL (`FJS-2042`).
    if (model && requireAll) {
      refuseMissingRequired(model, data)
      refuseClearingRequired(data)
    }

    // The OTHER thing a payload can say, and the one shape that is
    // unambiguously wrong.
    //
    // An absent key on a partial write means *leave it alone*, which is why the
    // block above is create-shaped only and correctly so. An explicit `null` is
    // Invariant 9's *clear this*, and clearing is exactly what a NOT NULL column
    // cannot do — so with nothing checking it, the payload nobody could defend
    // was the one that reached SQLite: a bare `NOT NULL constraint failed:
    // item.name`, which declares no status and lands as a 500 with a null body,
    // where the same mistake on a create is a 400 naming the field (`FJS-669`).
    // `FJS-608` is the same class one door along and was fixed the same way, by
    // testing the KEY rather than letting the database answer.
    //
    // `@default` does not exempt here, where it does above: a default fills an
    // ABSENT key and this key is present. Measured — `qty: null` on
    // `Int @default(1)` reaches SQLite and is refused by it.
    //
    // `undefined` is not this, and is not handled here: the strip above deletes
    // an undefined-valued key and reassigns `data`, so this loop cannot see one.
    // `=== null` is still what it should say — the rule is about the value, and
    // stating it here is what keeps this correct if that strip ever moves.
    else if (model) refuseClearingRequired(data)

    let transformed = model ? applyTransforms(data, model) : { ...data }
    if (model && ctx.typeMap?.size) transformed = applyTypedDefaults(transformed, model, ctx.typeMap)
    // Array rules — shape, element type, @minItems/@maxItems/@uniqueItems —
    // live in validate.js with every other rule, and `buildValidationMap` flags
    // a model with any array field so this call is reached. They were enforced
    // here once, with their wording built at the throw site, so an authored
    // `@minItems(2, "Pick at least two tags")` reached the browser through
    // `x-messages` and was ignored by the server (FJS-194).
    if (model && shape.hasValidation) validate(transformed, model, computedFns, ctx.typeMap, ctx.enumTypeMap)

    // Encrypt @encrypted / hash @hashed fields before write
    if (ctx.enc.key && hasFieldPolicy) protectEncryptedFields(transformed)

    // Validate enum fields with friendly errors before hitting SQLite's CHECK
    if (_hasEnumFields) refuseBadEnums(transformed)
    // @allow(write, expr) — silently drop restricted fields before write.
    // Dropped rather than refused because the predicate is per-caller: the same
    // payload is legitimate for an admin, so a form body reaching an ordinary
    // caller is expected traffic. @guarded above is the other answer, for a
    // column no caller may write at all.
    //
    // **This is the CREATE half only** (`FJS-D129`). Here the payload IS the row
    // being created, so grading the predicate against it is the same thing
    // `checkCreatePolicy` does one layer up and is correct. On an UPDATE it is
    // not: the row exists, and evaluating `auth().id == ownerId` against the
    // PAYLOAD is wrong in both directions — a payload omitting `ownerId` grades
    // against `undefined` and drops a column the owner was entitled to write,
    // and a payload STATING `ownerId: me` grades against the caller's own
    // assertion and writes the column on somebody else's row (`FJS-433`, and
    // that second one is fail-open). The update paths pass `fieldWrite: 'sql'`
    // and the predicate becomes the WHEN of a CASE in the SET, where it reads
    // the stored row.
    if (!ctx.isSystem && fieldWrite === 'js') dropFieldWriteDenied(transformed)

    refuseFileWithoutStorage(transformed)
    const row = serializeRow(
      serializeBooleans(
        stripVirtual(transformed, generatedFields, computedFields, _hasFrom ? Object.keys(fromFields) : null),
        boolFields
      ),
      _jsonWriteFields
    )

    // Everything above has run, so every remaining value is about to become a
    // bind parameter. A plain object here is the one unbindable value bun:sqlite
    // does not throw on — it reads it as a bag of NAMED parameters, matches none
    // of the statement's positional `?`, and executes with EVERY binding dropped
    // including the WHERE. The write silently changes nothing and `update`
    // reports it as "no such row". Json columns are already text by this point,
    // so anything still an object is genuinely unbindable.
    refuseUnbindable(row)
    return row
  }

  return {
    writeData, refuseSystemEntries, applyFieldRefDefaults, applyRanks, rankOnScopeChange,
    rankScopeTouched, refuseRankBulkMove, _ranks, _rankFields, _rankBind,
  }
}
