// errors.js — every error this client throws, and the predicates that read one
//
// They are here rather than in client.js because they are the one part of that
// file with no dependency on it: no schema, no connection, no context. Junction's
// error boundary constructs several of them by name (`errors.snapshot.md` runs
// each through `toFrameworkError`), so the set is a published surface.
//
// Two things every class in here states, because `toFrameworkError` reads both
// and they answer different questions: `status` is what happened, `retryable` is
// whether doing it again is a strategy. A class carrying only `retryable` falls
// through to the name branch, finds no entry and answers GeneralError — a caller
// told the server had broken about a lock somebody else was holding (FJS-255).

// ─── Transition error types ──────────────────────────────────────────────────

export class TransitionViolationError extends Error {
  constructor(model, field, from, to, allowed) {
    super(`Cannot transition ${model}.${field} from '${from}' to '${to}' — valid transitions from '${from}': ${allowed.length ? allowed.map(a => `'${a}'`).join(', ') : 'none'}`)
    this.name       = 'TransitionViolationError'
    this.model      = model
    this.field      = field
    this.from       = from
    this.to         = to
    // 409: the request conflicts with the row's current state. Junction reads
    // err.status directly — no mapper, no registration — which is the documented
    // contract for an error class you own. Without it this surfaced as a 500
    // GeneralError, telling a caller to retry something that will never work.
    this.status     = 409
    this.retryable  = false
  }
}

export class TransitionConflictError extends Error {
  /**
   * `expected` is the state (or, for a move asked for by NAME, the set of
   * states) the move required. `actual` is where the row actually is, which is
   * the fact that makes the answer usable — and the one that decides whether
   * retrying can ever work.
   */
  constructor(model, field, expected, to, { actual, move } = {}) {
    const want  = Array.isArray(expected) ? expected.map(v => `'${v}'`).join(' or ') : `'${expected}'`
    const where = actual === undefined ? 'the row was modified before the update could complete'
                : actual === to        ? `the move has already been made — the row is at '${to}'`
                :                        `the row is at '${actual}', not ${want}`
    super(`Transition conflict on ${model}.${field}${move ? ` ('${move}')` : ''}: ${where} ` +
          `(expected ${want}, transition to '${to}')`)
    this.name      = 'TransitionConflictError'
    this.model     = model
    this.field     = field
    this.move      = move ?? null
    this.expected  = expected
    this.actual    = actual ?? null
    this.to        = to
    // 409 as well. Retrying is worth it when the row simply MOVED — re-read and
    // decide. It is never worth it when the row moved to exactly where this
    // move was taking it: the move happened, somebody else made it, and
    // re-applying conflicts for ever. `isStaleWrite()` reads this, so the two
    // cases have to be told apart here or a worker loops against a settled row.
    this.status    = 409
    // Stated rather than derived from a comparison of two undefineds: an
    // unknown `actual` is the historical contract and stays retryable.
    this.retryable = actual === undefined ? true : actual !== to
    // The same declared payload `VersionConflictError` carries, for the same
    // reason and read by the same function: instance properties do not cross
    // junction's error boundary and `data` does, so without this `actual` — the
    // whole point of the distinction — never reaches the browser, and a screen
    // cannot tell *somebody already made this move* from *the row moved
    // somewhere else*. `toConflict()` destructures exactly these four.
    this.data = { model, field, expected, actual: actual ?? null, move: this.move, to }
  }
}

// ─── @version — optimistic concurrency ────────────────────────────────────────
// The same compare-and-swap @@transitions already runs, with the column
// unfrozen: an update narrows its WHERE by the version the caller read, and no
// rows changed against a row that still exists means somebody else got there
// first. Both 409s, and the distinction between them is the useful part —
// one says "you did not tell me which row you read", the other says "you did,
// and it moved".

export class VersionRequiredError extends Error {
  constructor(model, field) {
    super(`${model}.${field} is @version — an update must carry the version it read (data.${field}). Use asSystem() for a write that is not a concurrent editor.`)
    this.name      = 'VersionRequiredError'
    this.model     = model
    this.field     = field
    // 400, not 409: nothing conflicted. The caller left out a required input,
    // and retrying the identical request will fail the identical way.
    this.status    = 400
    this.retryable = false
  }
}

