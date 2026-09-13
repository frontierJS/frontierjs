// valuesets.js — a `@values` binding, enforced at the Data boundary.
//
// A value set is a NAME for a scoped list of rows (`FJS-D120`). The declaration
// says where a column's legal values come from; the binding on the field says
// how legal a value outside that list is:
//
//   required   refused
//   open       accepted, AND joined to the set — a row is created
//   suggested  accepted, the set is offered and nothing is enforced
//
// The check runs HERE rather than in `validate.js` because it is the one rule
// that needs a query, and it runs against `ctx.tables` — the sibling accessor at
// the CALLER'S OWN flavor. That is the whole of why `open` needs no permission
// concept of its own: the read is the caller's read, so a caller may only pick
// what they can see, and the create is the caller's create, so the source
// model's `@@gate` and `@@allow` answer who may extend the set. A check written
// against `asSystem()` would have offered every row to everybody and let any
// caller grow a shared list.
//
// A `suggested` binding issues NO query at all. Enforcing nothing has to cost
// nothing, or nobody uses the strength that keeps the list traveling.

import { ValidationError } from './validate.js'
import { modelToAccessor } from './ddl.js'

/**
 * A value could not join an `open` set — the source model refused the row.
 *
 * Its own `status` and `retryable` are the source error's: a policy refusal is
 * a 403 whether it arrives here or directly, and a validation failure is a 400.
 * Nothing about being reached through a value set changes what went wrong, only
 * what has to be SAID about it.
 */
export class ValueSetExtendError extends Error {
  constructor(bind, value, cause) {
    super(`Could not add ${JSON.stringify(value)} to ${bind.set}: creating a ${bind.source} ` +
          `for it failed — ${cause?.message ?? cause}`)
    this.name       = 'ValueSetExtendError'
    this.cause      = cause
    this.status     = cause?.status ?? cause?.statusCode ?? 400
    this.retryable  = cause?.retryable ?? false
    this.data       = { set: bind.set, model: bind.source, field: bind.field, value }
  }
}

// ─── the map ──────────────────────────────────────────────────────────────────

/**
 * modelName → the bindings its columns carry, resolved against the sets.
 *
 * Built once at client construction. A model with none is absent, so the check
 * is a map lookup for every schema that does not use the feature.
 */
export function buildValueSetMap(schema) {
  const sets = new Map((schema.valuesets ?? []).map(v => [v.name, v]))
  if (!sets.size) return {}

  const out = {}
  for (const model of schema.models) {
    const binds = []
    for (const field of model.fields) {
      const bind = field.attributes?.find(a => a.kind === 'values')
      if (!bind) continue
      const vs = sets.get(bind.set)
      if (!vs) continue                       // the parser already said so

      binds.push({
        field:      field.name,
        isArray:    !!field.type.array,
        strength:   bind.strength,
        set:        vs.name,
        accessor:   modelToAccessor(vs.source),
        source:     vs.source,
        valueField: vs.valueField,
        labelField: vs.labelField,
        // Names, never predicates. A declared `where` minted a scope of its
        // own at parse, so one mechanism narrows the read here and the read a
        // picker makes — rather than a `$scope` on one side and a `$raw` the
        // browser cannot express on the other.
        scopes:     vs.scopes ?? [],
        // The dependency, resolved at parse: which column of THIS model narrows
        // the list, and which column of the SOURCE it is matched against
        // (derived from the relation path — `FJS-D122`).
        dependsOn:  bind.dependsOn ?? null,
        matchField: bind.dependsOnField ?? null,
      })
    }
    if (binds.length) out[model.name] = binds
  }
  return out
}

// ─── the check ────────────────────────────────────────────────────────────────

/** Every value this payload offers for one binding, flattened and deduped. */
function offered(rows, bind) {
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    // Absent and null are the same non-answer here: one says nothing about the
    // column, the other clears it. Neither is a value to look for in a set, and
    // whether the column may be empty at all is what `?` already says.
    const v = row[bind.field]
    if (v == null) continue
    for (const one of (bind.isArray ? (Array.isArray(v) ? v : [v]) : [v]))
      if (one != null) seen.add(one)
  }
  return [...seen]
}

/** The narrowing every read of a set applies, as declared scope names. */
function setFilter(bind, values) {
  return {
    [bind.valueField]: { in: values },
    ...(bind.scopes.length ? { $scope: bind.scopes } : {}),
  }
}

