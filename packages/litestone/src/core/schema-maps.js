// schema-maps.js — the schema read once, into the maps the client runs on
//
// Every function here is (schema) -> a plain Map/Set/object. No connection, no
// principal, no context: these are what the DECLARATION says, derived once when
// the client is built and identical for every flavor of it. `makeTable` then
// reads them per model, which is why `shape` and `ctx` are separate arguments
// there — this file is where `shape` comes from.
//
// That purity is the property worth keeping. A pass that needs a row, a caller
// or a database is not one of these, and putting one here would make the whole
// set unsafe to memoise at build time.
//
// Three doc blocks in here had drifted away from the function they describe —
// something was inserted between them — so each is reunited with its own pass.

import { inferFromFk }                                             from './parser.js'
import { isSoftDelete, modelToTableName, isUpdatedAtField, detectM2MPairs, sqlType } from './ddl.js'
import { assertNoBareClock, expandNowTokens }                      from './query.js'
import { compileDerived, checkDerivedType, dependsOnClock }        from './policy.js'
import { ID_GENERATORS, GENERATED_DEFAULTS }                       from './ids.js'


// ─── Schema analysis ──────────────────────────────────────────────────────────


// ─── Auto-ID map ──────────────────────────────────────────────────────────────
// Detects @id fields with @default(uuid()), @default(ulid()), @default(cuid())
// or @default(nanoid()). When the id field is missing from create data, the
// client generates it. The generators themselves are core/ids.js — the jsonl
// driver fills the same defaults and cannot import this file.

export function buildAutoIdMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const isId  = field.attributes.find(a => a.kind === 'id')
      const def   = field.attributes.find(a => a.kind === 'default')
      if (!isId || !def || def.value?.kind !== 'call') continue
      const fn = def.value.fn
      if (ID_GENERATORS[fn]) {
        map[model.name] = { field: field.name, generate: ID_GENERATORS[fn] }
      }
    }
  }
  return map
}

// ─── Generated-default map ────────────────────────────────────────────────────
// { modelName: [{ field, generate }] } — the same generators for a field that is
// NOT the id.
//
// `uuid()` is absent on purpose: it is the one kind ddl.js can express as a SQL
// DEFAULT, so SQLite fills it. The other three emit no DDL default, so a
// required column declaring one could not be inserted at all — the insert
// reached SQLite with the column missing and failed NOT NULL (FJS-423).
//
// `now()` IS here, and it is the exception that proves the rule: ddl.js can
// express it and does, and the column DEFAULT stays as the floor for a raw
// INSERT. What it cannot do is read the client's clock, so a create that omits
// the column is stamped here instead — otherwise a frozen clock stamps a fresh
// row with today (`FJS-531`). `@updatedAt` is stamped for the same reason and
// is a THIRD mechanism: on create it is neither the trigger nor a `@default`,
// it is an implied column DEFAULT that ddl.js writes from the attribute.
//
// Key PRESENCE decides, not `== null`: a stated null is a caller asking for
// null, which is what a SQL DEFAULT does too, so a nullable `@default(cuid())`
// answers the same as a nullable `@default(uuid())` either way. The id path
// above differs on purpose — an id is never legitimately null.
export function buildGeneratedDefaultMap(schema, now) {
  const map = {}
  for (const model of schema.models) {
    const entries = []
    for (const field of model.fields) {
      if (field.attributes.some(a => a.kind === 'id')) continue
      // The stamp columns, by the same rule ddl.js uses — the ATTRIBUTE, or the
      // name `updatedAt` on a DateTime. Reading only the attribute would leave a
      // column named for the job unstamped now that no trigger covers it.
      if (isUpdatedAtField(field)) {
        entries.push({ field: field.name, generate: () => nowISO(now) })
        continue
      }
      const def = field.attributes.find(a => a.kind === 'default')
      if (def?.value?.kind !== 'call') continue
      const generate = def.value.fn === 'now'
        ? () => nowISO(now)
        : GENERATED_DEFAULTS[def.value.fn]
      if (generate) entries.push({ field: field.name, generate })
    }
    if (entries.length) map[model.name] = entries
  }
  return map
}

// ─── Auth default map ────────────────────────────────────────────────────────
// { modelName: [{ field, authField }] }
// For fields with @default(auth().someField) — value stamped from ctx.auth at create time.
// These are runtime-only; no SQL DEFAULT expression is emitted in DDL.

export function buildAuthDefaultMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const def = field.attributes.find(a => a.kind === 'default')
      if (def?.value?.kind !== 'call' || def.value.fn !== 'auth') continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, authField: def.value.field })
    }
  }
  return map
}

// ─── Self-relation map ────────────────────────────────────────────────────────
// { modelName: [{ relationField, fkField, referencedField }] }
// Detects self-referential relations for recursive CTE queries.
// e.g. categories.children → parentId → id

export function buildSelfRelationMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const selfRels = []
    for (const field of model.fields) {
      if (field.type.kind !== 'relation') continue
      if (field.type.name !== model.name) continue
      const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
      if (!rel) continue  // hasMany side — skip, we want the belongsTo (FK) side
      selfRels.push({
        relationField:   field.name,
        fkField:         Array.isArray(rel.fields)     ? rel.fields[0]     : rel.fields,
        referencedField: Array.isArray(rel.references) ? rel.references[0] : rel.references,
      })
    }
    if (selfRels.length) map[model.name] = selfRels
  }
  return map
}