export class VersionConflictError extends Error {
  constructor(model, field, expected, actual) {
    super(`Version conflict on ${model}: expected ${field} ${expected}, row is at ${actual} — it was modified after you read it`)
    this.name      = 'VersionConflictError'
    this.model     = model
    this.field     = field
    this.expected  = expected
    this.actual    = actual
    // The two revisions on `data`, which is the field junction's error boundary
    // carries to the client. Without them a browser is told only that something
    // moved, and cannot offer *reload* against *overwrite* — the numbers are
    // the half neither the status nor `retryable` can express.
    this.data      = { model, field, expected, actual }
    // 409 + retryable, exactly like TransitionConflictError: re-read and re-apply
    // is a real strategy here, which is what tells a caller to do it.
    this.status    = 409
    this.retryable = true
  }
}

export class TransitionGateError extends Error {
  constructor(model, field, transitionName, required, got) {
    super(`Transition '${transitionName}' on ${model}.${field} requires level ${required}, user has level ${got}`)
    this.name       = 'TransitionGateError'
    this.model      = model
    this.field      = field
    this.transition = transitionName
    this.required   = required
    this.got        = got
    this.status     = 403   // own the mapping — junction reads err.status, no registration needed
    this.retryable  = false
  }
}

/**
 * A move declared `@system` — the application makes it, and this caller did not
 * say they were the application.
 *
 * Separate from `TransitionGateError` because the remedy is different in kind.
 * A gate refusal is answered by being more senior; this one cannot be answered
 * by any caller at any level, only by the code that owns the move naming the
 * column on the write. Both are 403, and a screen that treats them alike tells
 * a person to ask an administrator for something no administrator can do.
 */
export class TransitionSystemError extends Error {
  constructor(model, field, transitionName) {
    super(`Transition '${transitionName}' on ${model}.${field} is @system — the application makes this move, ` +
          `not its caller. Name the column on the write to make it and keep the gate, the row policies and ` +
          `the audit actor:\n\n` +
          `    db.${model.charAt(0).toLowerCase() + model.slice(1)}.transition(id, '${transitionName}', { system: true })\n\n` +
          `asSystem() makes it too, and drops all three with it.`)
    this.name       = 'TransitionSystemError'
    this.model      = model
    this.field      = field
    this.transition = transitionName
    this.status     = 403
    this.retryable  = false
  }
}

/**
 * A bulk write named a transitions-typed column.
 *
 * `updateMany` matches rows with a WHERE and never reads them, so there is no
 * `from` state to grade — which made the whole state machine, its per-move
 * gates and its `@system` markings unreachable through one verb. Measured: a
 * level-4 caller holding no capability moved a row through a `@gate(5)` move,
 * through a `@system` move, and through a move the schema does not declare, all
 * by asking `updateMany` instead of `update` (`FJS-671`).
 *
 * `FJS-044` ruled the skip deliberate — a power tool whose caller takes
 * responsibility — and that reasoning survives here for every OTHER column.
 * What it could not have weighed is the capability grid and
 * `access.snapshot.md`, both of which arrived later and both of which state the
 * move's gate with no per-verb qualification: the committed artefact a reviewer
 * reads certified enforcement one verb did not apply. Refusing one KEY is
 * narrower than removing the tool.
 *
 * 400 rather than 403, and the difference is the point: no level answers it and
 * no grant answers it, because the verb is wrong rather than the caller.
 */
export class BulkTransitionError extends Error {
  constructor(model, field, verb = 'updateMany') {
    const accessor = model.charAt(0).toLowerCase() + model.slice(1)
    super(`${verb}() cannot write ${model}.${field} — it is a transitions field, and a bulk write ` +
          `matches rows without reading them, so there is no from-state to grade against ` +
          `@@transitions. Move one row at a time:

` +
          `    db.${accessor}.transition(id, '<move>')      // by name — the gate and @system apply
` +
          `    db.${accessor}.update({ where: { id }, data: { ${field}: … } })

` +
          `Every other column on this model is still bulk-writable, in the same call.`)
    this.name      = 'BulkTransitionError'
    this.model     = model
    this.field     = field
    this.status    = 400
    this.retryable = false
  }
}