/**
 * Refuse, or grow the set, before the write.
 *
 * `rows` is always an array so that one implementation covers `create` and
 * `createMany` alike — the six write paths that carry a payload reach this, and
 * a forgotten one would be silent, which is what `test/valuesets.test.ts`
 * § every write path walks.
 *
 * Throws `ValidationError` with one entry per offending field, the same shape
 * every other rule throws, so a refusal renders in `<Form>` beside the control
 * rather than as a bare 500.
 *
 * Answers undefined, not a promise, for a model binding no set — which is every
 * write to most models, and an async function allocates its promise before its
 * first line runs (`FJS-1108`).
 */
export function enforceValueSets(modelName, rows, ctx, opts) {
  if (!ctx.valueSetMap?.[modelName]?.length) return
  return enforceBoundValueSets(modelName, rows, ctx, opts)
}

async function enforceBoundValueSets(modelName, rows, ctx, { where = null } = {}) {
  const binds = ctx.valueSetMap[modelName]

  const list   = Array.isArray(rows) ? rows : [rows]
  const errors = []

  for (const bind of binds) {
    if (bind.strength === 'suggested') continue

    if (bind.dependsOn) {
      await enforceDependent(modelName, bind, list, ctx, where, errors)
      continue
    }

    const values = offered(list, bind)
    if (!values.length) continue

    const table = ctx.tables?.[bind.accessor]
    if (!table) continue                      // unreachable for a validated schema

    const found = await table.findMany({
      where:  setFilter(bind, values),
      select: { [bind.valueField]: true },
    })
    const have    = new Set(found.map(r => r[bind.valueField]))
    const missing = values.filter(v => !have.has(v))
    if (!missing.length) continue

    if (bind.strength === 'required') {
      errors.push({
        path:    [bind.field],
        message: missing.length === 1
          ? `${missing[0]} is not in ${bind.set}`
          : `${missing.join(', ')} are not in ${bind.set}`,
      })
      continue
    }

    // A value MISSING from a narrowed set is two different things and only one
    // of them may be added: `Ochre` that nobody has ever run, and `Ochre` that
    // the shop has retired. Creating the second one hits the source's own
    // `@unique` and reports SQLite's sentence — `UNIQUE constraint failed` —
    // which says the opposite of what happened, and says it about a table the
    // caller did not name. Asked unnarrowed, so the two are told apart before
    // anything is written.
    //
    // Still the caller's own read: a row they cannot see is not one they can be
    // told about, so it falls through to the create and its refusal.
    if (bind.scopes.length) {
      const exists = await table.findMany({
        where:  { [bind.valueField]: { in: missing } },
        select: { [bind.valueField]: true },
      })
      if (exists.length) {
        const names = exists.map(r => r[bind.valueField])
        errors.push({
          path:    [bind.field],
          message: names.length === 1
            ? `${names[0]} is in ${bind.source} but is not offered by ${bind.set}`
            : `${names.join(', ')} are in ${bind.source} but are not offered by ${bind.set}`,
        })
        // Nothing is created: this write is refused, and growing a shared list
        // as a side effect of a refused write is worse than the refusal.
        continue
      }
    }

    // open — the value joins the set. Through the caller's own accessor, so the
    // source model's gate and policies decide whether they may, and a refusal
    // arrives as that model's own error rather than as a silent skip.
    //
    // Wrapped, because the row being created is one the caller never asked for.
    // A bare `ownerId is required` off a Task write names a column on a model
    // the caller did not mention, and reads as a bug in the app. The cause has
    // to travel with it.
    for (const value of missing) {
      try {
        await table.create({
          data: {
            [bind.valueField]: value,
            ...(bind.labelField && bind.labelField !== bind.valueField ? { [bind.labelField]: value } : {}),
          },
          select: false,
        })
      } catch (err) {
        throw new ValueSetExtendError(bind, value, err)
      }
    }
  }

  if (errors.length) throw new ValidationError(errors)
}

// ─── a dependent set ──────────────────────────────────────────────────────────