// ─── @default(fieldName) — field reference defaults ──────────────────────────
// { modelName: [{ field, sourceField }] }
// On create, if `field` is absent from data, copy value from `sourceField`.
// Applied BEFORE @slug and other transforms so @default(title) @slug works.

export function buildFieldRefDefaultMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const fieldNames = new Set(model.fields.map(f => f.name))
    for (const field of model.fields) {
      const def = field.attributes.find(a => a.kind === 'default')
      if (def?.value?.kind !== 'fieldRef') continue
      const sourceField = def.value.field
      if (!fieldNames.has(sourceField)) continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, sourceField })
    }
  }
  return map
}

// ─── @updatedBy map ───────────────────────────────────────────────────────────
// { modelName: [{ field, authField }] }
// @updatedBy          → stamps ctx.auth.id on every update
// @updatedBy(auth().field) → stamps ctx.auth[field] on every update
// Skipped silently if ctx.auth is null.

export function buildUpdatedByMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const attr = field.attributes.find(a => a.kind === 'updatedBy')
      if (!attr) continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, authField: attr.authField ?? 'id' })
    }
  }
  return map
}

// ─── @version map ─────────────────────────────────────────────────────────────
// { modelName: fieldName } — at most one per model, enforced in the parser.

export function buildVersionMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const field = model.fields.find(f => f.attributes.some(a => a.kind === 'version'))
    if (field) map[model.name] = field.name
  }
  return map
}

export function buildCreatedByMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const attr = field.attributes.find(a => a.kind === 'createdBy')
      if (!attr) continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, authField: attr.authField ?? 'id' })
    }
  }
  return map
}
// { modelName: [{ field, scope }] }
// field: the field that gets the auto-incremented value
// scope: the field whose value defines the partition (e.g. accountId)
//
// Example: quoteNumber @sequence(scope: accountId)
//   → { quotes: [{ field: 'quoteNumber', scope: 'accountId' }] }

export function buildSequenceMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const seqs = []
    for (const field of model.fields) {
      const attr = field.attributes.find(a => a.kind === 'sequence')
      if (attr) seqs.push({ field: field.name, scope: attr.scope })
    }
    if (seqs.length) map[model.name] = seqs
  }
  return map
}
// ─── Does this schema declare anything raw SQL would bypass? ─────────────────
//
// FJS-005. `sql` goes straight to the read connection: no @@gate, no @@allow,
// no @guarded, no @scoped, no @@softDelete. For a deliberate escape hatch that
// is defensible. What was not defensible is that it was the SAME function on
// every proxy — `db.$setAuth(user).sql` closed over the user and never read it,
// so a caller who had done everything right got every row in the table.
//
// Measured on one model with @@allow + @guarded + @@softDelete:
//
//   $setAuth({id:1}).invoice.findMany()   → 1 row,  ssn absent
//   $setAuth({id:1}).sql`SELECT * ...`    → 3 rows, ssn in plaintext, incl.
//                                            another owner's and a deleted one
//
// The unscoped client is the wider gap, not the narrower one: an unauthenticated
// `db.invoice.findMany()` returns **0** rows, because the policy evaluates with
// auth() == null and matches nothing, while `db.sql` returns all 3. So this is
// not "the scoped proxy drops its scope" — it is that `sql` ignores the schema
// on every path and the ORM never does.
//
// The rule: when a schema declares access rules, raw SQL is available through
// asSystem() only. Coarse on purpose — deciding per statement means parsing the
// statement, and a hand-written SQL validator that is subtly wrong grants a
// FALSE guarantee, which is worse than an honest raw hatch. (SQLite's own
// authorizer would be the right mechanism; bun:sqlite does not expose it.)
//
// Scoped raw SQL as a real capability — a per-identity view set — is designed in
// IDEAS/scoped-sql.md and deliberately not built: it is a feature, this is the
// defect, and the consumer that made it urgent does not exist yet.

/** Model-level attributes the ORM enforces and raw SQL does not. */
const ACCESS_MODEL_ATTRS = new Set(['gate', 'allow', 'deny'])

/**
 * Field-level ones. `@omit` and `@@softDelete` are deliberately NOT here: they
 * shape what a read returns rather than who may read it, and refusing raw SQL
 * for a soft-delete column would fire on most schemas for a lifecycle rule
 * rather than an access one.
 */
const ACCESS_FIELD_ATTRS = new Set(['guarded', 'encrypted', 'secret', 'fieldAllow', 'scoped', 'system'])

export function schemaDeclaresAccessRules(schema) {
  for (const model of schema.models ?? []) {
    if ((model.attributes ?? []).some(a => ACCESS_MODEL_ATTRS.has(a.kind))) return true
    for (const field of model.fields ?? [])
      if ((field.attributes ?? []).some(a => ACCESS_FIELD_ATTRS.has(a.kind))) return true
  }
  return false
}
// ─── Field policy map ─────────────────────────────────────────────────────────
// Per model, per field:
//   omit:      'lists' | 'all' | null
//   guarded:   'select' | 'all' | null   — DECLARED @guarded/@secret only
//   encrypted: { deterministic: bool } | null
//   hashed:    bool
//
// `guarded` is a system-context lock in BOTH directions: the read strips it and
// writeData refuses it. That is why @encrypted no longer sets it. @encrypted
// hides a value from a non-system reader too — applyFieldPolicyTo tests it on
// its own branch — but the caller who supplies a secret is routinely not the
// system, and folding it in here made every @encrypted column system-write-only.