export class TransitionNotFoundError extends Error {
  constructor(model, transitionName, available) {
    super(`Transition '${transitionName}' not found on ${model} — available: ${available.length ? available.map(t => `'${t}'`).join(', ') : 'none'}`)
    this.name           = 'TransitionNotFoundError'
    this.model          = model
    this.transition     = transitionName
    // 400: the payload named a transition this model does not declare. That is
    // a malformed request, not a state conflict.
    this.status         = 400
    this.retryable      = false
  }
}

// ─── Soft delete × @unique ───────────────────────────────────────────────────
//
// A soft-deleted row KEEPS its unique values, and that is the ruling rather
// than an oversight: the row is still there, so freeing the slot would make
// `@unique` false for every read that includes deleted rows — `findUnique(…,
// withDeleted: true)` would legitimately match two — and would make `restore()`
// conditionally impossible, which is soft delete's whole contract. SQLite also
// cannot make an inline UNIQUE partial, so the alternative is re-emitting every
// constraint as an index and rebuilding every table that has one.
//
// What was wrong is the REPORT. `UNIQUE constraint failed: doc.code` against a
// table `count()` says is empty sends every first diagnosis to the index
// (FJS-204).

export class SoftDeletedUniqueError extends Error {
  // Every argument is normalised rather than trusted. This is constructed on a
  // failure path, so a throw inside it replaces a diagnosable error with an
  // opaque one — and `junction errors` probes it with generic arguments, where
  // a class that cannot be constructed is reported as an unclassified 500.
  constructor(model, fields, values, id, idField = 'id') {
    fields = Array.isArray(fields) ? fields : fields == null ? [] : [fields]
    values = Array.isArray(values) ? values : values == null ? [] : [values]
    const named = fields.length
      ? fields.map((f, i) => `${f} = ${JSON.stringify(values[i])}`).join(', ')
      : 'a @unique value'
    super(
      `${model}: a soft-deleted row still holds ${named}${id == null ? '' : ` (${idField} ${id})`}. ` +
      `A soft-deleted row keeps its @unique values — it still exists, and restore() has to be able to bring it back. ` +
      `Restore it, or release the value first: update({ where: { ${idField}: ${JSON.stringify(id)} }, ` +
      `data: { … }, withDeleted: true }) to change it, or delete({ … , withDeleted: true }) to remove the row for good.`)
    this.name      = 'SoftDeletedUniqueError'
    this.model     = model
    this.fields    = fields
    this.values    = values
    this.id        = id ?? null
    // A conflict with a row that is there — the same category as the version and
    // transition families. Retrying changes nothing until the slot is released,
    // which is a decision the caller has to make.
    this.status    = 409
    this.retryable = false
  }
}

// ─── A row that is part of a sealed document ─────────────────────────────────
//
// `@seals` on a move says the row became a document; `@sealed` on a relation
// says which children it is made of. After the seal those children may not be
// created, changed or removed — the correction is a new row beside the document,
// never an edit to it.
//
// It is a class of its own rather than an AccessDeniedError because nobody's
// standing is at issue: `asSystem()` does not lift it, exactly as it does not
// lift @immutable, and telling an operator they are not senior enough would
// send them looking for a level that does not exist.

export class SealedDocumentError extends Error {
  constructor(model, { parent, parentId, state, relation, operation, fields, idField = 'id' } = {}) {
    const a    = /^[AEIOU]/i.test(model) ? 'an' : 'a'
    const what = operation === 'create' ? `add ${a} ${model} to` : `${operation ?? 'change'} ${a} ${model} of`
    super(operation === 'freeze'
      ? `Cannot write ${fields.join(', ')} on ${model} — it is at '${state}', which is sealed, and ` +
        `${fields.length > 1 ? 'those columns are' : 'that column is'} @immutable. ` +
        `A sealed document is a statement about a moment: correct it with a new row beside it rather than by editing it.`
      : `Cannot ${what} ${parent} ${parentId == null ? '' : `(${idField} ${JSON.stringify(parentId)}) `}` +
        `— it is at '${state}', and its ${relation ?? model} rows are sealed. ` +
        `A sealed document is a statement about a moment: correct it with a new row beside it rather than by editing it.`)
    this.name      = 'SealedDocumentError'
    this.model     = model
    this.parent    = parent ?? null
    this.parentId  = parentId ?? null
    this.state     = state ?? null
    this.relation  = relation ?? null
    this.operation = operation ?? null
    this.fields    = fields ?? []
    // The same category as the @unique and version families: the row is there,
    // it is refused, and retrying changes nothing.
    this.status    = 409
    this.retryable = false
    this.data      = { model, parent: this.parent, parentId: this.parentId, state: this.state, relation: this.relation }
  }
}

