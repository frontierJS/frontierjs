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
import { modelToTableName, sqlType } from './ddl.js'
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

// ─── What a claim is, decided at startup ─────────────────────────────────────
//
// A row identifier is refused by name; `auth().x` resolved against nothing, so
// a typo parsed clean, built clean, and then failed in OPPOSITE directions in
// the two interpreters — the SQL half's `NOT (NULL = 1)` excludes EVERYONE, the
// JS half's `null === true` excludes NO ONE. One misspelling is a lockout on
// read and an open door on create, and neither reads as a mistake (`FJS-666`).
//
// The set has four sources and no fifth is possible:
//
//   the fixed eight    names this package itself reads off the principal, so no
//                      app spells them: `id` (`auth()` bare IS the id),
//                      `capabilities` (the grid, `FJS-D151`), and the six
//                      `FrontierGateGetLevel` grades a caller by — `role`,
//                      `isAdmin`, `isOwner`, `isSystemAdmin`, `verifiedAt`,
//                      `activatedAt` (`src/plugins/gate.js`). A standing is not
//                      a column: an app whose ladder tops out at `isAdmin` has
//                      no such field on `User` and auth puts it on the session
//   the @@auth model   whatever an app puts on the session out of its own
//                      principal row — `isStaff`, `role`
//   tenancy { claim }  the one claim the schema itself declares
//   claims: [...]      a claim resolved PER REQUEST, which is on no row and in
//                      no schema — a cart token, an impersonation — and is
//                      therefore the one source that has to be stated
//
// The fourth is why this is a client option and not a `.lite` keyword: junction
// already declares that list (its `principal.snapshot.md` § Claims is generated
// from the resolver's own `describe()`), so the names come from the one place
// that has them rather than being restated in a second file that goes stale.
//
// It only grades when there IS a set — a schema declaring no `@@auth` and an
// app passing no `claims` have said nothing to compare against, and inventing a
// floor there would refuse `auth().isStaff` on every app in the world. That
// silence is announced once rather than assumed.

const FRAMEWORK_CLAIMS = [
  'id', 'capabilities',
  // The standing `FrontierGateGetLevel` reads, in declaration order. Kept here
  // rather than imported from the plugin because the plugin is optional and
  // this list is about what a schema may NAME, not about what is installed.
  'role', 'isAdmin', 'isOwner', 'isSystemAdmin', 'verifiedAt', 'activatedAt',
]

export function buildClaimSet(schema, declared = null) {
  const names     = new Map()
  const authModel = schema?.models?.find(m => (m.attributes ?? []).some(a => a.kind === 'auth')) ?? null
  const tenantClaim = schema?.tenancy?.claim ?? null

  for (const n of FRAMEWORK_CLAIMS) names.set(n, 'the framework')
  if (authModel) for (const f of authModel.fields ?? []) names.set(f.name, `@@auth ${authModel.name}`)
  if (tenantClaim) names.set(tenantClaim, 'tenancy')
  if (Array.isArray(declared)) for (const n of declared) names.set(n, 'declared')

  return {
    // Nothing to compare against unless the app said something. `claims: []` is
    // a statement — the principal carries the framework's two and nothing else —
    // where absent is silence, so the empty array is deliberately not falsy here.
    active: !!authModel || Array.isArray(declared),
    names,
    has:    (n) => names.has(n),
    list:   () => [...names].map(([n, src]) => (src === 'the framework' ? n : `${n} (${src})`)).sort(),
  }
}

// Every `auth().x` a schema names, for the one-line notice an inactive set owes.
export function authClaimsUsed(schema) {
  const used = new Set()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'auth' && n.field) used.add(n.field)
    for (const k of ['left', 'right', 'expr', 'cond', 'then', 'else']) if (n[k]) walk(n[k])
  }
  for (const model of schema?.models ?? []) {
    for (const a of model.attributes ?? [])
      if (a.kind === 'allow' || a.kind === 'deny' || a.kind === 'scope') walk(a.expr)
    for (const f of model.fields ?? [])
      for (const a of f.attributes ?? []) if (a.kind === 'fieldAllow') walk(a.expr)
  }
  return used
}