export function buildFieldPolicyMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = {}
    for (const field of model.fields) {
      const omitAttr      = field.attributes.find(a => a.kind === 'omit')
      const guardedAttr   = field.attributes.find(a => a.kind === 'guarded')
      const encryptedAttr = field.attributes.find(a => a.kind === 'encrypted')
      const hashedAttr    = field.attributes.find(a => a.kind === 'hashed')
      const systemAttr    = field.attributes.find(a => a.kind === 'system')
      const immutableAttr = field.attributes.find(a => a.kind === 'immutable')
      const fieldAllows   = field.attributes.filter(a => a.kind === 'fieldAllow')

      if (!omitAttr && !guardedAttr && !encryptedAttr && !hashedAttr && !systemAttr && !immutableAttr && !fieldAllows.length) continue

      // Build per-op allow expression lists: { read: [expr,...], write: [expr,...] }
      const allow = fieldAllows.length ? { read: [], write: [] } : null
      for (const fa of fieldAllows) {
        if (fa.operations.includes('read'))  allow.read.push(fa.expr)
        if (fa.operations.includes('write')) allow.write.push(fa.expr)
      }

      map[model.name][field.name] = {
        omit:      omitAttr?.level    ?? null,
        guarded:   guardedAttr?.level ?? null,
        encrypted: encryptedAttr ? { deterministic: encryptedAttr.deterministic ?? false } : null,
        // @hashed is not a flavor of encrypted — no ciphertext, no decrypt, and it
        // strips from asSystem() too, which no other protection does.
        hashed:    !!hashedAttr,
        // @system — readable by anyone, writable only by the system. The
        // orthogonal sibling of @guarded, which locks both directions.
        system:    !!systemAttr,
        // @immutable — written once, at create. Unlike every other entry here
        // it is not about WHO is asking, which is why the write path tests it
        // outside the `!ctx.isSystem` guard the others share.
        immutable: !!immutableAttr,
        allow,    // null if no @allow on this field
        // Whether the DECLARED type is Json. Captured here, beside the other
        // per-field facts, because the encrypt/decrypt steps both need it and
        // neither has the schema in scope. Without it `@encrypted` on a Json
        // field silently destroyed the value: encryptField does
        // String(plaintext), an object stringifies to '[object Object]', and
        // what got encrypted was a faithful ciphertext of that — unrecoverable,
        // with nothing thrown.
        json:      field.type?.name === 'Json',
      }
    }
  }
  return map
}

// ─── Secret map ───────────────────────────────────────────────────────────────
// Tracks @secret fields for key rotation.  Only fields with rotate:true
// are re-encrypted when db.$rotateKey(newKey) is called.

export function buildSecretMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const secretAttr = field.attributes.find(a => a.kind === 'secret')
      if (!secretAttr) continue
      if (!map[model.name]) map[model.name] = {}
      map[model.name][field.name] = { rotate: secretAttr.rotate !== false }
    }
  }
  return map
}

export function buildJsonMap(schema) {  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      // Include Json fields AND array fields — both stored as JSON text.
      // Exclude @edge fields — they live on a join/side table, not the host row.
      model.fields.filter(f => (f.type.name === 'Json' || f.type.array) && !f.attributes.find(a => a.kind === 'edge')).map(f => f.name)
    )
  }
  return map
}

export function buildGeneratedMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      model.fields
        .filter(f => f.attributes.find(a => a.kind === 'generated' || a.kind === 'funcCall'))
        .map(f => f.name)
    )
  }
  return map
}

// ─── @from map ───────────────────────────────────────────────────────────────
// { modelName: { fieldName: { subquerySql, subquerySqlAliased, isObject } } }
// subquerySql: the correlated subquery string to inject into SELECT
// isObject: true for last/first (returns JSON-encoded row), false for scalars
//
// FK inference lives in the parser as inferFromFk() — the same call validate()
// makes, so a schema that parses always produces a subquery here.
//
// TWO variants of every subquery, because the correlation names the outer table
// and a relation orderBy aliases that table to `t`. With one variant the query
// either dropped the field silently or died on `no such column: <table>.<pk>`,
// depending on whether the caller had named the field in `select`.

