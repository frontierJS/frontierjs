// src/policy.js — Row-level access policy engine
//
// Implements @@allow / @@deny schema-defined policies.
// Policies are compiled from their AST into SQL WHERE fragments at query time
// (so auth() and now() resolve against the live request context).
//
// ─── Semantics ────────────────────────────────────────────────────────────────
//
//   Default: no restriction (if no @@allow rules exist for an operation)
//   @@allow: once any @@allow exists for an op, default becomes DENY
//   @@deny:  always overrides @@allow (explicit deny wins)
//   Combined filter: (A1 OR A2 OR ...) AND NOT D1 AND NOT D2
//
//   asSystem() → complete bypass of all policies
//
// ─── Per-operation enforcement ────────────────────────────────────────────────
//
//   read        → WHERE injection on SELECT
//   create      → JS pre-check against data before INSERT
//   update      → WHERE injection on UPDATE query
//   post-update → post-write check inside transaction; rollback if denied
//   delete      → WHERE injection on DELETE query
//
// ─── check(field, op?) ───────────────────────────────────────────────────────
//
//   Delegates to a to-one related model's policy via EXISTS subquery.
//   Cycle-safe: visited set prevents infinite recursion.

import { AccessDeniedError }   from './plugin.js'
import { modelToTableName }    from './ddl.js'
import { comparisonEncoderFor } from './encryption.js'
import { ValidationError }     from './validate.js'
import { NOW_SQL }             from './query.js'

// ─── Debug logger ─────────────────────────────────────────────────────────────
// policyDebug: true     — logs SQL filters + denials
// policyDebug: 'verbose' — also logs passes + asSystem bypasses

function plog(ctx, op, model, msg, extra = '') {
  if (!ctx.policyDebug) return
  const tag = `[36m[litestone:policy][0m`
  console.log(`${tag} ${op.padEnd(12)} "${model}"  ${msg}${extra ? `  ${extra}` : ''}`)
}

// ─── Policy expression → source text ──────────────────────────────────────────
//
// Round-trips a parsed `@@allow`/`@@deny` condition back to the syntax it was
// written in. The snapshot has to show the predicate itself: a policy compiles
// silently into the WHERE clause, so "which rows" is invisible everywhere else.

const PREC = { ternary: 0, or: 1, and: 2, not: 3 }
const prec = (node) => PREC[node?.type] ?? 4

export function policyExprToString(node) {
  if (!node) return '?'

  const child = (n) => (prec(n) < prec(node) ? `(${policyExprToString(n)})` : policyExprToString(n))

  switch (node.type) {
    case 'or':      return `${child(node.left)} || ${child(node.right)}`
    case 'and':     return `${child(node.left)} && ${child(node.right)}`
    // A compare binds tighter than `!` in the grammar, so `!a == b` parses as
    // not(compare). The parens are added back for the reader and re-parse the same.
    case 'not':     return node.expr?.type === 'compare'
      ? `!(${policyExprToString(node.expr)})`
      : `!${child(node.expr)}`
    case 'compare': return `${child(node.left)} ${node.op} ${child(node.right)}`
    // Loosest binding, so every operand that is itself a ternary needs no
    // parens on the right and does on the left — `prec` handles it.
    case 'ternary': return `${child(node.cond)} ? ${policyExprToString(node.then)} : ${policyExprToString(node.else)}`
    case 'auth':    return node.field ? `auth().${node.field}` : 'auth()'
    case 'now':     return 'now()'
    case 'check':   return node.operation ? `check(${node.field}, '${node.operation}')` : `check(${node.field})`
    case 'field':   return node.name
    case 'list':    return `[${node.items.map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', ')}]`
    case 'literal': {
      const v = node.value
      if (v === null)              return 'null'
      if (typeof v === 'string')   return `'${v}'`
      return String(v)
    }
    default:        return `<${node.type}>`
  }
}

// ─── Build policy map ─────────────────────────────────────────────────────────
// { modelName: { 'read': { allows: [expr,...], denies: [expr,...] }, ... } }

const ALL_OPS = ['read', 'create', 'update', 'post-update', 'delete']