// ─── `in` is checked against the schema, once, at startup ─────────────────────
//
// A policy compiles into a WHERE, so a wrong one is an empty screen with a 200
// rather than an error — the failure mode `@@allow` has by design. Everything
// decidable from the schema is therefore decided here, where the answer is a
// refusal naming the model and the expression, and not on a query nobody has
// run yet.
function checkExpr(model, expr, relationMap, what = '@@allow/@@deny', claims = null) {
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
    // The same sentence about the OTHER side of the comparison. An absent claim
    // is `NULL` to the SQL compiler and `null` to the evaluator, and the two
    // read that opposite ways, so a misspelling is silently enforced backwards
    // depending on which verb asked (`FJS-666`).
    if (n.type === 'auth' && n.field && claims?.active && !claims.has(n.field)) {
      throw new Error(
        `${model.name}: '${n.field}' is not a claim the principal carries — in ${what} ` +
        `'${policyExprToString(expr)}'.\n` +
        `  Claims: ${claims.list().join(', ')}\n` +
        `  A claim resolved per request is declared with ` +
        `createClient({ claims: ['${n.field}'] }).`)
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
        if (f.attributes?.some(a => a.kind === 'transient'))
          bad(`'${n.name}' is @transient — the API accepts it and nothing stores it, so there is no column here`)
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

// Does this expression read the ROW, or only the caller?
//
// A field `@allow('read', auth().isAdmin)` has the same answer for every row in
// a result set, and it was being asked once per FIELD per ROW through the
// interpreter (`FJS-619`). Answering it once needs to know which predicates are
// row-independent, which is a property of the AST alone.
//
// **An ALLOW-LIST, and that is the whole of its safety.** A node kind not named
// here is assumed to read the row, so a kind the language grows later is
// evaluated per row — slower, and correct — where a deny-list would silently
// stop stripping a column the day it was added. `field` reads a column and
// `check` walks a relation FROM the row, so neither is listed.
//
// `now` is deliberately absent though it reads no row: a clock-dependent
// predicate hoisted across a result set would answer one instant for rows read
// at another, and the case is rare enough that paying per row for it is not
// worth a second staleness rule (`dependsOnClock` exists for the same reason
// one table along).
const ROW_FREE_NODES = new Set(['literal', 'auth', 'and', 'or', 'not', 'compare', 'ternary', 'list'])

export function referencesRow(node) {
  if (node == null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(referencesRow)
  if (!ROW_FREE_NODES.has(node.type)) return true
  for (const k in node) if (referencesRow(node[k])) return true
  return false
}

// ─── @@scope ──────────────────────────────────────────────────────────────────
// { modelName: { scopeName: expr } }. A name declared twice on one model is a
// schema error rather than a last-one-wins, because the two would be
// indistinguishable at the call site.

// Compile a predicate with no caller in scope, and hand back what it BOUND.
//
// An index predicate is the one place a bound parameter is fatal rather than
// ordinary. SQLite proves that a query implies a partial index at PREPARE time,
// so a predicate holding `?` can never be matched — and litestone binds every
// filter value, which means a caller restating the predicate binds it too.
// `params.length === 0` is therefore the whole of what makes a partial index
// reachable, and ASKING the compiler is what stops that rule drifting away from
// the emitter it is a statement about.
//
// `auth()` and `now()` need no case of their own: both push a parameter and are
// refused by the same count. A subquery — a relation hop, a check() — pushes
// none, so the caller looks for SELECT in the SQL instead.
export function compileStatic(node, modelName, schema, relationMap = new Map()) {
  const params = []
  const ctx    = { auth: null, _now: null, enc: {} }
  const sql    = compileSql(node, params, ctx, modelName, null, new Map(), schema, relationMap, new Set())
  return { sql, params }
}

export function buildScopeMap(schema, relationMap, claims = null) {
  const map = {}
  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'scope') continue
      map[model.name] ??= {}
      if (attr.name in map[model.name])
        throw new Error(`${model.name}: @@scope(${attr.name}, …) is declared twice — a name means one predicate`)
      // A scope minted from a `valueset`'s `where` holds SQL rather than an
      // expression, so there is no AST to check and nothing for `evalJs` to
      // read. It exists to give that narrowing a NAME a browser can send.
      if (attr.raw) { map[model.name][attr.name] = { __raw: attr.raw, mintedBy: attr.mintedBy }; continue }
      // Same startup check @@allow gets: a scope compiles into a WHERE, so a
      // wrong one is an empty screen with a 200.
      checkExpr(model, attr.expr, relationMap, `@@scope(${attr.name}, …)`, claims)
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
  // Minted from a `valueset`'s `where`. The SQL comes from the schema and the
  // NAME is what a caller sent — which is Invariant 8 exactly: the name is a key
  // looked up in this table and is never interpolated into anything.
  if (expr.__raw) return { _litestoneRaw: true, sql: expr.__raw, params: [] }

  const params = []
  const at     = atOneInstant(ctx)
  const sql    = compileSql(expr, params, at, modelName, 'read', policyMap ?? {}, schema, relationMap, new Set())
  return { _litestoneRaw: true, sql, params }
}

// ─── What a check() delegation reaches, decided once ─────────────────────────
//
// `buildFilterSql` runs per query, so the two things wrong with a delegation
// cannot be said there: a warning on the compiler's path is a warning on every
// call, and by then the fix is a schema edit nobody is in a position to make.
// Both are decided by the schema alone, so they are answerable at startup beside
// every other predicate-that-can-never-mean-what-it-says (FJS-636).
//
// **A cycle** — two models each delegating to the other — re-enters a model
// already on the path and compiles to '0', which is a whitelist that admits
// nothing. Failing closed is the right direction and it is not an answer: the
// author wrote *readable if its parent is* and got *only rows with no parent*,
// which is data-dependent and therefore looks like a filter working.
//
// **A target with no rules for the delegated operation** compiles to '1' — no
// restriction — which is correct where the target is genuinely open and is a
// hole where its protection lives somewhere a compiled predicate cannot see it.
// A `@@gate` is enforced in the plugin tier and a capability grid beside it, so
// `check(vault)` at a `@@gate("7")` vault carries none of that 7 onto the child.
//
// Facts only. The two callers word their own sentence, because a refusal and a
// warning do not say the same thing about the same shape.
export function delegationProblems(policyMap, schema, relationMap) {
  const cycles   = []
  const gateOnly = []
  const seenCycle = new Set()
  const seenGate  = new Set()

  const checksIn = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) checksIn(n, out); return out }
    if (node.type === 'check') { out.push(node); return out }
    for (const v of Object.values(node)) checksIn(v, out)
    return out
  }

  const protectionOf = (name) => {
    const m = schema.models.find(x => x.name === name)
    const gate = m?.attributes?.some(a => a.kind === 'gate')
    const caps = m?.attributes?.some(a => a.kind === 'capabilities')
    return gate && caps ? 'a @@gate and a capability grid' : gate ? 'a @@gate' : caps ? 'a capability grid' : null
  }

  // The path bounds depth at one entry per model, so this terminates; the budget
  // is a backstop against a schema whose branching is pathological, and running
  // out means reporting nothing rather than half of it — the runtime guard still
  // fails closed, so an unreported cycle is the behavior that shipped.
  let budget = 50_000

  const walk = (model, op, path, edges) => {
    if (budget-- <= 0) return
    const bucket = policyMap[model]?.[op]
    if (!bucket) return

    for (const rule of [...bucket.allows, ...bucket.denies]) {
      for (const node of checksIn(rule.expr)) {
        const rel = relationMap[model]?.[node.field]
        // A check() over anything but a to-one relation is refused by checkExpr.
        if (!rel || rel.kind !== 'belongsTo') continue

        const target   = rel.targetModel
        const targetOp = node.operation ?? op
        const edge     = { model, op, field: node.field, target, targetOp }

        // The runtime guard tests the MODEL and not the (model, op) pair, so a
        // re-entry under a different operation is the same '0'. Detect it the
        // way it is enforced, or the sentence describes a cycle the compiler
        // does not take.
        if (path.has(target)) {
          // Keyed by the loop's MEMBERS, so the same circle reached from three
          // different starting models is reported once.
          const members = [...path].slice([...path].indexOf(target))
          const key = [...new Set(members)].sort().join('|')
          if (!seenCycle.has(key)) { seenCycle.add(key); cycles.push({ edges: [...edges, edge], back: target }) }
          continue
        }

        if (!policyMap[target]?.[targetOp]) {
          const by = protectionOf(target)
          if (by) {
            const key = `${model}|${op}|${node.field}|${targetOp}`
            if (!seenGate.has(key)) { seenGate.add(key); gateOnly.push({ ...edge, protectedBy: by }) }
          }
          continue
        }

        walk(target, targetOp, new Set([...path, target]), [...edges, edge])
      }
    }
  }

  for (const model of Object.keys(policyMap))
    for (const op of Object.keys(policyMap[model]))
      walk(model, op, new Set([model]), [])

  return { cycles, gateOnly }
}