// ─── @derived rides this map ─────────────────────────────────────────────────
//
// A derived field is the same KIND of thing as an `@from`: a virtual column
// carried in the SELECT, filterable and sortable through the same
// `_fromExprMap`, stripped from writes by the same `stripVirtual`. So it is
// built into the same map rather than beside it — which is the whole reason it
// reaches all six SELECT-building sites, the WHERE substitution and the ORDER BY
// without any new plumbing. A seventh site that forgot it would be silent, the
// way a forgotten `@from` is.
//
// It carries no parameters: the expression is compiled once at startup, and
// `now()` becomes SQLite's own clock, which SQLite fixes for the duration of a
// statement. That is what keeps `subquerySql` a static string like the rest.
export function addDerivedFields(map, model, schema) {
  const derived = model.fields.filter(f => f.attributes.find(a => a.kind === 'derived'))
  if (!derived.length) return
  map[model.name] ??= {}
  for (const field of derived) {
    const attr = field.attributes.find(a => a.kind === 'derived')
    checkDerivedType(model, schema, field, attr.expr)
    const sql  = `(${compileDerived(model, field.name, attr.expr)})`
    map[model.name][field.name] = {
      subquerySql:        sql,
      subquerySqlAliased: sql.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, 't."$1"'),
      isObject: false,
      isBool:   field.type?.name === 'Boolean',
      derived:  true,
      clock:    dependsOnClock(attr.expr),
    }
  }
}

export function buildFromMap(schema, pluralize = false) {
  const map = {}
  for (const model of schema.models) {
    addDerivedFields(map, model, schema)
    const fromFields = model.fields.filter(f => f.attributes.find(a => a.kind === 'from'))
    if (!fromFields.length) continue
    map[model.name] ??= {}

    // Outer table — model.name is PascalCase, SQL uses the derived table name.
    const selfTable = modelToTableName(model, pluralize)

    for (const field of fromFields) {
      const attr = field.attributes.find(a => a.kind === 'from')
      const { target, op, opValue, where, orderBy, via, withDeleted, withTemplates } = attr

      const targetModel = schema.models.find(m => m.name === target)
      if (!targetModel) continue
      const targetTable = modelToTableName(targetModel, pluralize)

      // FK column on the target table + the column it references on THIS model.
      const fk = inferFromFk(model, targetModel, via)
      // Unreachable for a validated schema — validate() refuses an @from with
      // no relation behind it, an ambiguous one, and a via naming nothing.
      if (!fk || fk.ambiguous || fk.unresolvedVia) continue
      const { fkCols, refCols } = fk
      const idField = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'

      // The target model's own defaults apply, the same ones a direct read or an
      // include gets. Without this a @from counted rows the app had deleted, and
      // every schema had to repeat `where: "deletedAt IS NULL"` by hand — which
      // is a default nobody remembers to write on the second model.
      const targetSoftDelete = !!targetModel.attributes.find(a => a.kind === 'softDelete')
      const targetHtField    = targetModel.attributes.find(a => a.kind === 'hasTemplates')?.field ?? null

      // `%SELF%` is substituted per variant below — it is the only part of the
      // subquery that has to know what the outer table is called in this query.
      //
      // The target is aliased because a self-referential @from correlates a
      // table to itself: unaliased, `"task"."id"` inside the subquery binds to
      // the subquery's OWN task, so `@from(Task, count: true)` counted rows
      // whose FK equalled their own id — none — and answered 0 for every row.
      // Aliased once here rather than only when the names collide: a rule that
      // holds conditionally is a rule with two implementations.
      //
      // Every @from subquery uses the SAME alias, and that is safe only while a
      // correlation names `%SELF%` — the outer table, or `t` under a relation
      // orderBy — and never `_from`. Two subqueries side by side are separate
      // scopes; one nested in another shadows the name harmlessly because the
      // inner never has to reach the outer's alias. Correlate via `_from` and
      // this becomes a silent wrong answer again.
      // Every key column, AND-joined. A composite correlated on its first
      // column alone is a count of every row sharing that column — 8, 8, 7
      // where the truth was 3, 5, 7, measured, and nothing to say so.
      const whereParts = fkCols.map((c, i) => `_from."${c}" = %SELF%."${refCols[i]}"`)
      if (targetSoftDelete && !withDeleted)   whereParts.push(`_from."deletedAt" IS NULL`)
      if (targetHtField    && !withTemplates) whereParts.push(`_from."${targetHtField}" = 0`)
      // A @from's `where:` is a raw SQL string in the schema, so the clock trap
      // reaches it too — and refused HERE it is refused at startup, on the
      // schema, rather than on a query nobody ran yet.
      if (where) assertNoBareClock(where, `@from(${target}, where: …) on ${model.name}.${field.name}`)
      if (where) whereParts.push(`(${expandNowTokens(where)})`)
      const whereClause = whereParts.join(' AND ')

      let subquerySql, isObject = false, rowRef = null

      switch (op) {
        case 'last':
        case 'first': {
          // Resolve the row's ID here and fetch the row itself through a real
          // read of the target (resolveFromRowRefs). Encoding it as a
          // json_object of the target's columns meant this was the one @from
          // shape that returned a row without read() ever seeing it: the
          // target's @computed and @from fields were absent and its @guarded,
          // @omit and @encrypted ones were present, in plaintext or ciphertext.
          // Those protections live in read(), and hand-built JSON never reaches
          // it. Same shape as the recursive walk: ids in SQL, rows through the
          // ordinary path.
          const targetPk = targetModel.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
          // Ordering is over the TARGET, so the default is the target's own id
          // column — `idField` here is the declaring model's, which is the same
          // name often enough to hide the difference.
          const orderField = orderBy ?? targetPk
          const dir = op === 'last' ? 'DESC' : 'ASC'
          subquerySql = `(SELECT _from."${targetPk}" FROM "${targetTable}" AS _from WHERE ${whereClause} ORDER BY _from."${orderField}" ${dir} LIMIT 1)`
          // Everything the pick needs, so it can be REDONE under the caller's
          // row policy — see resolveFromRowRefs. The parts carry `%T%` rather
          // than the `_from` alias above, because the repick cannot alias the
          // table: a policy compiles `check(parent)` against the table's own
          // name and an alias puts it out of scope.
          rowRef = {
            model: targetModel.name, pk: targetPk,
            fkCols, refCols, orderField, dir,
            extra: [
              ...(targetSoftDelete && !withDeleted ? [`%T%."deletedAt" IS NULL`] : []),
              ...(targetHtField    && !withTemplates ? [`%T%."${targetHtField}" = 0`] : []),
              ...(where ? [`(${where})`] : []),
            ],
          }
          break
        }
        case 'count':
          subquerySql = `(SELECT COUNT(*) FROM "${targetTable}" AS _from WHERE ${whereClause})`
          break
        case 'sum':
          subquerySql = `(SELECT COALESCE(SUM(_from."${opValue}"), 0) FROM "${targetTable}" AS _from WHERE ${whereClause})`
          break
        case 'max':
          subquerySql = `(SELECT MAX(_from."${opValue}") FROM "${targetTable}" AS _from WHERE ${whereClause})`
          break
        case 'min':
          subquerySql = `(SELECT MIN(_from."${opValue}") FROM "${targetTable}" AS _from WHERE ${whereClause})`
          break
        case 'exists':
          subquerySql = `(SELECT EXISTS(SELECT 1 FROM "${targetTable}" AS _from WHERE ${whereClause}))`
          break
      }

      map[model.name][field.name] = {
        subquerySql:        subquerySql.replaceAll('%SELF%', `"${selfTable}"`),
        subquerySqlAliased: subquerySql.replaceAll('%SELF%', 't'),
        isObject,
        isBool: op === 'exists',
        rowRef,
      }
    }
  }
  return map
}