// ─── `in` is checked against the schema, once, at startup ─────────────────────
//
// A policy compiles into a WHERE, so a wrong one is an empty screen with a 200
// rather than an error — the failure mode `@@allow` has by design. Everything
// decidable from the schema is therefore decided here, where the answer is a
// refusal naming the model and the expression, and not on a query nobody has
// run yet.
function checkExpr(model, expr, relationMap, what = '@@allow/@@deny') {
  const known = (name) => {
    const rel = relationMap?.[model.name]?.[name]
    if (rel) return true
    const col = rel?.kind === 'belongsTo' ? rel.foreignKey : name
    return model.fields.some(f => f.name === col)
  }

  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'or' || n.type === 'and') { walk(n.left); walk(n.right); return }
    if (n.type === 'not') { walk(n.expr); return }
    if (n.type === 'ternary') { walk(n.cond); walk(n.then); walk(n.else); return }
    // A bare name that is not a column reaches SQLite as `"nope" > 1`, which it
    // resolves as a STRING CONSTANT rather than failing — so the predicate is
    // answered by comparing two literals and the filter silently admits or
    // excludes everything. Same fallback as FJS-202, reached from the schema.
    if (n.type === 'field' && !known(n.name)) {
      const cols = model.fields.map(f => f.name).sort()
      throw new Error(
        `${model.name}: '${n.name}' is not a field on this model — in ${what} ` +
        `'${policyExprToString(expr)}'. Fields: ${cols.join(', ')}`)
    }
    if (n.type !== 'compare') return
    walk(n.left); walk(n.right)
    if (n.op !== 'in') return

    const say = (msg) => { throw new Error(`${model.name}: ${msg} — in @@allow/@@deny '${policyExprToString(n)}'`) }
    const fieldNamed = (name) => {
      const rel = relationMap?.[model.name]?.[name]
      const col = rel?.kind === 'belongsTo' ? rel.foreignKey : name
      return model.fields.find(f => f.name === col) ?? null
    }

    // Right: the list.
    if (n.right.type === 'field') {
      const f = fieldNamed(n.right.name)
      if (!f) say(`'${n.right.name}' is not a field on this model`)
      // The swap is only worth suggesting when the other side really is a list;
      // proposing `name in auth().id` would be a second wrong expression.
      if (!f.type?.array)
        say(`'${n.right.name}' is not an array field, and 'in' takes the list on the RIGHT` +
            (fieldNamed(n.left.name)?.type?.array
              ? `. Did you mean '${policyExprToString(n.right)} in ${policyExprToString(n.left)}'?`
              : ``))
      // json_each reads the stored document; an encoded column stores something
      // that is not the value, so a member would have to be encoded the same
      // way per element, which nothing does.
      for (const kind of ['encrypted', 'hashed', 'secret'])
        if (f.attributes?.some(a => a.kind === kind))
          say(`'${n.right.name}' is @${kind}, so the column holds an encoding rather than its members`)
    } else if (n.right.type !== 'list' && n.right.type !== 'auth') {
      say(`the right side of 'in' must be a list — an array field, auth().something, or a literal like ['draft', 'review']`)
    }

    // Left: one value. A column on the row cannot be one, because json_each is
    // already reading a column of that same row.
    if (n.left.type === 'field') {
      const f = fieldNamed(n.left.name)
      if (!f) say(`'${n.left.name}' is not a field on this model`)
      if (f.type?.array)
        say(`'${n.left.name}' is an array field, and 'in' asks whether ONE value is in a list. ` +
            `Overlap between two lists is not expressible yet`)
      if (n.right.type === 'field')
        say(`both sides name a column on this model. 'in' compares a value the CALLER has ` +
            `against a list on the row — put auth().something on the left`)
    } else if (n.left.type === 'list') {
      say(`a list cannot be the left side of 'in'`)
    }
  }
  walk(expr)
}

// ─── @derived ─────────────────────────────────────────────────────────────────
//
// The same expression language compiled to a STATIC SQL expression — no
// context, no parameters — because a derived field is a column of the SELECT
// built once at startup, the way an `@from` subquery is. That is what lets it
// ride `@from`'s seam and reach all six SELECT-building sites, the WHERE
// substitution and the ORDER BY without new plumbing.
//
// Static is also what makes the tiers crisp. `now()` is allowed and emits
// SQLite's own clock, which SQLite fixes for the duration of a statement, so
// every occurrence is one instant. `auth()` and `check()` are NOT: both are
// per-request, and a column whose value differs by who is reading it is not a
// fact about the row. That shape is what `@@scope` and `@@allow` are for, and
// the refusal says so.

const DERIVED_SQL_OPS = { '==': '=', '!=': '!=', '<': '<', '>': '>', '<=': '<=', '>=': '>=' }

