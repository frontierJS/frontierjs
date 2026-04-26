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

import { AccessDeniedError } from './plugin.js'
import { modelToTableName }  from './ddl.js'

// ─── Debug logger ─────────────────────────────────────────────────────────────
// policyDebug: true     — logs SQL filters + denials
// policyDebug: 'verbose' — also logs passes + asSystem bypasses

function plog(ctx, op, model, msg, extra = '') {
  if (!ctx.policyDebug) return
  const tag = `[36m[litestone:policy][0m`
  console.log(`${tag} ${op.padEnd(12)} "${model}"  ${msg}${extra ? `  ${extra}` : ''}`)
}

// ─── Build policy map ─────────────────────────────────────────────────────────
// { modelName: { 'read': { allows: [expr,...], denies: [expr,...] }, ... } }

const ALL_OPS = ['read', 'create', 'update', 'post-update', 'delete']

export function buildPolicyMap(schema) {
  const map = {}

  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'allow' && attr.kind !== 'deny') continue
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
export function buildPolicyFilter(modelName, op, ctx, policyMap, schema, relationMap) {
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

  plog(ctx, op, modelName,
    `[33m→ WHERE[0m (${sql})`,
    params.length ? `[2m[${params.map(p => JSON.stringify(p)).join(', ')}][0m` : ''
  )
  return { sql, params }
}

// Throws AccessDeniedError if the create policy denies the operation.
// Evaluates purely in JS against the data being created (no SQL — INSERT has no WHERE).
export function checkCreatePolicy(modelName, data, ctx, policyMap, schema, relationMap) {
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
      params.push(new Date().toISOString())
      return '?'

    case 'compare': {
      const { left, right } = node

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

    case 'now':     return new Date().toISOString()

    case 'check':
      // For create: related row doesn't exist yet — conservatively allow
      // For post-update: related row not loaded — conservatively allow
      return true

    case 'compare': {
      const { left, right, op } = node

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