export function buildComputedSet(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      model.fields.filter(f => f.attributes.find(a => a.kind === 'computed')).map(f => f.name)
    )
  }
  return map
}


// ─── Big map ──────────────────────────────────────────────────────────────────
// { modelName: Set<fieldName> } — the columns declared `@big`, whose values use
// the whole 64 bits and therefore cross as decimal STRINGS rather than as JS
// numbers (`FJS-643`).
//
// Two readers and they need different keys. The row read is per MODEL, like
// every other shape pass. The statement side is per TABLE: `safeIntegers` is a
// property of a prepared statement, so what has to be decided is *does this SQL
// touch a wide table*, and the SQL carries the table name.
export function buildBigMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const wide = model.fields.filter(f => f.attributes.some(a => a.kind === 'big')).map(f => f.name)
    if (wide.length) map[model.name] = new Set(wide)
  }
  return map
}

// ─── Affinity map ─────────────────────────────────────────────────────────────
// { modelName: { fieldName: 'NUMERIC' | 'TEXT' | 'BLOB' } }
//
// Which affinity SQLite applies to the OTHER operand when this column is
// compared. The JS policy evaluator needs it to answer a comparison the way the
// WHERE does, and `$readAs` runs it once per broadcast cohort — a scan of the
// model list there is 188 string compares per operand on the scale fixture.
//
// Derived through `sqlType`, so it cannot drift from the column the DDL emits.
export function buildAffinityMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const cols = {}
    for (const f of model.fields) {
      if (!f.type) continue
      const t = sqlType(f.type)
      cols[f.name] = t === 'INTEGER' || t === 'REAL' ? 'NUMERIC' : t === 'BLOB' ? 'BLOB' : 'TEXT'
    }
    map[model.name] = cols
  }
  return map
}

export function buildBoolMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      model.fields.filter(f => f.type.name === 'Boolean').map(f => f.name)
    )
  }
  return map
}


// ─── Filter kind map ──────────────────────────────────────────────────────────
// { modelName: Map<fieldName, 'array' | 'json' | 'file' | 'boolean'> }
//
// What a column HOLDS — the fact `buildWhere` cannot read off the operand, and
// which two of its questions need. Whether a bare array means `IN` or `hasSome`
// (`{ id: [1,2] }` and `{ tags: ['x','y'] }` are the same shape and different
// SQL), and whether a string operator can ask this column anything at all: a
// serialization answers about its own punctuation and a Boolean is 0/1, so both
// answer plausibly and wrongly rather than failing (`FJS-210`).
//
// Anything absent is a plain scalar. Int and DateTime are deliberately absent —
// SQLite's coercion answers what was asked there.
export function buildFilterKindMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const kinds = new Map()
    for (const f of model.fields) {
      if (f.type.kind === 'relation' || f.type.kind === 'implicitM2M') continue
      if (f.type.array)                   kinds.set(f.name, 'array')
      else if (f.type.name === 'Json')    kinds.set(f.name, 'json')
      else if (f.type.name === 'File')    kinds.set(f.name, 'file')
      else if (f.type.name === 'Boolean') kinds.set(f.name, 'boolean')
    }
    map[model.name] = kinds
  }
  return map
}