export function compileDerived(model, fieldName, node) {
  const bad = (msg) => {
    throw new Error(`${model.name}.${fieldName}: ${msg} — in @derived(${policyExprToString(node)})`)
  }
  const walk = (n) => {
    if (!n || typeof n !== 'object') bad('unsupported expression')
    switch (n.type) {
      case 'or':      return `(${walk(n.left)} OR ${walk(n.right)})`
      case 'and':     return `(${walk(n.left)} AND ${walk(n.right)})`
      case 'not':     return `(NOT ${walk(n.expr)})`
      case 'ternary': return `CASE WHEN ${walk(n.cond)} THEN ${walk(n.then)} ELSE ${walk(n.else)} END`
      case 'now':     return NOW_SQL
      case 'field': {
        const f = model.fields.find(x => x.name === n.name)
        if (!f) bad(`'${n.name}' is not a field on this model`)
        if (f.attributes?.some(a => a.kind === 'computed'))
          bad(`'${n.name}' is @computed — a JS function over a row, which SQLite cannot see`)
        if (f.attributes?.some(a => a.kind === 'derived'))
          bad(`'${n.name}' is @derived — one derived field cannot read another yet`)
        return `"${n.name}"`
      }
      case 'literal':
        if (n.value === null)  return 'NULL'
        if (n.value === true)  return '1'
        if (n.value === false) return '0'
        return typeof n.value === 'number' ? String(n.value) : `'${String(n.value).replace(/'/g, "''")}'`
      case 'compare': {
        // `x == null` is IS NULL, the same trap FJS-195 was: SQLite answers
        // NULL — never true — for `"col" = NULL`.
        if (n.right.type === 'literal' && n.right.value === null)
          return `(${walk(n.left)} IS ${n.op === '==' ? '' : 'NOT '}NULL)`
        if (n.left.type === 'literal' && n.left.value === null)
          return `(${walk(n.right)} IS ${n.op === '==' ? '' : 'NOT '}NULL)`
        if (n.op === 'in') {
          if (n.right.type === 'list')
            return `(${walk(n.left)} IN (${n.right.items.map(v => walk({ type: 'literal', value: v })).join(', ')}))`
          if (n.right.type === 'field')
            return `EXISTS (SELECT 1 FROM json_each(${walk(n.right)}) WHERE value = ${walk(n.left)})`
          bad(`the right side of 'in' must be an array field or a literal list`)
        }
        return `(${walk(n.left)} ${DERIVED_SQL_OPS[n.op]} ${walk(n.right)})`
      }
      case 'auth':
        bad(`auth() is per-request and a @derived field is one value for the row, not one per reader. ` +
            `A per-caller predicate is @@scope(name, …), asked for as where: { $scope: 'name' }`)
        break
      case 'check':
        bad(`check() delegates to another model's policy, which is per-request — see @@scope`)
        break
      default:
        bad(`unsupported expression node '${n.type}'`)
    }
  }
  return walk(node)
}

// ─── the declared type is checked against the branches ───────────────────────
//
// The obligation a ternary brings with it (FJS-234): the language now produces
// VALUES, so a field that declares `Status` and whose branches yield 'urgnet'
// is a schema error rather than a row that reads back a string no enum member
// matches. Inference is deliberately partial — `null` means *cannot tell*, and
// an unknown never fails, because a type checker that guesses is worse than one
// that is quiet.

function inferType(model, schema, n) {
  if (!n || typeof n !== 'object') return null
  switch (n.type) {
    case 'and': case 'or': case 'not': case 'compare': return 'Boolean'
    case 'now': return 'DateTime'
    case 'literal':
      if (n.value === null) return null
      if (typeof n.value === 'boolean') return 'Boolean'
      if (typeof n.value === 'number')  return Number.isInteger(n.value) ? 'Int' : 'Float'
      if (typeof n.value === 'string')  return 'String'
      return null
    case 'field': {
      const f = model.fields.find(x => x.name === n.name)
      return f?.type?.name ?? null
    }
    case 'ternary': {
      const t = inferType(model, schema, n.then)
      const e = inferType(model, schema, n.else)
      if (t && e && t !== e) return { conflict: [t, e] }
      return t ?? e
    }
    default: return null
  }
}

// Which literal values a branch can produce, for an enum-typed field.
function literalValues(n, out = []) {
  if (!n || typeof n !== 'object') return out
  if (n.type === 'ternary') { literalValues(n.then, out); literalValues(n.else, out); return out }
  if (n.type === 'literal' && typeof n.value === 'string') out.push(n.value)
  return out
}

export function checkDerivedType(model, schema, field, expr) {
  const declared = field.type?.name
  const bad = (msg) => {
    throw new Error(`${model.name}.${field.name}: ${msg} — in @derived(${policyExprToString(expr)})`)
  }
  const got = inferType(model, schema, expr)
  if (got && typeof got === 'object' && got.conflict)
    bad(`the branches produce ${got.conflict[0]} and ${got.conflict[1]}, so the field cannot be one type`)
  if (!got) return   // cannot tell — say nothing

  const enumDef = schema.enums?.find(e => e.name === declared)
  if (enumDef) {
    // An enum field's branches must all name members of that enum.
    const values = literalValues(expr)
    const members = new Set(enumDef.values.map(v => v.name))
    const stray = values.filter(v => !members.has(v))
    if (stray.length)
      bad(`${stray.map(v => `'${v}'`).join(', ')} ${stray.length > 1 ? 'are' : 'is'} not a member of enum ` +
          `${declared} — declared: ${[...members].join(', ')}`)
    if (values.length && got !== 'String') bad(`declares ${declared} and the expression produces ${got}`)
    return
  }

  // Int and Float interchange; everything else has to match what was declared.
  const numeric = new Set(['Int', 'Float'])
  const ok = got === declared || (numeric.has(got) && numeric.has(declared))
  if (!ok) bad(`declares ${declared} and the expression produces ${got}`)
}