// ─── A field policy is checked by the same walk ──────────────────────────────
//
// `@@allow` and `@@scope` refuse a name that is not a column; a FIELD `@allow`
// was checked by nothing, and it is the same expression language compiled by
// the same compiler (`FJS-D129`). A typo'd column there does not throw and does
// not leak — it strips the column from every row, which reads as the policy
// working strictly, so the schema, the build and every test on the refused side
// agree with the mistake (`FJS-667`).
//
// Separate from `buildFieldPolicyMap`, which is in `schema-maps.js` and is a
// pure schema→shape function with no relation map and no claim set. This is the
// judgement, and it belongs beside the other two.
export function checkFieldPolicies(schema, relationMap, claims = null) {
  for (const model of schema.models ?? []) {
    for (const field of model.fields ?? []) {
      for (const attr of field.attributes ?? []) {
        if (attr.kind !== 'fieldAllow') continue
        const ops = (attr.operations ?? []).map(o => `'${o}'`).join(', ')
        checkExpr(model, attr.expr, relationMap, `@allow(${ops}, …) on ${model.name}.${field.name}`, claims)
      }
    }
  }
}

export function buildPolicyMap(schema, relationMap, claims = null) {
  const map = {}

  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'allow' && attr.kind !== 'deny') continue
      checkExpr(model, attr.expr, relationMap, '@@allow/@@deny', claims)
      if (!map[model.name]) map[model.name] = {}
      const bucket = map[model.name]

      for (const op of attr.operations) {
        if (!bucket[op]) bucket[op] = { allows: [], denies: [] }
        const entry = { expr: attr.expr, message: attr.message ?? null, generated: attr.generated ?? null, claim: attr.claim ?? null }
        if (attr.kind === 'allow') bucket[op].allows.push(entry)
        else                       bucket[op].denies.push(entry)
      }
    }
  }

  return map
}