// ─── Enum map ─────────────────────────────────────────────────────────────────
// { modelName: { fieldName: Set<string> } }
// Used for friendly validation before writes hit SQLite's CHECK constraint.

// ─── Transition map ───────────────────────────────────────────────────────────
// { modelName: { fieldName: { enumName, transitions: { name: { from, to, gate } } } } }
//
// Reads @@transitions model attributes only. The `enum X { transitions { ... } }`
// shorthand was already desugared into those attributes by resolveTransitions()
// in the parser, so there is exactly one representation to enforce against.

export function buildTransitionMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const attr of model.attributes ?? []) {
      if (attr.kind !== 'transitions') continue
      const field = model.fields.find(f => f.name === attr.field)
      if (!map[model.name]) map[model.name] = {}
      map[model.name][attr.field] = {
        enumName:    field?.type?.name ?? null,
        // A boolean column is stored 1/0 and the write payload is coerced the
        // same way, while the declared states are real booleans — so both sides
        // of every comparison below need normalizing or nothing ever matches.
        isBoolean:   field?.type?.name === 'Boolean',
        transitions: attr.transitions,
      }
    }
  }
  return map
}

export function buildEnumMap(schema) {
  const enumValues = {}
  for (const e of schema.enums) {
    enumValues[e.name] = new Set(e.values.map(v => v.name))
  }
  const map = {}
  for (const model of schema.models) {
    map[model.name] = {}
    for (const field of model.fields) {
      if (field.type.kind === 'enum' && enumValues[field.type.name]) {
        map[model.name][field.name] = {
          values:   enumValues[field.type.name],
          enumName: field.type.name,
          optional: field.type.optional,
          array:    !!field.type.array,
        }
      }
    }
  }
  return map
}


// ─── Soft delete cascade map ──────────────────────────────────────────────────
// { modelName: boolean } — true if @@softDeleteCascade is set on the model

export function buildSoftDeleteCascadeMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = !!model.attributes.find(a => a.kind === 'softDelete' && a.cascade)
  }
  return map
}

// Walk the hasMany edges of the relationMap to collect all child tables
// that also have soft delete. Returns an array of
// { childModel, childTable, parentModel, parentTable, foreignKey, referencedKey, hardDelete }
// in BFS order.
//
// relationMap is keyed by PascalCase model name (e.g. "User"), and rel.targetModel
// is also PascalCase, so the BFS traverses model names. SQL table names are derived
// on the way out via modelToTable, which converts the PascalCase model to its
// snake_case (or plural) SQL name.
export function getCascadeTargets(modelName, relationMap, softDeleteMap, modelToTable) {
  const targets  = []
  const visited  = new Set([modelName])
  const queue    = [modelName]

  while (queue.length) {
    const parent = queue.shift()
    for (const [relName, rel] of Object.entries(relationMap[parent] ?? {})) {
      if (rel.kind !== 'hasMany') continue
      const child = rel.targetModel
      if (visited.has(child)) continue
      visited.add(child)
      // @keep is the opt-out: these children stay live when the parent goes,
      // and so does everything below them — a kept child is not a door into a
      // subtree, it is a statement that the subtree is not the parent's.
      if (rel.keep) continue
      // @hardDelete children are always included regardless of their own softDelete setting.
      // Non-hardDelete children must also be a soft-delete table to cascade.
      if (!rel.hardDelete && !softDeleteMap[child]) continue
      targets.push({
        childModel:    child,
        childTable:    modelToTable(child),
        parentModel:   parent,
        parentTable:   modelToTable(parent),
        // Back-compat aliases — older call sites might still destructure these.
        foreignKey:    rel.foreignKey,
        referencedKey: rel.referencedKey,
        hardDelete:    rel.hardDelete ?? false,
      })
      // Only recurse into soft-delete children — hard-delete children are terminal
      if (!rel.hardDelete) queue.push(child)
    }
  }

  return targets
}