// Does this expression read the clock? The one thing a consumer has to know
// beyond the value: a derived field that depends on now() goes stale on its own,
// with no write and no event to announce it.
export function dependsOnClock(node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'now') return true
  return ['left', 'right', 'expr', 'cond', 'then', 'else'].some(k => dependsOnClock(node[k]))
}

// ─── @@scope ──────────────────────────────────────────────────────────────────
// { modelName: { scopeName: expr } }. A name declared twice on one model is a
// schema error rather than a last-one-wins, because the two would be
// indistinguishable at the call site.

export function buildScopeMap(schema, relationMap) {
  const map = {}
  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'scope') continue
      map[model.name] ??= {}
      if (attr.name in map[model.name])
        throw new Error(`${model.name}: @@scope(${attr.name}, …) is declared twice — a name means one predicate`)
      // Same startup check @@allow gets: a scope compiles into a WHERE, so a
      // wrong one is an empty screen with a 200.
      checkExpr(model, attr.expr, relationMap, `@@scope(${attr.name}, …)`)
      map[model.name][attr.name] = attr.expr
    }
  }
  return map
}

// A scope, compiled. Returns a RawClause — the same shape the `sql` tag
// produces — so `where` composition, nesting under AND/OR/NOT and positional
// parameter order all come from the one owner that already does them, rather
// than from a second implementation of each.
//
// Invariant 8, at the site it matters: `name` is a KEY looked up in the table
// the schema declared. Nothing a caller sends is ever interpolated — an unknown
// name is refused by name and never reaches SQL.
export function compileScope(modelName, name, ctx, scopeMap, policyMap, schema, relationMap) {
  const expr = scopeMap?.[modelName]?.[name]
  if (!expr) {
    const known = Object.keys(scopeMap?.[modelName] ?? {})
    throw new ValidationError([{ path: ['where', '$scope'], message:
      `Unknown scope '${name}' on ${modelName}.` +
      (known.length ? ` Declared: ${known.sort().join(', ')}` : ` This model declares no @@scope.`) }])
  }
  const params = []
  const at     = atOneInstant(ctx)
  const sql    = compileSql(expr, params, at, modelName, 'read', policyMap ?? {}, schema, relationMap, new Set())
  return { _litestoneRaw: true, sql, params }
}

export function buildPolicyMap(schema, relationMap) {
  const map = {}

  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'allow' && attr.kind !== 'deny') continue
      checkExpr(model, attr.expr, relationMap)
      if (!map[model.name]) map[model.name] = {}
      const bucket = map[model.name]

      for (const op of attr.operations) {
        if (!bucket[op]) bucket[op] = { allows: [], denies: [] }
        if (attr.kind === 'allow') bucket[op].allows.push({ expr: attr.expr, message: attr.message ?? null })
        else                       bucket[op].denies.push({ expr: attr.expr, message: attr.message ?? null })
      }
    }
  }

  return map
}

// ─── Public entry points ──────────────────────────────────────────────────────

// Returns { sql, params } to AND-merge into a query WHERE, or null (no filter).
// Pass op = 'read' | 'update' | 'delete' for SQL-based enforcement.
// ─── One clock per evaluation ────────────────────────────────────────────────
// `now()` used to resolve where it was REACHED, so `startAt < now() && now() <
// endAt` bound two timestamps microseconds apart and a report had no single
// "as of" instant to reconcile against. Resolved once per policy evaluation and
// carried on a prototype view of ctx — O(1), and every nested compile (a
// `check(field)` delegation recurses) reads the same moment.
//
// `createClient({ now })` is the injection point: a test freezes it and a
// report pins it, which is the only way a time-dependent assertion is
// deterministic.
export function atOneInstant(ctx) {
  if (ctx?._now) return ctx
  const raw  = typeof ctx?.now === 'function' ? ctx.now() : new Date()
  const view = Object.create(ctx ?? null)
  view._now  = raw instanceof Date ? raw.toISOString() : String(raw)
  return view
}