/**
 * Grade (value, controlling value) PAIRS against the row as it will be.
 *
 * A dependent binding is a join: `stateId` is legal only among the states of
 * this row's `countryId` (`FJS-D122`). Two things follow and the second is the
 * one that is easy to miss.
 *
 * **The pair is graded in BOTH directions.** A payload naming only `stateId`
 * needs the stored `countryId` to grade it — and a payload naming only
 * `countryId` needs the stored `stateId`, because moving the controller is what
 * makes an already-stored value illegal. Grading one direction leaves the other
 * as the way to write the invalid row.
 *
 * **A create pays nothing extra.** Both columns are in the payload, so the only
 * read is the one the plain check already makes, with one more column selected.
 * The stored row is fetched only when a write names one half and not the other.
 *
 * The read is through the caller's own accessor, like every other read here: a
 * row they cannot see is not a row they can be told about.
 */
async function enforceDependent(modelName, bind, list, ctx, where, errors) {
  const table = ctx.tables?.[bind.accessor]
  const own   = ctx.tables?.[modelToAccessor(modelName)]
  if (!table) return

  // What this write says about each half.
  const names   = list.some(r => r && typeof r === 'object' && bind.field in r)
  const namesCtl = list.some(r => r && typeof r === 'object' && bind.dependsOn in r)
  if (!names && !namesCtl) return

  // The pairs to grade, as [value, controllingValue].
  const pairs = []
  if (names && namesCtl) {
    for (const row of list) {
      const v = row?.[bind.field]
      if (v == null) continue
      pairs.push([v, row?.[bind.dependsOn] ?? null])
    }
  } else if (where && own) {
    // One half came off the payload and the other has to come from the rows
    // this write is about. Distinct pairs only — a bulk update over a thousand
    // rows in three countries is three questions.
    const stored = await own.findMany({
      where,
      select: { [bind.field]: true, [bind.dependsOn]: true },
    })
    const seen = new Set()
    for (const row of stored) {
      const v   = names   ? list.find(r => r?.[bind.field] != null)?.[bind.field] : row[bind.field]
      const ctl = namesCtl ? list.find(r => r?.[bind.dependsOn] !== undefined)?.[bind.dependsOn] : row[bind.dependsOn]
      if (v == null) continue
      const key = `${v}\u0000${ctl}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push([v, ctl ?? null])
    }
  } else {
    // A create-shaped write naming only the dependent column: the row as it
    // will be has nothing in the controlling column, so there is no list.
    for (const row of list) {
      const v = row?.[bind.field]
      if (v != null) pairs.push([v, null])
    }
  }
  if (!pairs.length) return

  const values = [...new Set(pairs.map(([v]) => v))]
  const found  = await table.findMany({
    where:  setFilter(bind, values),
    select: { [bind.valueField]: true, [bind.matchField]: true },
  })

  // One value can legitimately exist under several controllers — `CA` is a
  // state of two countries — so the answer is a SET per value, never one row.
  const legal = new Map()
  for (const row of found) {
    const v = row[bind.valueField]
    if (!legal.has(v)) legal.set(v, new Set())
    legal.get(v).add(row[bind.matchField])
  }

  const missing = []
  for (const [value, ctl] of pairs) {
    const under = legal.get(value)
    if (under?.has(ctl)) continue
    if (ctl == null) {
      errors.push({ path: [bind.field], message:
        `${bind.field} was given and ${bind.dependsOn} is empty, so which ${bind.set} it must come from is ` +
        `unknown. Set ${bind.dependsOn} in the same write.` })
      continue
    }
    if (under) {
      errors.push({ path: [bind.field], message:
        `${value} is in ${bind.set} but not for ${bind.dependsOn} ${JSON.stringify(ctl)}` })
      continue
    }
    if (bind.strength === 'required') {
      errors.push({ path: [bind.field], message: `${value} is not in ${bind.set}` })
      continue
    }
    missing.push([value, ctl])
  }

  // open — the value joins the set, STAMPED with the controller it was offered
  // under. Without the stamp the row lands outside the list that was just
  // narrowed, and the next read does not offer the value that was just added.
  for (const [value, ctl] of missing) {
    try {
      await table.create({
        data: {
          [bind.valueField]: value,
          [bind.matchField]: ctl,
          ...(bind.labelField && bind.labelField !== bind.valueField ? { [bind.labelField]: value } : {}),
        },
        select: false,
      })
    } catch (err) {
      throw new ValueSetExtendError(bind, value, err)
    }
  }
}