// ─── Public entry points ──────────────────────────────────────────────────────

// ─── Which rules apply to this caller ────────────────────────────────────────
//
// The ONE answer, because three callers ask it and one of them recurses: the
// SQL builder, the JS evaluator, and the builder again through a `check()`
// delegation. Written at each call site instead, a model reached through a
// delegation would be graded by a different rule than the one it was reached
// from.
//
// `asSystem()` means NO PERMISSION RULES. It does not mean no scope, and the
// difference is FJS-519: row tenancy desugars to `@@deny`, which is a policy, so
// a system context read every tenant's rows — and since a `@@gate("8")` model
// can be read by nothing else, the only client that could read a credential was
// the one that ignored tenancy.
//
// So a system context keeps exactly the denies tenancy generated, and only
// while a tenant is IN SCOPE. With no principal there is no tenant to keep and
// the generated predicate would deny everything, its first branch being
// `auth().<claim> == null` — so the null check is the rule rather than a guard
// on it: a migration, a seed and any job with no caller read everything, as
// before.
function rulesFor(policyMap, modelName, op, ctx) {
  const rules = policyMap?.[modelName]?.[op]
  if (!rules) return null
  if (!ctx.isSystem) return rules

  const denies = rules.denies.filter(d => d.generated === 'tenancy' && ctx.auth?.[d.claim] != null)
  return denies.length ? { allows: [], denies } : null
}

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