// ─── An ordinary @unique conflict ────────────────────────────────────────────
//
// The neighbouring cases were done and this one was the gap: a conflict a
// DELETED row caused says so (SoftDeletedUniqueError), a conflict inside a
// batch names the row (FJS-207), and a live single-row conflict reached the
// caller as SQLite's own sentence wrapped in a 500 — `UNIQUE constraint failed:
// product_variant.sku`.
//
// Three separate things were wrong with that. A 500 pages somebody, counts as
// an availability incident and is retried by clients that would not retry a
// 4xx, where nothing broke and the identical request fails identically until
// the caller sends a different value. It named no FIELD, so `toFieldErrors` had
// nothing to key on and a form rendered "the server broke" instead of marking
// the box. And it leaked the storage spelling — a physical table name is not
// the name the caller used, and a browser has no business learning it.
//
// `errors` rather than `data` is the channel, matching ValidationError: it is
// the one shape a form already reads, so the message lands under the control
// that caused it.
export class UniqueConflictError extends Error {
  // Normalised, not trusted — see SoftDeletedUniqueError. Values arrive already
  // redacted, because a @unique column may be @encrypted and only the caller's
  // own model knows which.
  constructor(model, fields, values, opts = {}) {
    fields = Array.isArray(fields) ? fields : fields == null ? [] : [fields]
    values = Array.isArray(values) ? values : values == null ? [] : [values]
    const pairs = fields.map((f, i) => (
      values[i] === undefined ? f : `${f} ${JSON.stringify(values[i])}`
    ))
    const taken = pairs.length === 0 ? 'a @unique value is already taken'
      : pairs.length === 1           ? `${pairs[0]} is already taken`
      : `${pairs.join(' + ')} is already taken — those values must be unique together`
    super(`${model}: ${taken}.`)
    this.name      = 'UniqueConflictError'
    this.model     = model
    this.fields    = fields
    this.values    = values
    // One entry per column, so a composite marks every box it is about. The
    // sentence under a control names the value rather than restating the
    // column, which the label beside it already says — EXCEPT on a composite,
    // where naming the value would be false: `"red" is already taken` under
    // `team` is untrue on its own, and the constraint is about the tuple.
    const each = fields.length > 1
      ? () => `this combination is already taken (${fields.join(' + ')})`
      : (i) => (values[i] === undefined ? 'is already taken'
                                        : `${JSON.stringify(values[i])} is already taken`)
    this.errors    = fields.map((f, i) => ({ path: [f], message: each(i) }))
    // A conflict with a row that is there, like the two above. Retrying sends
    // the same value at the same row and fails the same way.
    this.status    = 409
    this.retryable = false
    if (opts.constraint) this.constraintFields = opts.constraint
  }
}

// `UNIQUE constraint failed: doc.code` / `doc.team, doc.slot` → ['code'] /
// ['team','slot']. SQLite gives the only machine-readable account of WHICH
// constraint fired, and it is this string.
export function uniqueConflictColumns(err) {
  const m = /UNIQUE constraint failed:\s*(.+)$/m.exec(err?.message ?? '')
  if (!m) return null
  return m[1].split(',').map(s => s.trim().split('.').pop()).filter(Boolean)
}

// `CHECK constraint failed: qty > 0` → `qty > 0`. SQLite echoes the expression
// as this emitter wrote it, which is the only machine-readable account of WHICH
// check fired — the same position `UNIQUE constraint failed: doc.code` holds for
// the other constraint, and the same reason it is parsed rather than guessed.
export function checkViolationExpr(err) {
  const m = /CHECK constraint failed:\s*(.+)$/m.exec(err?.message ?? '')
  return m ? m[1].trim() : null
}

export function isCheckViolation(err) {
  return err?.code === 'SQLITE_CONSTRAINT_CHECK' ||
         !!(err?.message && err.message.includes('CHECK constraint failed'))
}

export function isUniqueConflict(err) {
  // The translated error answers yes too. Two paths depend on it after the
  // translation has happened — upsert's race fallback and the factory's
  // rebuild-and-retry — and both would stop recognising their own case if the
  // question were only ever asked of SQLite's wording.
  return err?.name === 'UniqueConflictError' ||
         err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.errno === 2067 ||
         !!(err?.message && err.message.includes('UNIQUE constraint failed'))
}