export function buildPolicyFilter(modelName, op, ctx, policyMap, schema, relationMap) {
  ctx = atOneInstant(ctx)
  if (ctx.isSystem) {
    if (ctx.policyDebug === 'verbose') plog(ctx, op, modelName, '[2mskipped (asSystem)[0m')
    return null
  }
  if (!policyMap[modelName]?.[op]) {
    if (ctx.policyDebug === 'verbose') plog(ctx, op, modelName, '[2mno policy[0m')
    return null
  }

  const params = []
  const sql    = buildFilterSql(modelName, op, params, ctx, policyMap, schema, relationMap, new Set())
  if (!sql) return null

  // Guard BEFORE building the log strings — this path runs on every policied
  // query, and the template + per-param JSON.stringify were previously
  // evaluated even with policyDebug off.
  if (ctx.policyDebug) {
    plog(ctx, op, modelName,
      `[33m→ WHERE[0m (${sql})`,
      params.length ? `[2m[${params.map(p => JSON.stringify(p)).join(', ')}][0m` : ''
    )
  }
  return { sql, params }
}

// Throws AccessDeniedError if the create policy denies the operation.
// Evaluates purely in JS against the data being created (no SQL — INSERT has no WHERE).
export function checkCreatePolicy(modelName, data, ctx, policyMap, schema, relationMap) {
  ctx = atOneInstant(ctx)
  if (ctx.isSystem) {
    if (ctx.policyDebug === 'verbose') plog(ctx, 'create', modelName, '[2mskipped (asSystem)[0m')
    return
  }
  const rules = policyMap[modelName]?.['create']
  if (!rules) {
    if (ctx.policyDebug === 'verbose') plog(ctx, 'create', modelName, '[2mno policy[0m')
    return
  }

  const { allows, denies } = rules

  // Check denies first — explicit deny wins
  for (const { expr, message } of denies) {
    if (evalJs(expr, ctx, data, modelName, policyMap, relationMap)) {
      plog(ctx, 'create', modelName, '[31mDENIED[0m (@@deny fired)')
      throw new AccessDeniedError(message ?? `Create denied by @@deny policy on "${modelName}"`, { model: modelName, operation: 'create' })
    }
  }

  // If any @@allow exists, at least one must pass
  if (allows.length) {
    const permitted = allows.some(({ expr }) => evalJs(expr, ctx, data, modelName, policyMap, relationMap))
    if (!permitted) {
      plog(ctx, 'create', modelName, '[31mDENIED[0m (no @@allow passed)')
      const msg = allows.find(({ message }) => message)?.message
      throw new AccessDeniedError(msg ?? `Create denied by @@allow policy on "${modelName}"`, { model: modelName, operation: 'create' })
    }
    if (ctx.policyDebug === 'verbose') plog(ctx, 'create', modelName, '[32mallowed[0m')
  }
}

// Evaluates a post-update policy against a row object in JS.
// Call after the write, inside a transaction — throw to trigger rollback.
export function checkPostUpdatePolicy(modelName, row, ctx, policyMap, schema, relationMap) {
  ctx = atOneInstant(ctx)
  if (ctx.isSystem) {
    if (ctx.policyDebug === 'verbose') plog(ctx, 'post-update', modelName, '[2mskipped (asSystem)[0m')
    return
  }
  const rules = policyMap[modelName]?.['post-update']
  if (!rules) return

  const { allows, denies } = rules

  for (const { expr, message } of denies) {
    if (evalJs(expr, ctx, row, modelName, policyMap, relationMap)) {
      plog(ctx, 'post-update', modelName, '[31mDENIED[0m (@@deny fired) — rolling back')
      throw new AccessDeniedError(message ?? `Update denied by @@deny post-update policy on "${modelName}"`, { model: modelName, operation: 'post-update' })
    }
  }

  if (allows.length) {
    const permitted = allows.some(({ expr }) => evalJs(expr, ctx, row, modelName, policyMap, relationMap))
    if (!permitted) {
      plog(ctx, 'post-update', modelName, '[31mDENIED[0m (no @@allow passed) — rolling back')
      const msg = allows.find(({ message }) => message)?.message
      throw new AccessDeniedError(msg ?? `Update denied by @@allow post-update policy on "${modelName}"`, { model: modelName, operation: 'post-update' })
    }
    if (ctx.policyDebug === 'verbose') plog(ctx, 'post-update', modelName, '[32mallowed[0m')
  }
}

// ─── SQL compiler ─────────────────────────────────────────────────────────────

function buildFilterSql(modelName, op, params, ctx, policyMap, schema, relationMap, visited) {
  if (visited.has(modelName)) return '1'  // cycle guard — open if recursive
  const next = new Set([...visited, modelName])

  const rules = policyMap[modelName]?.[op]
  if (!rules) return null

  const { allows, denies } = rules
  if (!allows.length && !denies.length) return null

  const parts = []

  if (allows.length) {
    const sqls = allows.map(({ expr }) => compileSql(expr, params, ctx, modelName, op, policyMap, schema, relationMap, next))
    parts.push(sqls.length === 1 ? sqls[0] : `(${sqls.join(' OR ')})`)
  }

  for (const { expr } of denies) {
    const sql = compileSql(expr, params, ctx, modelName, op, policyMap, schema, relationMap, next)
    parts.push(`NOT (${sql})`)
  }

  return parts.length === 1 ? parts[0] : parts.join(' AND ')
}