export function buildRelationMap(schema) {
  const map = {}
  for (const model of schema.models) {
    if (!map[model.name]) map[model.name] = {}
    for (const field of model.fields) {
      if (field.type.kind !== 'relation') continue
      const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
      if (!rel) continue
      map[model.name][field.name] = {
        kind:          'belongsTo',
        targetModel:   field.type.name,
        foreignKey:    Array.isArray(rel.fields)     ? rel.fields[0]     : rel.fields,
        referencedKey: Array.isArray(rel.references) ? rel.references[0] : rel.references,
      }
      const target = field.type.name
      if (!map[target]) map[target] = {}
      // Find the parent's hasMany back-ref field — its name is what users use
      // in include/orderBy/select. Under PascalCase singular models, the field
      // name will differ from model.name (e.g. books Book[] on Author).
      const parentModel = schema.models.find(m => m.name === target)
      // Match the back-ref array by relation LABEL (Prisma parity): an FK
      // labeled "sentByUser" pairs with the parent array labeled "sentByUser";
      // unlabeled FKs pair with unlabeled arrays. This lets two hasMany
      // relations coexist between the same pair of models.
      const relLabel = rel.name ?? null
      const backrefMatches = (f, wantArray) =>
        f.type.name === model.name && f.type.array === wantArray && f.type.kind === 'relation' &&
        ((f.attributes.find(a => a.kind === 'relation')?.name ?? null) === relLabel)
      // The plural back-reference is looked for first; a SINGULAR one is the
      // non-owning side of a one-to-one, which the parser pairs the same way
      // (FJS-563). Without this the field name was never found and the entry
      // landed under the model's own name, so `include: { profile: true }` was
      // `Unknown relation "profile"`.
      const backrefField = parentModel?.fields.find(f => backrefMatches(f, true))
        ?? parentModel?.fields.find(f => backrefMatches(f, false))
      const backrefName = backrefField?.name ?? model.name  // fallback to old behavior if no field declared
      const backrefToOne = backrefField ? !backrefField.type.array : false
      if (!map[target][backrefName]) {
        // @hardDelete, @keep and @sealed all live on the PARENT's hasMany
        // back-ref field (accounts.sessions[] @hardDelete, customers.orders[]
        // @keep, invoices.lines[] @sealed) — each is a statement the parent
        // makes about children it owns.
        const hardDelete = backrefField?.attributes.some(a => a.kind === 'hardDelete') ?? false
        const keep       = backrefField?.attributes.some(a => a.kind === 'keep')       ?? false
        const sealed     = backrefField?.attributes.some(a => a.kind === 'sealed')     ?? false
        map[target][backrefName] = {
          kind:          'hasMany',
          // Same shape and the same correlated subquery; `toOne` only decides
          // whether the caller is handed the row or a list of one. A fourth
          // relation kind would mean auditing every site that branches on kind.
          toOne:         backrefToOne,
          targetModel:   model.name,
          foreignKey:    Array.isArray(rel.fields)     ? rel.fields[0]     : rel.fields,
          referencedKey: Array.isArray(rel.references) ? rel.references[0] : rel.references,
          hardDelete,
          keep,
          sealed,
        }
      }
    }
  }

  // Implicit m2m — one manyToMany entry per relation END, keyed by field name.
  // detectM2MPairs is label-aware: several m2m relations may exist between the
  // same two models (each with its own join table), including self-relations.
  const m2mPairs = detectM2MPairs(schema)
  for (const pair of m2mPairs) {
    if (!map[pair.modelA]) map[pair.modelA] = {}
    if (!map[pair.modelB]) map[pair.modelB] = {}

    if (pair.self) {
      // Self m2m: both ends live on the same model with distinct fields.
      // selfFields maps each field to its (selfKey, targetKey) direction.
      for (const [fieldName, dir] of Object.entries(pair.selfFields ?? {})) {
        map[pair.modelA][fieldName] = {
          kind:        'manyToMany',
          targetModel: pair.modelA,
          joinTable:   pair.joinTable,
          selfKey:     dir.selfKey,
          targetKey:   dir.targetKey,
          selfPk:      pair.pkA,
          targetPk:    pair.pkA,
        }
      }
      continue
    }

    if (pair.fieldA) {
      map[pair.modelA][pair.fieldA] = {
        kind:        'manyToMany',
        targetModel: pair.modelB,
        joinTable:   pair.joinTable,
        selfKey:     pair.colA,    // join table column for THIS model
        targetKey:   pair.colB,    // join table column for TARGET model
        // The @id column each side is keyed by. Every m2m path used to write
        // `id` literally, so a model whose key is named anything else silently
        // wrote nothing (INSERT OR IGNORE swallows the NOT NULL) and read back
        // an empty list.
        selfPk:      pair.pkA,
        targetPk:    pair.pkB,
      }
    }
    if (pair.fieldB) {
      map[pair.modelB][pair.fieldB] = {
        kind:        'manyToMany',
        targetModel: pair.modelA,
        joinTable:   pair.joinTable,
        selfKey:     pair.colB,    // join table column for THIS model
        targetKey:   pair.colA,    // join table column for TARGET model
        selfPk:      pair.pkB,
        targetPk:    pair.pkA,
      }
    }
  }

  return map
}

export function guardedKeysFor(model) {
  const out = new Set()
  // @secret synthesises @guarded(all) onto the field at parse, so one condition
  // answers both — the same single fact buildFieldPolicyMap reads for the write.
  for (const f of model.fields ?? [])
    if (f.attributes?.some(a => a.kind === 'guarded')) out.add(f.name)
  return out
}

// ─── @allow('read', …) on a FIELD ─────────────────────────────────────────────
//
// The same hole `FJS-393` closed for `@guarded`, wearing a predicate: the column
// is stripped from the answer and stays fully filterable and sortable, so its
// value comes back by binary search — measured, a salary recovered exactly in
// seventeen requests (`FJS-442`).
//
// `@guarded`'s answer does not extend to it. That refusal is a set-membership
// test decided once per model; this is a predicate, and refusing every filter on
// a predicated column would also refuse the one a caller may legitimately run
// over the rows they CAN read it on — which is the case the feature exists for.
//
// So the predicate is compiled and AND-ed into the caller's arguments, OUTSIDE
// their own expression (`FJS-D129`). Outside is the whole of it: a per-clause
// conjunction is complemented by the caller's own `NOT` — `NOT ((pred) AND
// (salary > X))` is TRUE for every row they may not read, which is the same
// oracle with a minus sign — while a sibling of their where under one AND
// cannot be.
//
// The walk is `@guarded`'s, unchanged: those functions take the `own` map as an
// argument, so a second map is a second question asked of one implementation.
export function fieldReadKeysFor(model) {
  const out = new Set()
  for (const f of model.fields ?? [])
    if (f.attributes?.some(a => a.kind === 'fieldAllow' && a.operations?.includes('read')))
      out.add(f.name)
  return out
}