// ─── A capability the schema does not declare ────────────────────────────────
//
// Two failures with one cause: the caller asked this model for something its
// `.lite` never opted into. Both used to be answered wrongly and in opposite
// directions.
//
// A METHOD threw a bare Error, which `toFrameworkError` has no name entry for,
// so `?$search=widget` on a model with no @@fts came back 500 GeneralError —
// the server saying it broke about a request it understood perfectly. A 500 is
// paged, counted against availability and retried by clients that would not
// retry a 400.
//
// A FLAG was dropped in silence. `onlyDeleted` on a model with no @@softDelete
// answered the LIVE rows — not an empty list, the exact opposite of what was
// asked, with nothing anywhere saying the directive had not applied. A filter
// typo is a 400 by name and a sort key typo is a 400 by name; a directive the
// model cannot honour was the one that said nothing.
export class CapabilityNotDeclaredError extends Error {
  constructor(model, asked, requires, hint = '') {
    super(`${model}: ${asked} is not available — the model declares no ${requires}.${hint ? ` ${hint}` : ''}`)
    this.name       = 'CapabilityNotDeclaredError'
    this.model      = model
    this.asked      = asked
    this.requires   = requires
    // 400: the request named something this schema does not offer. Nothing is
    // broken and nothing is contended, so the identical request will fail the
    // identical way until the schema changes.
    this.status     = 400
    this.retryable  = false
  }
}

// ─── Lock error types ────────────────────────────────────────────────────────
//
// All three are 409, for the same reason the transition and version families
// are: the request conflicts with a state somebody else owns. They carried
// `retryable` and no `status`, so toFrameworkError fell through to its name
// branch, found no entry and answered GeneralError — a caller was told the
// server had broken about a lock another request was holding (FJS-255).
// `retryable` is the half a status cannot express and stays: 409 says what
// happened, `retryable` says whether doing it again is a strategy.

export class LockNotAcquiredError extends Error {
  constructor(key, currentOwner, expiresAt) {
    super(`Lock '${key}' is held by another owner and could not be acquired${currentOwner ? ` (held by: ${currentOwner})` : ''}`)
    this.name         = 'LockNotAcquiredError'
    this.key          = key
    this.currentOwner = currentOwner ?? null
    this.expiresAt    = expiresAt ?? null
    // Contention, not an outage: the resource exists and someone else has it.
    // 503 would say back off from the server; the caller has to back off from
    // this key, and `expiresAt` says for how long.
    this.status       = 409
    this.retryable    = true
  }
}

export class LockReleasedByOtherError extends Error {
  constructor(key, owner) {
    super(`Lock '${key}' was released or expired by another owner before explicit release`)
    this.name      = 'LockReleasedByOtherError'
    this.key       = key
    this.owner     = owner
    // The work is already done under a lock that is no longer this caller's.
    // Repeating the release cannot make it true again.
    this.status    = 409
    this.retryable = false
  }
}

export class LockExpiredError extends Error {
  constructor(key, owner) {
    super(`Lock '${key}' expired (TTL elapsed) before explicit release — increase TTL or add heartbeat`)
    this.name      = 'LockExpiredError'
    this.key       = key
    this.owner     = owner
    this.status    = 409
    this.retryable = false
  }
}

// ─── Closed client ───────────────────────────────────────────────────────────
//
// `$close()` used to leave a client that answered some calls and refused
// others. bun's `close()` is `sqlite3_close_v2`, which defers destruction until
// the last prepared statement is finalised, and `wrapDb` holds up to 500 of
// them — so a cached query kept reading off a closed, checkpointed handle while
// any query the cache had not seen threw. Same client, same tenant, and which
// answer you got depended on whether this request had taken this code path
// before (`FJS-640`).
//
// Finalising the cache is what makes a close a close, and this is what the
// caller gets afterwards. 500 rather than 4xx: nothing about the request is
// wrong, and repeating it cannot help.

export class ClientClosedError extends Error {
  constructor(where, hint = '') {
    super(`This Litestone client is closed (${where})${hint ? ` — ${hint}` : ''}`)
    this.name      = 'ClientClosedError'
    this.where     = where
    this.status    = 500
    this.retryable = false
  }
}

