import { introspectSQL, buildFKGraph, execute, maskStrategies, parseLimit, resolveRowCount, resolveAllRowCounts, resolveRedactColumns } from './framework.js'

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
  magenta: '\x1b[35m',
}

const bold     = s => `${c.bold}${s}${c.reset}`
const dim      = s => `${c.dim}${s}${c.reset}`
const tbl      = s => `${c.bold}${c.cyan}${s}${c.reset}`
const col      = s => `${c.yellow}${s}${c.reset}`
const rowCount = (before, after) => {
  const afterStr = before !== after
    ? `${c.bold}${c.green}${after}${c.reset}`
    : `${c.dim}${after}${c.reset}`
  return `${c.dim}${before}${c.reset} ${c.gray}→${c.reset} ${afterStr} ${c.dim}rows${c.reset}`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const queryRows = (db, tableName) =>
  db.query(`SELECT * FROM "${tableName}"`).all()

function rebuildTable(db, tableName, rows, columns, foreignKeys = []) {
  // Read indexes before we drop the table — filter out any that reference dropped columns
  const existingColNames = new Set(columns.map(c => c.name))
  const indexes = db.query(
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
  ).all(tableName).filter(idx => {
    // Parse column names from index SQL: CREATE [UNIQUE] INDEX name ON table(col1, col2)
    const match = idx.sql.match(/\(([^)]+)\)/)
    if (!match) return false
    const idxCols = match[1].split(',').map(c => c.trim().replace(/^["'`]|["'`]$/g, ''))
    return idxCols.every(c => existingColNames.has(c))
  })

  const colDefs = columns.map(col => {
    let def = `"${col.name}" ${col.type || 'TEXT'}`
    if (col.pk)              def += ' PRIMARY KEY'
    if (col.notnull)         def += ' NOT NULL'
    if (col.default != null) def += ` DEFAULT ${col.default}`
    return def
  })

  const fkDefs = foreignKeys
    .filter(fk => existingColNames.has(fk.from))
    .map(fk => `FOREIGN KEY ("${fk.from}") REFERENCES "${fk.table}"("${fk.to}")`)

  const allDefs = [...colDefs, ...fkDefs].join(', ')

  db.run(`DROP TABLE IF EXISTS "${tableName}__new"`)
  db.run(`CREATE TABLE "${tableName}__new" (${allDefs})`)

  if (rows.length > 0) {
    const colNames     = columns.map(c => c.name)
    const cols         = colNames.map(n => `"${n}"`).join(', ')
    const placeholders = colNames.map(() => '?').join(', ')
    const stmt         = db.prepare(`INSERT INTO "${tableName}__new" (${cols}) VALUES (${placeholders})`)
    for (const row of rows) stmt.run(...colNames.map(n => row[n] ?? null))
  }

  db.run(`DROP TABLE "${tableName}"`)
  db.run(`ALTER TABLE "${tableName}__new" RENAME TO "${tableName}"`)

  // Recreate surviving indexes on the renamed table
  for (const idx of indexes) {
    try {
      db.run(idx.sql)
    } catch (e) {
      // Unique constraint can fail if transforms created duplicate values — warn and skip
      console.warn(`⚠️  Dropped index "${idx.name}" — would violate constraint after transform (${e.message})`)
    }
  }
}

// ─── Scope resolution ────────────────────────────────────────────────────────

// ─── SQL rebuild helper ───────────────────────────────────────────────────────

function rebuildTableSQL(db, tableName, where) {
  const before = db.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get().n

  // Read indexes before drop
  const indexes = db.query(
    `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
  ).all(tableName)

  // Read original DDL to preserve FK constraints and column types
  const { sql } = db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName)
  const newSql  = sql.replace(
    /CREATE TABLE ["']?[\w]+["']?/i,
    `CREATE TABLE "${tableName}__new"`
  )

  db.run(`DROP TABLE IF EXISTS "${tableName}__new"`)
  db.run(newSql)
  db.run(`INSERT INTO "${tableName}__new" SELECT * FROM "${tableName}" WHERE ${where}`)
  db.run(`DROP TABLE "${tableName}"`)
  db.run(`ALTER TABLE "${tableName}__new" RENAME TO "${tableName}"`)

  // Recreate indexes — skip any that would violate unique constraints after filtering
  for (const idx of indexes) {
    try {
      db.run(idx.sql)
    } catch (e) {
      console.warn(`⚠️  Dropped index "${idx.name}" — would violate constraint after transform (${e.message})`)
    }
  }

  const after = db.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get().n
  return { before, after }
}

// ─── Scope resolution ────────────────────────────────────────────────────────

function resolveScope(db, scopeStep, schema, fkGraph) {
  const { tableName, fn, cascade } = scopeStep
  const isSql = typeof fn === 'string'

  if (isSql) {
    // ── Fast path: pure SQL ────────────────────────────────────────────────
    const { before, after } = rebuildTableSQL(db, tableName, fn)
    log(`   🎯 ${tbl(tableName)}  ${rowCount(before, after)}  ${dim('sql')}`)

    if (!cascade) return

    // Cascade via subqueries using actual FK column references (not hardcoded 'id')
    const visited = new Set([tableName])
    const queue   = [tableName]

    while (queue.length) {
      const parentTable = queue.shift()

      for (const childTable of fkGraph[parentTable] ?? []) {
        if (visited.has(childTable)) continue
        visited.add(childTable)

        const fks = schema[childTable].foreignKeys.filter(fk => fk.table === parentTable)
        if (!fks.length) continue

        const fk = fks[0]
        let where
        if (fk.composite) {
          // (col_a, col_b) IN (SELECT to_a, to_b FROM parent)
          const fromCols = fk.from.map(c => `"${c}"`).join(', ')
          const toCols   = fk.to.map(c => `"${c}"`).join(', ')
          where = `(${fromCols}) IN (SELECT ${toCols} FROM "${parentTable}")`
        } else {
          where = `"${fk.from}" IN (SELECT "${fk.to}" FROM "${parentTable}")`
        }

        const { before, after } = rebuildTableSQL(db, childTable, where)
        const viaLabel = fk.composite
          ? `via ${parentTable}.(${fk.from.join(',')})`
          : `via ${parentTable}.${fk.from}`
        log(`   ↳  ${tbl(childTable)}  ${rowCount(before, after)}  ${dim(viaLabel)}  ${dim('sql')}`)
        queue.push(childTable)
      }
    }

  } else {
    // ── JS path: arbitrary predicate function ──────────────────────────────
    const anchorRows = queryRows(db, tableName)
    const surviving  = anchorRows.filter(fn)

    // Build a set of surviving PK values using the actual referenced columns from child FKs
    // For composite PKs, key is a JSON string of the PK tuple
    const pkCols = schema[tableName].columns.filter(c => c.pk).map(c => c.name)
    const pkKey  = pkCols.length > 1
      ? (row) => JSON.stringify(pkCols.map(c => row[c]))
      : (row)  => row[pkCols[0] ?? 'id']
    const survivingKeys = new Set(surviving.map(pkKey))

    rebuildTable(db, tableName, surviving, schema[tableName].columns, schema[tableName].foreignKeys)
    log(`   🎯 ${tbl(tableName)}  ${rowCount(anchorRows.length, surviving.length)}`)

    if (!cascade) return

    const visited = new Set([tableName])
    const queue   = [{ parentTable: tableName, survivingKeys, pkKey }]

    while (queue.length) {
      const { parentTable, survivingKeys: parentKeys } = queue.shift()

      for (const childTable of fkGraph[parentTable] ?? []) {
        if (visited.has(childTable)) continue
        visited.add(childTable)

        const fks = schema[childTable].foreignKeys.filter(fk => fk.table === parentTable)
        if (!fks.length) continue

        const fk         = fks[0]
        const childRows  = queryRows(db, childTable)
        let   childSurviving

        if (fk.composite) {
          const childKey = (row) => JSON.stringify(fk.to.map((_, i) => row[fk.from[i]]))
          childSurviving = childRows.filter(r => parentKeys.has(childKey(r)))
        } else {
          childSurviving = childRows.filter(r => parentKeys.has(r[fk.from]))
        }

        // Build surviving keys for this child to propagate further down
        const childPkCols = schema[childTable].columns.filter(c => c.pk).map(c => c.name)
        const childPkKey  = childPkCols.length > 1
          ? (row) => JSON.stringify(childPkCols.map(c => row[c]))
          : (row)  => row[childPkCols[0] ?? 'id']
        const childKeys = new Set(childSurviving.map(childPkKey))

        rebuildTable(db, childTable, childSurviving, schema[childTable].columns, schema[childTable].foreignKeys)
        const viaLabel = fk.composite
          ? `via ${parentTable}.(${fk.from.join(',')})`
          : `via ${parentTable}.${fk.from}`
        log(`   ↳  ${tbl(childTable)}  ${rowCount(childRows.length, childSurviving.length)}  ${dim(viaLabel)}`)

        queue.push({ parentTable: childTable, survivingKeys: childKeys, pkKey: childPkKey })
      }
    }
  }
}

// ─── Op execution ────────────────────────────────────────────────────────────

function applyOpsToTable(db, tableName, ops, schema) {
  const tableSchema = schema[tableName]
  if (!tableSchema) return

  let columns = [...tableSchema.columns]
  let rows    = queryRows(db, tableName)

  for (const op of ops) {

    if (op._type === 'dropColumn') {
      if (!columns.find(c => c.name === op.name)) continue
      columns = columns.filter(c => c.name !== op.name)
      rows    = rows.map(({ [op.name]: _, ...rest }) => rest)
      log(`   🗑️  ${tbl(tableName)}.${col(op.name)}`)
    }

    else if (op._type === 'renameColumn') {
      columns = columns.map(c => c.name === op.from ? { ...c, name: op.to } : c)
      rows    = rows.map(({ [op.from]: val, ...rest }) => ({ ...rest, [op.to]: val }))
      log(`   ✏️  ${tbl(tableName)}.${col(op.from)} ${c.gray}→${c.reset} ${col(op.to)}`)
    }

    else if (op._type === 'keepColumns') {
      const dropped = columns.filter(c => !op.names.includes(c.name)).map(c => c.name)
      columns = columns.filter(c => op.names.includes(c.name))
      rows    = rows.map(r => Object.fromEntries(op.names.filter(n => n in r).map(n => [n, r[n]])))
      log(`   📌 ${tbl(tableName)}  ${c.green}keep [${op.names.join(', ')}]${c.reset}  ${c.red}drop [${dropped.join(', ')}]${c.reset}`)
    }

    else if (op._type === 'mask') {
      const fn = maskStrategies[op.strategy]
      rows = rows.map(r => ({ ...r, [op.name]: fn(r[op.name]) }))
      log(`   🎭 ${tbl(tableName)}.${col(op.name)}  ${c.magenta}${op.strategy}${c.reset}`)
    }

    else if (op._type === 'redactBlock') {
      const targets = resolveRedactColumns(op.mode, op.cfg).filter(n => columns.find(col => col.name === n))
      if (targets.length === 0) continue
      rows = rows.map(r => {
        const patched = { ...r }
        for (const n of targets) patched[n] = null
        return patched
      })
      const label = op.mode ? op.mode : 'SECRETS+PII'
      log(`   🔴 ${tbl(tableName)}  redact [${targets.join(', ')}]  ${c.magenta}${label}${c.reset}`)
    }

    else if (op._type === 'setField') {
      const isNew = !columns.find(c => c.name === op.name)
      if (isNew) {
        columns = [...columns, { name: op.name, type: 'TEXT', notnull: false, pk: false, default: null }]
        log(`   ➕ ${tbl(tableName)}.${col(op.name)}`)
      } else {
        log(`   ⚡ ${tbl(tableName)}.${col(op.name)}`)
      }
      rows = rows.map(r => ({ ...r, [op.name]: op.fn(r[op.name], r) }))
    }
  }

  rebuildTable(db, tableName, rows, columns, tableSchema.foreignKeys)
  tableSchema.columns = columns
}

// ─── Main runner ─────────────────────────────────────────────────────────────

let _verbose = false
let _logCollector = null   // when set, collects lines instead of printing
const log = msg => {
  if (_logCollector) { _logCollector.push(msg); return }
  if (_verbose) console.log(msg)
}

export function run(db, pipeline, { verbose = true, collectLogs = false } = {}) {
  _verbose = verbose
  const lines = collectLogs ? [] : null
  _logCollector = lines
  pipeline = pipeline.flatMap(s => s?._type === 'compound' ? s.steps : [s])
  const schema     = introspectSQL(db)
  const fkGraph    = buildFKGraph(schema)
  const tableNames = Object.keys(schema)

  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i]
    const t0   = performance.now()
    if (verbose || collectLogs)
      log(`\n${bold(`${c.white}Step ${i + 1}${c.reset}`)}  ${describeStep(step)}`)

    if (step._type === 'shard') continue  // marker only — handled by execute()

    if (step._type === 'scope') {
      resolveScope(db, step, schema, fkGraph)
    }

    else if (step._type === 'dropTable') {
      if (!schema[step.tableName]) continue
      db.run(`DROP TABLE IF EXISTS "${step.tableName}"`)
      delete schema[step.tableName]
      log(`   🗑️  ${tbl(step.tableName)}  ${dim('table dropped')}`)
    }

    else if (step._type === 'truncateTable') {
      if (!schema[step.tableName]) continue
      const before = db.query(`SELECT COUNT(*) as n FROM "${step.tableName}"`).get().n
      db.run(`DELETE FROM "${step.tableName}"`)
      log(`   🚫 ${tbl(step.tableName)}  ${dim(`${before} rows cleared`)}`)
    }

    else if (step._type === 'dropExcept') {
      const toDrop = tableNames.filter(t => !step.keep.includes(t) && schema[t])
      for (const t of toDrop) {
        db.run(`DROP TABLE IF EXISTS "${t}"`)
        delete schema[t]
      }
      log(`   🗑️  ${dim('dropped')} ${toDrop.map(t => tbl(t)).join(', ')}  ${dim(`kept: ${step.keep.join(', ')}`)}`)
    }

    else if (step._type === 'filter') {
      const isAll  = step.tableName === 'all'
      const targets = isAll ? tableNames : [step.tableName]

      for (const tblName of targets) {
        const tableSchema = schema[tblName]
        if (!tableSchema) continue

        if (typeof step.fn === 'string') {
          const { before, after } = rebuildTableSQL(db, tblName, step.fn)
          log(`   🔽 ${tbl(tblName)}  ${rowCount(before, after)}  ${dim('sql')}`)
        } else {
          const rows      = queryRows(db, tblName)
          const surviving = rows.filter(step.fn)
          rebuildTable(db, tblName, surviving, tableSchema.columns, tableSchema.foreignKeys)
          log(`   🔽 ${tbl(tblName)}  ${rowCount(rows.length, surviving.length)}`)
        }
      }
    }

    else if (step._type === 'sample') {
      const isAll    = step.tableName === 'all'
      const targets  = isAll ? tableNames : [step.tableName]
      const parsed   = parseLimit(step.n)
      const counts   = isAll
        ? resolveAllRowCounts(db, tableNames, parsed)
        : { [step.tableName]: resolveRowCount(db, step.tableName, parsed) }

      for (const tblName of targets) {
        const tableSchema = schema[tblName]
        if (!tableSchema) continue
        const n        = counts[tblName]
        const rows     = queryRows(db, tblName)
        const shuffled = [...rows]
        for (let j = shuffled.length - 1; j > 0; j--) {
          const k = Math.floor(Math.random() * (j + 1))
          ;[shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]]
        }
        const surviving = shuffled.slice(0, n)
        rebuildTable(db, tblName, surviving, tableSchema.columns, tableSchema.foreignKeys)
        log(`   🎲 ${tbl(tblName)}  ${rowCount(rows.length, surviving.length)}  ${dim('random')}`)
      }
    }

    else if (step._type === 'limit') {
      const isAll    = step.tableName === 'all'
      const targets  = isAll ? tableNames : [step.tableName]
      const parsed   = parseLimit(step.n)
      const counts   = isAll
        ? resolveAllRowCounts(db, tableNames, parsed)
        : { [step.tableName]: resolveRowCount(db, step.tableName, parsed) }

      for (const tblName of targets) {
        const tableSchema = schema[tblName]
        if (!tableSchema) continue
        const n         = counts[tblName]
        const rows      = queryRows(db, tblName)
        const surviving = rows.slice(0, n)
        rebuildTable(db, tblName, surviving, tableSchema.columns, tableSchema.foreignKeys)
        log(`   ✂️  ${tbl(tblName)}  ${rowCount(rows.length, surviving.length)}`)
      }
    }

    else if (step._type === 'target') {
      const targets = step.target === 'all' ? tableNames : [step.tableName]
      for (const tblName of targets) {
        applyOpsToTable(db, tblName, step.ops, schema)
      }
    }

    const ms = (performance.now() - t0).toFixed(1)
    if (verbose && !collectLogs) console.log(`   ${c.dim}⏱  ${ms}ms${c.reset}`)
    else if (collectLogs) lines.push(`   ${c.dim}⏱  ${ms}ms${c.reset}`)
  }

  if (verbose && !collectLogs) console.log(`\n${c.green}${c.bold}✓ Pipeline complete${c.reset}`)
  _logCollector = null
  return collectLogs ? { db, lines } : db
}

// ─── Main ────────────────────────────────────────────────────────────────────

export const main = (...args) => execute(...args, run)

// ─── Step / op descriptions ───────────────────────────────────────────────────

const describeStep = step => {
  const sep = dim('  ·  ')
  if (step._type === 'shard')
    return `✂️  ${bold('shard')}  ${tbl(step.tableName)}`
  if (step._type === 'scope')
    return `🎯 ${bold('scope')}  ${tbl(step.tableName)}  ${dim('[cascade]')}`
  if (step._type === 'filter')
    return `🔽 ${bold('filter')}  ${tbl(step.tableName)}`
  if (step._type === 'sample')
    return `🎲 ${bold('sample')}  ${tbl(step.tableName)}  ${dim(`n=${step.n}`)}`
  if (step._type === 'limit')
    return `✂️  ${bold('limit')}   ${tbl(step.tableName)}  ${dim(`n=${step.n}`)}`
  if (step._type === 'dropTable')
    return `🗑️  ${bold('drop table')}  ${tbl(step.tableName)}`
  if (step._type === 'truncateTable')
    return `🚫 ${bold('truncate')}  ${tbl(step.tableName)}`
  if (step._type === 'dropExcept')
    return `🗑️  ${bold('dropExcept')}  ${dim(`keep: ${step.keep.join(', ')}`)}`
  if (step.target === 'all')
    return `🌐 ${bold('allTables')}  ${step.ops.map(describeOp).join(sep)}`
  return `📋 ${bold('table')}  ${tbl(step.tableName)}  ${step.ops.map(describeOp).join(sep)}`
}

const describeOp = op => {
  if (op._type === 'dropColumn')   return `🗑️  ${col(op.name)}`
  if (op._type === 'renameColumn') return `✏️  ${col(op.from)} ${c.gray}→${c.reset} ${col(op.to)}`
  if (op._type === 'setField')     return `⚡ ${col(op.name)}`
  if (op._type === 'keepColumns')  return `📌 ${op.names.map(col).join(c.gray + ', ' + c.reset)}`
  if (op._type === 'mask')         return `🎭 ${col(op.name)}  ${c.magenta}${op.strategy}${c.reset}`
  if (op._type === 'redactBlock')  return `🔴 redact ${c.magenta}${op.mode ?? 'SECRETS+PII'}${c.reset}`
  return op._type
}