export function buildFieldReadMap(schema, relationMap) {
  const own = {}
  for (const m of schema.models) own[m.name] = fieldReadKeysFor(m)
  const reaches = new Set(Object.keys(own).filter(n => own[n].size))
  for (let grew = true; grew; ) {
    grew = false
    for (const m of schema.models) {
      if (reaches.has(m.name)) continue
      for (const rel of Object.values(relationMap?.[m.name] ?? {})) {
        if (reaches.has(rel.targetModel)) { reaches.add(m.name); grew = true; break }
      }
    }
  }
  return { own, reaches, relationMap }
}

export function buildGuardedMap(schema, relationMap) {
  const own = {}
  for (const m of schema.models) own[m.name] = guardedKeysFor(m)
  const reaches = new Set(Object.keys(own).filter(n => own[n].size))
  // A relation is a path a caller's arguments can walk, so a model reaches a
  // guarded column when anything it can reach does. Fixed point rather than
  // recursion because the relation graph has cycles in every real schema.
  for (let grew = true; grew; ) {
    grew = false
    for (const m of schema.models) {
      if (reaches.has(m.name)) continue
      for (const rel of Object.values(relationMap?.[m.name] ?? {})) {
        if (reaches.has(rel.targetModel)) { reaches.add(m.name); grew = true; break }
      }
    }
  }
  return { own, reaches, relationMap }
}
// ─── Soft delete map ──────────────────────────────────────────────────────────
// { modelName: boolean } — true if the model uses soft delete

export function buildSoftDeleteMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = isSoftDelete(model)
  }
  return map
}

// ─── @@hasTemplates map ───────────────────────────────────────────────────────
// { modelName: string | null } — name of the marker column if the model has
// @@hasTemplates, otherwise null. Lookup is hot-path on every read query so
// we keep it as a pre-computed plain object.

export function buildHasTemplatesMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const attr = model.attributes.find(a => a.kind === 'hasTemplates')
    map[model.name] = attr ? attr.field : null
  }
  return map
}

// ─── Co-FK map ────────────────────────────────────────────────────────────────
// For nested writes, identify FK columns that exist on BOTH the parent and the
// child and reference the same target table. These are propagated from parent
// to child during nested create/update — preventing referential drift like a
// child line item ending up with a different tenantId than its parent order.
//
// Shape: { parentModel: { childModel: [<fk_col_name>, ...] } }
//
// A column qualifies as a co-FK when:
//   1. Both parent and child have a belongsTo relation with the same FK name
//   2. Both relations point at the same target model
//   3. Both reference the same target column (always 'id' in practice, but
//      we check explicitly so multi-PK targets don't surprise us)
//
// The PK of the parent that becomes the child's FK in a hasMany relation
// (e.g. `account.id` → `users.accountId`) is excluded — that's already
// handled by the existing FK injection at processHasManyNested time.

export function buildCoFkMap(schema, relationMap) {
  const map = {}
  for (const parentModel of schema.models) {
    const parentRels = relationMap[parentModel.name] ?? {}
    // Collect parent's belongsTo FKs: { columnName: { target, references } }
    const parentBT = {}
    for (const rel of Object.values(parentRels)) {
      if (rel.kind !== 'belongsTo') continue
      parentBT[rel.foreignKey] = { target: rel.targetModel, references: rel.referencedKey }
    }
    if (!Object.keys(parentBT).length) continue

    // Walk every other model — anyone whose belongsTo overlaps with parent's
    // belongsTo on column name AND target IS a co-FK candidate.
    for (const childModel of schema.models) {
      if (childModel.name === parentModel.name) continue
      const childRels = relationMap[childModel.name] ?? {}
      const overlaps = []
      for (const rel of Object.values(childRels)) {
        if (rel.kind !== 'belongsTo') continue
        const p = parentBT[rel.foreignKey]
        if (!p) continue
        if (p.target !== rel.targetModel) continue
        if (p.references !== rel.referencedKey) continue
        overlaps.push(rel.foreignKey)
      }
      if (overlaps.length) {
        if (!map[parentModel.name]) map[parentModel.name] = {}
        map[parentModel.name][childModel.name] = overlaps
      }
    }
  }
  return map
}


// ─── FTS map ──────────────────────────────────────────────────────────────────
// { modelName: string[] | null } — indexed field names if @@fts, else null

export function buildFtsMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const attr = model.attributes.find(a => a.kind === 'fts')
    map[model.name] = attr ? attr.fields : null
  }
  return map
}

// Current ISO timestamp for soft deletes. Takes the client's clock when one was
// injected, so a frozen `now` freezes every timestamp litestone writes rather
// than only the ones a policy compares against.
export function nowISO(clock) {
  const raw = typeof clock === 'function' ? clock() : new Date()
  return raw instanceof Date ? raw.toISOString() : String(raw)
}