function sqlOp(op) {
  return op === '==' ? '=' : op === '!=' ? '!=' : op
}

// ─── An encoded column inside a predicate ─────────────────────────────────────
// A `where` encodes its operand before comparing (client.js rewriteEncryptedWhere);
// a policy predicate must make the SAME translation, or the plaintext is compared
// against the stored bytes, nothing matches, and the model reads as empty for every
// caller with nothing raised. `comparisonEncoderFor` is the one owner of the choice
// of encoding, so the two paths cannot drift apart again.
//
// Only equality survives an encoding and a column under a random IV survives
// nothing. createClient refuses both against the schema, so a throw from here means
// a predicate reached the compiler some other way — it is a backstop, not the
// message a developer is meant to read.
function encodedCompare(node, params, ctx, modelName, relationMap) {
  if (!ctx.enc?.key) return null

  const { left, right } = node
  const fieldNode = left.type === 'field' ? left : right.type === 'field' ? right : null
  if (!fieldNode) return null

  const rel = relationMap[modelName]?.[fieldNode.name]
  const col = rel?.kind === 'belongsTo' ? rel.foreignKey : fieldNode.name
  const enc = comparisonEncoderFor(ctx.fieldPolicyMap?.[modelName]?.[col])
  if (!enc) return null

  const subject = `"${modelName}.${col}" is ${enc.label}`
  if (!enc.encode) throw new Error(
    `${subject} — the same value stores different bytes every write, so no operand can be encoded to match it. ` +
    `Declare it @encrypted(deterministic: true) or @hashed for a policy to compare it`)
  if (node.op !== '==' && node.op !== '!=') throw new Error(
    `${subject} — it can answer equality and cannot answer '${node.op}', because neither encoding preserves ordering`)

  const other = fieldNode === left ? right : left
  if (other.type === 'field') throw new Error(
    `${subject} — it is compared against the column "${other.name}", and only a value the policy can encode ` +
    `may be compared against an encoded column`)

  const raw = other.type === 'literal' ? other.value
            : other.type === 'auth'    ? (other.field ? (ctx.auth?.[other.field] ?? null) : (ctx.auth?.id ?? null))
            : other.type === 'now'     ? ctx._now
            : undefined
  if (raw === undefined) throw new Error(
    `${subject} — it is compared against something with no value to encode`)

  // An auth field the caller does not carry stays null, so the comparison is
  // against NULL and denies. That is the direction to fail in: encoding the
  // absence would match every row whose column holds the encoding of null.
  params.push(raw === null ? null : enc.encode(raw, ctx.enc.key))
  return `"${col}" ${sqlOp(node.op)} ?`
}

// The left operand of `in` reduced to one bound value. A field there is a
// column on the row being tested, which json_each cannot compare against
// itself — `buildPolicyMap` refuses that shape at startup, so anything
// reaching here is an auth value, a literal or the clock.
function scalarOperand(node, ctx, modelName, relationMap) {
  switch (node.type) {
    case 'auth':    return node.field ? (ctx.auth?.[node.field] ?? null) : (ctx.auth?.id ?? null)
    case 'literal': return node.value
    case 'now':     return ctx._now
    default:        return null
  }
}