// ─── A FIELD's predicate, as SQL ──────────────────────────────────────────────
//
// `@allow('read'|'write', …)` on a FIELD is a predicate, and `FJS-D129` rules
// that it is answered where the row is — the database — rather than in JS
// against whatever the caller sent. Two callers and two positions:
//
//   read   AND-ed into the query's top-level WHERE, so a row whose column this
//          caller may not read cannot be distinguished by filtering or sorting
//          on it (`FJS-442`)
//   write  the WHEN of a `CASE WHEN <pred> THEN ? ELSE col END` in a SET, so
//          the predicate reads the STORED row and a bulk update grades every
//          row separately (`FJS-433`)
//
// Several `@allow`s on one field are OR-ed, which is how allows compose
// everywhere else. Returns null when there is nothing to apply — no predicate,
// or a system context, which bypasses field policy exactly as it bypasses a
// row one.
export function compileFieldPredicate(modelName, exprs, op, ctx, policyMap, schema, relationMap) {
  if (!exprs?.length) return null
  ctx = atOneInstant(ctx)
  if (ctx.isSystem) return null

  const params = []
  const parts  = exprs.map(expr =>
    compileSql(expr, params, ctx, modelName, op, policyMap ?? {}, schema, relationMap, new Set()))
    .filter(Boolean)

  if (!parts.length) return null
  return { sql: parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`, params }
}

export function buildPolicyFilter(modelName, op, ctx, policyMap, schema, relationMap) {
  ctx = atOneInstant(ctx)
  if (!rulesFor(policyMap, modelName, op, ctx)) {
    if (ctx.policyDebug === 'verbose')
      plog(ctx, op, modelName, ctx.isSystem ? '[2mskipped (asSystem)[0m' : '[2mno policy[0m')
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

/**
 * Does this policy admit this row, evaluated in JS — `{ ok }`, plus the
 * refusing rule's own message where it has one.
 *
 * **The one answer to that question**, because there are now three callers and
 * two of them are the boundary. `create` and `post-update` are checks — they
 * throw, and the row is refused or the write rolled back. `transitions()` is an
 * AFFORDANCE — it needs the same verdict and must not throw, because it is
 * answering *which buttons should this screen draw* (`FJS-495`). Written as two
 * copies they agreed for a while and then would not: deny-before-allow, an
 * empty `allows` meaning *no opinion* rather than *nobody*, and `asSystem()`
 * skipping outright are three rules, and a screen getting any of them wrong
 * offers a move the boundary refuses or hides one it allows.
 *
 * **It does not catch.** `evalJs` throws on a `check()` over a relation that is
 * not to-one, and at the boundary an undecidable policy must refuse rather than
 * pass — so the throw belongs to the caller. The affordance catches it and
 * answers permissively, which is what every other `x-*` affordance does and is
 * exactly the decision this function must not make on anyone's behalf.
 */
export function policyVerdict(modelName, row, ctx, policyMap, relationMap, op) {
  ctx = atOneInstant(ctx)
  const rules = rulesFor(policyMap, modelName, op, ctx)
  if (!rules) {
    if (ctx.policyDebug === 'verbose')
      plog(ctx, op, modelName, ctx.isSystem ? '[2mskipped (asSystem)[0m' : '[2mno policy[0m')
    return { ok: true }
  }

  const { allows, denies } = rules

  // Deny first — an explicit deny wins over every allow beside it.
  for (const { expr, message } of denies) {
    if (denyFires(evalJs(expr, ctx, row, modelName, policyMap, relationMap, op)))
      return { ok: false, message, rule: 'deny' }
  }

  // An allow list is a whitelist ONLY once it is non-empty. A model with denies
  // and no allows admits everything the denies did not name.
  if (allows.length && !allows.some(({ expr }) => allowHolds(evalJs(expr, ctx, row, modelName, policyMap, relationMap, op))))
    return { ok: false, message: allows.find(({ message }) => message)?.message, rule: 'allow' }

  if (ctx.policyDebug === 'verbose') plog(ctx, op, modelName, '[32mallowed[0m')
  return { ok: true }
}

// Throws AccessDeniedError if the create policy denies the operation.
// Evaluates purely in JS against the data being created (no SQL — INSERT has no WHERE).
export function checkCreatePolicy(modelName, data, ctx, policyMap, schema, relationMap) {
  const v = policyVerdict(modelName, data, ctx, policyMap, relationMap, 'create')
  if (v.ok) return
  plog(ctx, 'create', modelName, `[31mDENIED[0m (${v.rule === 'deny' ? '@@deny fired' : 'no @@allow passed'})`)
  throw new AccessDeniedError(
    v.message ?? `Create denied by @@${v.rule} policy on "${modelName}"`,
    { model: modelName, operation: 'create' })
}

// Evaluates a post-update policy against a row object in JS.
// Call after the write, inside a transaction — throw to trigger rollback.
export function checkPostUpdatePolicy(modelName, row, ctx, policyMap, schema, relationMap) {
  const v = policyVerdict(modelName, row, ctx, policyMap, relationMap, 'post-update')
  if (v.ok) return
  plog(ctx, 'post-update', modelName, `[31mDENIED[0m (${v.rule === 'deny' ? '@@deny fired' : 'no @@allow passed'}) — rolling back`)
  throw new AccessDeniedError(
    v.message ?? `Update denied by @@${v.rule} post-update policy on "${modelName}"`,
    { model: modelName, operation: 'post-update' })
}

// ─── SQL compiler ─────────────────────────────────────────────────────────────

function buildFilterSql(modelName, op, params, ctx, policyMap, schema, relationMap, visited) {
  // Cycle guard. Two models each holding `@@allow('read', check(other))` are
  // deny-by-default whitelists on both sides, and re-entry compiling to '1' made
  // that pair readable by a stranger — measured. There is no sound answer to a
  // cycle, so it takes the direction every other refusal here takes; a chain
  // (A → B → C) never reaches this line.
  //
  // `delegationProblems` refuses the same shape at startup, so nothing reaching
  // here got past createClient — this is the floor under a policyMap assembled
  // some other way, and it is what makes the guard's direction (deny) the one
  // the refusal describes.
  if (visited.has(modelName)) return '0'
  const next = new Set([...visited, modelName])

  const rules = rulesFor(policyMap, modelName, op, ctx)
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

      // The correlation names the OUTER TABLE, and a table name is not a model
      // name: `model LogLine` is table `log_line`, so `"LogLine"."deployId"` is
      // `no such column`. Single-word models hid it — `Deploy` matches `deploy`
      // because SQLite compares identifiers case-insensitively (FJS-333).
      const selfDef   = schema.models.find(m => m.name === modelName)
      const selfTable = selfDef ? modelToTableName(selfDef, false) : modelName

      // An ABSENT foreign key allows, in SQL exactly as it does in JS. Without
      // the guard the EXISTS is simply false for a null column, so a delegated
      // child with an OPTIONAL parent — a dashboard widget with no server, a
      // note on no document — was invisible to every scoped read while
      // `evalCheck` allowed the same row on write. Two implementations of one
      // rule, disagreeing, and `verifyRowPolicies` skips a `check()` policy by
      // name, so the net that grades the other rules could not see this one.
      return `("${selfTable}"."${rel.foreignKey}" IS NULL OR EXISTS (SELECT 1 FROM "${targetTable}" WHERE "${targetTable}"."${rel.referencedKey}" = "${selfTable}"."${rel.foreignKey}" AND (${subSql})))`
    }

    default:
      throw new Error(`Unknown policy AST node type: ${node.type}`)
  }
}

// ─── check() outside a WHERE ─────────────────────────────────────────────────
//
// `check(parent)` delegates to another model's policy. In a WHERE it compiles to
// a correlated EXISTS, which is exact. In the JS evaluator — create, and
// post-update — there is no WHERE to correlate against, so it used to answer
// `true` conservatively: the rule held for read, update and delete and permitted
// a cross-tenant CREATE in silence. Half-enforcement in the one feature whose
// whole job is enforcement, and the reason tenancy could not generate a rule for
// a model scoped only through its parent (FJS-282).
//
// So the row is looked up. The foreign key is in the data being written, the
// target's own filter is what `buildFilterSql` already builds for the WHERE, and
// bun:sqlite is synchronous — the same SQL, run uncorrelated:
//
//   SELECT 1 FROM "<target>" WHERE "<referencedKey>" = ? AND (<target policy>) LIMIT 1
//
// Reads go through `ctx.readDb`, which routes to the write connection while a
// transaction is open — a create inside one has to see rows that transaction
// wrote, or a parent and child created together would deny the child.
//
// An ABSENT foreign key allows. On create it is the same answer the tenant
// column gets: the stamp has not run, and a row naming no parent is not a row
// naming somebody else's. SQLite refuses it afterwards if the column is
// required, which is the check that belongs to the column rather than to a
// policy.
function evalCheck(node, ctx, data, modelName, policyMap, relationMap, op) {
  const rel = relationMap?.[modelName]?.[node.field]
  // Same refusal compileSql makes, so the two halves cannot disagree about what
  // check() accepts.
  if (!rel || rel.kind !== 'belongsTo')
    throw new Error(`check(${node.field}): only to-one (belongsTo) relations are supported in policy expressions`)

  const fk = data?.[rel.foreignKey]
  if (fk == null) return true

  const schema = ctx.schema
  const db     = ctx.readDb
  // No schema and no connection is a caller evaluating a policy outside a
  // client — the old conservative answer is the only one available there.
  if (!schema || !db?.query) return true

  const targetDef = schema.models.find(m => m.name === rel.targetModel)
  if (!targetDef) return true
  const targetTable = modelToTableName(targetDef, false)

  const checkOp = node.operation ?? op ?? 'read'
  const params  = []
  const subSql  = buildFilterSql(rel.targetModel, checkOp, params, ctx, policyMap, schema, relationMap, new Set([modelName]))
  if (!subSql) return true   // target has no policy — allow, as compileSql does

  const sql = `SELECT 1 FROM "${targetTable}" WHERE "${targetTable}"."${rel.referencedKey}" = ? AND (${subSql}) LIMIT 1`
  const hit = db.query(sql).get(fk, ...params)
  if (ctx.policyDebug === 'verbose')
    plog(ctx, checkOp, modelName, `\x1b[2mcheck(${node.field}) → ${hit ? 'allowed' : 'denied'}\x1b[0m`, `(${sql})`)
  return !!hit
}

// ─── JS evaluator (create + post-update) ──────────────────────────────────────
// Evaluates a policy expression against a data/row object in JavaScript.
// Used when there's no WHERE clause available (create) or for post-update checks.

// ─── SQL's three values, in the interpreter that has only two ────────────────
//
// The SQL half and the JS half are one policy language and they disagreed about
// ONE value: absent. `NULL = 1` is NULL, `NOT (NULL)` is NULL, and a WHERE that
// is NULL keeps no row — so a deny naming a claim the caller does not carry
// DENIES on read, update and delete. In JS the same expression was `null ===
// true`, which is `false`, so the deny did not fire and create allowed it
// (`FJS-668`). Same rule, same caller, opposite answers, decided by which verb
// asked — which is `FJS-195`'s shape and is why the two halves are one language.
//
// So `null` propagates here the way it does in SQLite, and the verdict asks for
// TRUE rather than for truthiness. It is not the typo case — that is refused at
// startup now — it is the ordinary one: an anonymous caller, or a claim a
// resolver only sets on some requests.
//
// `truth()` and not `Boolean()` at the edges: the language admits a predicate
// that is not a boolean (`@@allow('read', auth())`), and SQLite coerces those
// the same way, so only NULL is special.
const truth = (v) => (v === null || v === undefined ? null : Boolean(v))

const and3 = (l, r) => (l === false || r === false ? false : l === null || r === null ? null : true)
const or3  = (l, r) => (l === true  || r === true  ? true  : l === null || r === null ? null : false)
const not3 = (v)    => (v === null ? null : !v)

// Does this rule fire? An ALLOW is a whitelist and only TRUE admits; a DENY
// excludes on TRUE and on UNKNOWN alike, because `AND NOT (NULL)` keeps no row.
export const allowHolds = (v) => truth(v) === true
export const denyFires  = (v) => truth(v) !== false

export function evalJs(node, ctx, data, modelName, policyMap, relationMap, op = null) {
  const ev = n => evalJs(n, ctx, data, modelName, policyMap, relationMap, op)

  switch (node.type) {
    // Both sides are evaluated: `FALSE AND NULL` is FALSE and `TRUE OR NULL` is
    // TRUE, so a short circuit would be right, but `NULL AND FALSE` is FALSE and
    // `NULL OR TRUE` is TRUE, so it would be wrong the other way round. The
    // language has no side effects, which is what makes evaluating both free.
    case 'or':      return or3(truth(ev(node.left)), truth(ev(node.right)))
    case 'and':     return and3(truth(ev(node.left)), truth(ev(node.right)))
    case 'not':     return not3(truth(ev(node.expr)))

    case 'literal': return node.value

    case 'field':   return data?.[node.name] ?? null

    case 'auth':
      return node.field ? (ctx.auth?.[node.field] ?? null) : ctx.auth

    case 'now':     return ctx._now

    case 'check':
      return evalCheck(node, ctx, data, modelName, policyMap, relationMap, op)

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
        // `NULL IN (…)` is NULL in SQL, never false — the value is unknown, so
        // whether it is in the list is unknown.
        if (needle === null || needle === undefined) return null
        // Membership is equality repeated, so it takes the same affinity — the
        // left operand's, applied to each element, which is what makes
        // `qty in ['5']` over an Int column TRUE the way the WHERE says it is.
        // A NULL in the list is UNKNOWN rather than a miss, for the same reason
        // an absent operand is.
        const affNeedle = affinityOf(left, ctx, modelName, relationMap)
        let unknown = false
        for (const item of listOf(right)) {
          const hit = compare(needle, '==', item, affNeedle, null)
          if (hit === true) return true
          if (hit === null) unknown = true
        }
        return unknown ? null : false
      }

      // `x == null` is how this language spells `IS NULL`, and it is the one
      // comparison that answers a BOOLEAN over an absent value rather than
      // UNKNOWN — in SQL too, which is why SQL has a second spelling for it.
      // Without this branch the presence test propagates its own subject and
      // there is no way to write "the caller carries no such claim" at all.
      // It reads a FIELD as well as a claim: `ownerId == null` compiles to
      // `ownerId IS NULL`, and the two halves have to agree about that.
      const nullTest = (probe, other) =>
        other.type === 'literal' && other.value === null ? probe : null
      const probe = nullTest(left, right) ?? nullTest(right, left)
      if (probe) {
        const v = probe.type === 'auth'
          ? (probe.field ? (ctx.auth?.[probe.field] ?? null) : ctx.auth)
          : ev(probe)
        const absent = v === null || v === undefined
        return op === '==' ? absent : !absent
      }

      // field == auth() — check FK in data
      if (left.type === 'field' && right.type === 'auth' && right.field === null) {
        const rel = relationMap[modelName]?.[left.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : left.name
        const L   = data?.[fk] ?? null
        const R   = ctx.auth?.id ?? null
        return compare(L, op, R, affinityOf(left, ctx, modelName, relationMap), null)
      }
      if (right.type === 'field' && left.type === 'auth' && left.field === null) {
        const rel = relationMap[modelName]?.[right.name]
        const fk  = rel?.kind === 'belongsTo' ? rel.foreignKey : right.name
        const L   = ctx.auth?.id ?? null
        const R   = data?.[fk] ?? null
        return compare(L, op, R, null, affinityOf(right, ctx, modelName, relationMap))
      }

      return compare(ev(left), op, ev(right),
        affinityOf(left,  ctx, modelName, relationMap),
        affinityOf(right, ctx, modelName, relationMap))
    }

    // The SQL compiler throws on a node it does not know; this answered `true`
    // and called it conservative. It is the opposite: the two halves compile ONE
    // language, and the ops they cover are disjoint — read/update/delete go to
    // SQL, create and post-update come here — so a node added to the grammar and
    // to the SQL half alone does not fail, it makes every CREATE policy holding
    // it a silent no-op. That is the shape `check()` already cost once (FJS-282,
    // a cross-tenant create permitted in silence) and the floor it was fixed on
    // top of stayed. Refuse, so the gap arrives as the same error from either
    // half (`FJS-635`).
    default:
      throw new Error(`Unknown policy AST node type: ${node.type}`)
  }
}

// ─── SQLite's comparison, in the interpreter that has JavaScript's ───────────
//
// The second value the two halves disagreed about, after `FJS-668`'s absent
// one. SQLite applies the COLUMN's affinity to the other operand before
// comparing and then orders by storage class; JS `===` does neither. So
// `ownerId == auth().id` over an `Int` column and a caller whose id is the
// string `'5'` — which is every junction principal, since a `SessionContext`
// carries `userId` as text — is TRUE through a query and FALSE here: the owner
// reads their own row over HTTP and is then graded out of the broadcast for it
// (`FJS-713`). Measured across column type × operator × operand, 54 of 594
// cells disagreed, in both directions and on every operator.
//
// Affinity is the whole of why `toDataPrincipal` coercing one claim is not the
// fix: it closes four of those cells and leaves fifty.

// A JS value as SQLite would STORE it — the binder's own conversions, since
// that is what the SQL half is comparing against.
const toStorage = (v) => {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date)      return v.toISOString()
  return v
}

// NUMERIC affinity converts TEXT only when it is a well-formed number, and
// leaves it TEXT otherwise — which is what makes `qty < 'abc'` TRUE rather than
// unknown. `Number` is wider than SQLite here (hex, `Infinity`), so the shapes
// SQLite refuses are excluded rather than inherited.
const toNumeric = (v) => {
  if (typeof v !== 'string') return v
  if (!/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}
const toText = (v) => (typeof v === 'number' ? String(v) : v)

// The affinity of one side of a comparison. A literal and a claim have none —
// they are the parameter — so this only ever answers for a column.
function affinityOf(node, ctx, modelName, relationMap) {
  if (node?.type !== 'field') return null
  const rel = relationMap?.[modelName]?.[node.name]
  const col = rel?.kind === 'belongsTo' ? rel.foreignKey : node.name
  // A client builds the map once; a caller evaluating a policy outside one —
  // `testing.js` imports this function — falls back to the scan rather than to
  // no affinity, or the two entry points would answer differently.
  const mapped = ctx?.affinityMap?.[modelName]
  if (mapped) return mapped[col] ?? null
  const f = ctx?.schema?.models?.find(m => m.name === modelName)?.fields?.find(x => x.name === col)
  if (!f?.type) return null
  const t = sqlType(f.type)
  return t === 'INTEGER' || t === 'REAL' ? 'NUMERIC' : t === 'BLOB' ? 'BLOB' : 'TEXT'
}

function compare(L, op, R, affL = null, affR = null) {
  // Every comparison with an absent operand is UNKNOWN, `IS NULL` included —
  // which is why `auth().x == null` has its own branch above rather than
  // reaching here: that one is a presence test and this one is a comparison.
  if (L === null || L === undefined || R === null || R === undefined) return null

  L = toStorage(L)
  R = toStorage(R)

  // SQLite's own rules, in its own order (§4.2 Affinity Of Comparison
  // Operands): numeric affinity on one side pulls the other to a number, text
  // affinity pushes an unaffinitied operand to text, and nothing else applies.
  if      (affL === 'NUMERIC' && affR !== 'NUMERIC') R = toNumeric(R)
  else if (affR === 'NUMERIC' && affL !== 'NUMERIC') L = toNumeric(L)
  else if (affL === 'TEXT'    && affR === null)      R = toText(R)
  else if (affR === 'TEXT'    && affL === null)      L = toText(L)

  // Anything that is not a number or a string after that is a value this
  // comparison has no storage class for — a Bytes column, a Json document.
  // Those keep JavaScript's answer rather than being given a wrong one: two
  // distinct Buffers rank equal under a class comparison, which would make
  // `==` TRUE for them.
  const rank = (v) => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 0)
  const rl = rank(L), rr = rank(R)
  if (!rl || !rr) {
    switch (op) {
      case '==': return L === R
      case '!=': return L !== R
      case '<':  return L < R
      case '>':  return L > R
      case '<=': return L <= R
      case '>=': return L >= R
      default:   throw new Error(`Unknown policy comparison operator: ${op}`)
    }
  }

  // NULL < INTEGER/REAL < TEXT < BLOB, and within a class by value. Text is
  // compared with JS `<`, which is UTF-16 code-unit order where SQLite's BINARY
  // collation is UTF-8 byte order — the two agree below U+10000 and not above.
  const c = rl !== rr ? (rl < rr ? -1 : 1) : L < R ? -1 : L > R ? 1 : 0
  switch (op) {
    case '==': return c === 0
    case '!=': return c !== 0
    case '<':  return c < 0
    case '>':  return c > 0
    case '<=': return c <= 0
    case '>=': return c >= 0
    default:   throw new Error(`Unknown policy comparison operator: ${op}`)
  }
}