function compileSql(node, params, ctx, modelName, op, policyMap, schema, relationMap, visited) {
  switch (node.type) {

    case 'or':
      return `(${compileSql(node.left, params, ctx, modelName, op, policyMap, schema, relationMap, visited)} OR ${compileSql(node.right, params, ctx, modelName, op, policyMap, schema, relationMap, visited)})`

    case 'and':
      return `(${compileSql(node.left, params, ctx, modelName, op, policyMap, schema, relationMap, visited)} AND ${compileSql(node.right, params, ctx, modelName, op, policyMap, schema, relationMap, visited)})`

    case 'not':
      return `NOT (${compileSql(node.expr, params, ctx, modelName, op, policyMap, schema, relationMap, visited)})`

    case 'literal':
      if (node.value === null)  return 'NULL'
      if (node.value === true)  return '1'
      if (node.value === false) return '0'
      params.push(node.value)
      return '?'

    case 'field':
      return `"${node.name}"`

    case 'auth':
      params.push(node.field ? (ctx.auth?.[node.field] ?? null) : (ctx.auth?.id ?? null))
      return '?'

    case 'now':
      params.push(ctx._now)
      return '?'

    // CASE WHEN … THEN … ELSE … END. Params are pushed in emission order —
    // condition, then, else — because positional binds make the order the
    // correctness, and a CASE is the one node here whose operands are not all
    // on one side of an operator.
    case 'ternary': {
      const c = compileSql(node.cond, params, ctx, modelName, op, policyMap, schema, relationMap, visited)
      const t = compileSql(node.then, params, ctx, modelName, op, policyMap, schema, relationMap, visited)
      const e = compileSql(node.else, params, ctx, modelName, op, policyMap, schema, relationMap, visited)
      return `CASE WHEN ${c} THEN ${t} ELSE ${e} END`
    }

    case 'compare': {
      const { left, right } = node

      // ── membership ────────────────────────────────────────────────────────
      // `X in LIST`: the right operand is always the list, whichever side it
      // lives on. Three sources, three shapes of SQL, and the empty case is the
      // one that has to be said out loud — `IN ()` is a syntax error, and a
      // policy whose list is empty admits nothing.
      if (node.op === 'in') {
        // the list is an array COLUMN on the row
        if (right.type === 'field') {
          const rel = relationMap[modelName]?.[right.name]
          const col = rel?.kind === 'belongsTo' ? rel.foreignKey : right.name
          params.push(scalarOperand(left, ctx, modelName, relationMap))
          // json_each over the stored document, the same SQL `where: { col: { has } }`
          // compiles to — one definition of what membership means in SQLite.
          return `EXISTS (SELECT 1 FROM json_each("${col}") WHERE value = ?)`
        }
        // the list is on the principal, or written literally
        const items = right.type === 'list'
          ? right.items
          : right.type === 'auth'
            ? (right.field ? ctx.auth?.[right.field] : ctx.auth?.id)
            : undefined
        const list = Array.isArray(items) ? items : items == null ? [] : [items]
        if (!list.length) return '0'
        const L = left.type === 'field'
          ? `"${relationMap[modelName]?.[left.name]?.kind === 'belongsTo'
              ? relationMap[modelName][left.name].foreignKey : left.name}"`
          : compileSql(left, params, ctx, modelName, op, policyMap, schema, relationMap, visited)
        params.push(...list)
        return `${L} IN (${list.map(() => '?').join(', ')})`
      }

      // auth() == null  /  auth() != null
      if (left.type === 'auth' && right.type === 'literal' && right.value === null) {
        const val = left.field ? (ctx.auth?.[left.field] ?? null) : (ctx.auth?.id ?? null)
        params.push(val)
        return node.op === '==' ? '? IS NULL' : '? IS NOT NULL'
      }
      if (right.type === 'auth' && left.type === 'literal' && left.value === null) {
        const val = right.field ? (ctx.auth?.[right.field] ?? null) : (ctx.auth?.id ?? null)
        params.push(val)
        return node.op === '==' ? '? IS NULL' : '? IS NOT NULL'
      }

      // field == null  /  field != null
      //
      // SQLite answers NULL — never true — for `"col" = NULL`, so a policy
      // written this way filtered every row out and raised nothing: an empty
      // screen with a 200, which is the failure mode `@@allow` has by design.
      // The JS evaluator below compares with `===` and always got this right,
      // so create ALLOWED a row that read then hid.
      if (left.type === 'field' && right.type === 'literal' && right.value === null) {
        const rel = relationMap[modelName]?.[left.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : left.name
        return `"${fk}" ${node.op === '==' ? 'IS NULL' : 'IS NOT NULL'}`
      }
      if (right.type === 'field' && left.type === 'literal' && left.value === null) {
        const rel = relationMap[modelName]?.[right.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : right.name
        return `"${fk}" ${node.op === '==' ? 'IS NULL' : 'IS NOT NULL'}`
      }

      // A column holding encoded bytes is compared against the operand encoded the
      // same way — after the null branches above, which stay a plain IS NULL.
      const encoded = encodedCompare(node, params, ctx, modelName, relationMap)
      if (encoded) return encoded

      // field == auth()  →  resolve FK if it's a belongsTo relation
      if (left.type === 'field' && right.type === 'auth' && right.field === null) {
        const rel = relationMap[modelName]?.[left.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : left.name
        params.push(ctx.auth?.id ?? null)
        return `"${fk}" ${sqlOp(node.op)} ?`
      }
      if (right.type === 'field' && left.type === 'auth' && left.field === null) {
        const rel = relationMap[modelName]?.[right.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : right.name
        params.push(ctx.auth?.id ?? null)
        return `"${fk}" ${sqlOp(node.op)} ?`
      }

      const L = compileSql(left,  params, ctx, modelName, op, policyMap, schema, relationMap, visited)
      const R = compileSql(right, params, ctx, modelName, op, policyMap, schema, relationMap, visited)
      return `${L} ${sqlOp(node.op)} ${R}`
    }

    case 'check': {
      const rel = relationMap[modelName]?.[node.field]
      if (!rel || rel.kind !== 'belongsTo')
        throw new Error(`check(${node.field}): only to-one (belongsTo) relations are supported in policy expressions`)

      const targetModel = rel.targetModel
      const checkOp     = node.operation ?? op   // default to containing rule's operation
      const subParams   = []
      const subSql      = buildFilterSql(targetModel, checkOp, subParams, ctx, policyMap, schema, relationMap, visited)

      params.push(...subParams)

      const targetDef   = schema.models.find(m => m.name === targetModel)
      const targetTable = targetDef ? modelToTableName(targetDef, false) : targetModel

      if (!subSql) return '1'   // target has no policy — allow

      return `EXISTS (SELECT 1 FROM "${targetTable}" WHERE "${targetTable}"."${rel.referencedKey}" = "${modelName}"."${rel.foreignKey}" AND (${subSql}))`
    }

    default:
      throw new Error(`Unknown policy AST node type: ${node.type}`)
  }
}

// ─── JS evaluator (create + post-update) ──────────────────────────────────────
// Evaluates a policy expression against a data/row object in JavaScript.
// Used when there's no WHERE clause available (create) or for post-update checks.

export function evalJs(node, ctx, data, modelName, policyMap, relationMap) {
  const ev = n => evalJs(n, ctx, data, modelName, policyMap, relationMap)

  switch (node.type) {
    case 'or':      return ev(node.left) || ev(node.right)
    case 'and':     return ev(node.left) && ev(node.right)
    case 'not':     return !ev(node.expr)

    case 'literal': return node.value

    case 'field':   return data?.[node.name] ?? null

    case 'auth':
      return node.field ? (ctx.auth?.[node.field] ?? null) : ctx.auth

    case 'now':     return ctx._now

    case 'check':
      // For create: related row doesn't exist yet — conservatively allow
      // For post-update: related row not loaded — conservatively allow
      return true

    // The other half of the same sentence. `create` has no WHERE to put a CASE
    // in, so a ternary landing only in compileSql would be decided one way by
    // the reader and another by the writer — which is FJS-195 exactly.
    case 'ternary': return ev(node.cond) ? ev(node.then) : ev(node.else)

    case 'compare': {
      const { left, right, op } = node

      // Membership, the JS half of the same sentence. `create` has no WHERE to
      // put it in, and a form that lands in one compiler and not the other is
      // FJS-195 repeating: a row that create allows and read then hides.
      if (op === 'in') {
        const listOf = (n) => {
          if (n.type === 'list') return n.items
          const v = n.type === 'auth'  ? (n.field ? ctx.auth?.[n.field] : ctx.auth?.id)
                  : n.type === 'field' ? data?.[relationMap[modelName]?.[n.name]?.kind === 'belongsTo'
                                              ? relationMap[modelName][n.name].foreignKey : n.name]
                  : ev(n)
          // A create may carry the array as written; a row read back has been
          // deserialised. A column absent from the payload is not an empty
          // list — it is a column that was not set, and nothing is in it.
          if (Array.isArray(v)) return v
          if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } }
          return v == null ? [] : [v]
        }
        const needle = left.type === 'field'
          ? (data?.[relationMap[modelName]?.[left.name]?.kind === 'belongsTo'
              ? relationMap[modelName][left.name].foreignKey : left.name] ?? null)
          : ev(left)
        return listOf(right).includes(needle)
      }

      // auth() == null  /  auth() != null
      if (left.type === 'auth' && right.type === 'literal' && right.value === null) {
        const authVal = left.field ? (ctx.auth?.[left.field] ?? null) : ctx.auth
        return op === '==' ? authVal === null || authVal === undefined
                           : authVal !== null && authVal !== undefined
      }
      if (right.type === 'auth' && left.type === 'literal' && left.value === null) {
        const authVal = right.field ? (ctx.auth?.[right.field] ?? null) : ctx.auth
        return op === '==' ? authVal === null || authVal === undefined
                           : authVal !== null && authVal !== undefined
      }

      // field == auth() — check FK in data
      if (left.type === 'field' && right.type === 'auth' && right.field === null) {
        const rel = relationMap[modelName]?.[left.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : left.name
        const L   = data?.[fk] ?? null
        const R   = ctx.auth?.id ?? null
        return compare(L, op, R)
      }
      if (right.type === 'field' && left.type === 'auth' && left.field === null) {
        const rel = relationMap[modelName]?.[right.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : right.name
        const L   = ctx.auth?.id ?? null
        const R   = data?.[fk] ?? null
        return compare(L, op, R)
      }

      return compare(ev(left), op, ev(right))
    }

    default:
      return true   // unknown node — conservatively allow
  }
}

function compare(L, op, R) {
  switch (op) {
    case '==': return L === R
    case '!=': return L !== R
    case '<':  return L < R
    case '>':  return L > R
    case '<=': return L <= R
    case '>=': return L >= R
    default:   return true
  }
}
