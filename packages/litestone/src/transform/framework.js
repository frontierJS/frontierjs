import { Database } from 'bun:sqlite'
import workerBundleSource from './split-worker.source.js'
import { existsSync, copyFileSync, writeFileSync, statSync, unlinkSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const c = { dim: '\x1b[2m', reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m' }

// OVERVIEW ────────────────────────────────────────────────────────────────────
// STEP 1 — introspectSQL: read live schema + FK graph from SQLite
// STEP 2 — plan:       static analysis, catch errors before execution
// STEP 3 — execute:    copy db, validate, then delegate to runner
// STEP 4 — run:        lives in runner.js, injected into execute()

// STEP #1 ─── Introspect ──────────────────────────────────────────────────────
// Returns: { tableName: { columns: [{name, type, notnull, pk, default}], foreignKeys: [{from, table, to}] } }

export function introspectSQL(db) {
  const schema = {}

  const tables = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name)

  for (const tableName of tables) {
    const columns = db
      .query(`PRAGMA table_info("${tableName}")`)
      .all()
      .map(({ name, type, notnull, dflt_value, pk }) => ({
        name,
        type: type || 'TEXT',
        notnull: !!notnull,
        pk: !!pk,
        default: dflt_value,
      }))

    // Group FK rows by constraint id — composite FKs span multiple rows with same id, different seq
    const fkRows = db.query(`PRAGMA foreign_key_list("${tableName}")`).all()
    const fkMap  = new Map()
    for (const row of fkRows) {
      if (!fkMap.has(row.id)) fkMap.set(row.id, { table: row.table, from: [], to: [] })
      const fk = fkMap.get(row.id)
      fk.from.push(row.from)
      fk.to.push(row.to)
    }
    // Flatten: single-col FKs keep scalar strings for back-compat; composite use arrays
    const foreignKeys = [...fkMap.values()].map(fk =>
      fk.from.length === 1
        ? { from: fk.from[0], table: fk.table, to: fk.to[0] }
        : { from: fk.from,    table: fk.table, to: fk.to, composite: true }
    )

    const indexes = db
      .query(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`)
      .all(tableName)
      .map(({ name, sql }) => {
        const match = sql.match(/\(([^)]+)\)/)
        const cols  = match ? match[1].split(',').map(c => c.trim().replace(/^["'`]|["'`]$/g, '')) : []
        const unique = /CREATE UNIQUE INDEX/i.test(sql)
        return { name, cols, unique }
      })

    schema[tableName] = { columns, foreignKeys, indexes }
  }

  return schema
}

// Build a reverse FK map: { 'accounts': ['users', 'leads', ...] }
// i.e. "which tables have FKs pointing TO this table"
export function buildFKGraph(schema) {
  const graph = {}

  for (const [tableName, { foreignKeys }] of Object.entries(schema)) {
    for (const fk of foreignKeys) {
      if (!graph[fk.table]) graph[fk.table] = []
      if (!graph[fk.table].includes(tableName)) {
        graph[fk.table].push(tableName)
      }
    }
  }

  return graph
}

// STEP #2 ─── Plan ────────────────────────────────────────────────────────────
// Walks the pipeline before execution and catches obvious errors:
//   - referencing a column that was already dropped
//   - filtering on a column that doesn't exist
//   - scoping on a table that doesn't exist
// Returns { valid: bool, errors: [], warnings: [] }

export function plan(pipeline, schema) {
  pipeline = flattenPipeline(pipeline)
  const errors = []
  const warnings = []

  const columnState = {}
  for (const [tableName, { columns }] of Object.entries(schema)) {
    columnState[tableName] = new Set(columns.map((c) => c.name))
  }

  const droppedTables = new Set()
  const tableNames = Object.keys(schema)
  const tableExists = (t) => !droppedTables.has(t) && !!schema[t]

  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i]
    const stepLabel = `Step ${i + 1}`

    if (step._type === 'shard') {
      if (!tableExists(step.tableName))
        errors.push(`${stepLabel}: shard() targets unknown table "${step.tableName}"`)
    }

    else if (step._type === 'dropTable') {
      if (!tableExists(step.tableName))
        warnings.push(`${stepLabel}: drop() targets ${droppedTables.has(step.tableName) ? 'already-dropped' : 'unknown'} table "${step.tableName}" — will be ignored`)
      else
        droppedTables.add(step.tableName)
    }

    else if (step._type === 'truncateTable') {
      if (!tableExists(step.tableName))
        warnings.push(`${stepLabel}: truncate() targets ${droppedTables.has(step.tableName) ? 'dropped' : 'unknown'} table "${step.tableName}" — will be ignored`)
    }

    else if (step._type === 'dropExcept') {
      for (const name of step.keep) {
        if (!tableExists(name))
          warnings.push(`${stepLabel}: dropExcept() — "${name}" is not a known table`)
      }
      // Mark all other live tables as dropped
      for (const name of tableNames) {
        if (!step.keep.includes(name) && !droppedTables.has(name))
          droppedTables.add(name)
      }
    }

    else if (step._type === 'scope') {
      if (!tableExists(step.tableName))
        errors.push(`${stepLabel}: scope() targets ${droppedTables.has(step.tableName) ? 'dropped' : 'unknown'} table "${step.tableName}"`)
    }

    else if (step._type === 'filter') {
      const isAll = step.tableName === 'all'
      if (!isAll && !tableExists(step.tableName))
        errors.push(`${stepLabel}: filter() targets ${droppedTables.has(step.tableName) ? 'dropped' : 'unknown'} table "${step.tableName}"`)
    }

    else if (step._type === 'sample' || step._type === 'limit') {
      const isAll = step.tableName === 'all'
      if (!isAll && !tableExists(step.tableName))
        errors.push(`${stepLabel}: ${step._type}() targets ${droppedTables.has(step.tableName) ? 'dropped' : 'unknown'} table "${step.tableName}"`)
      try { parseLimit(step.n) } catch (e) {
        errors.push(`${stepLabel}: ${e.message}`)
      }
    }

    else if (step._type === 'target') {
      const targets = step.target === 'all'
        ? tableNames.filter(t => !droppedTables.has(t))
        : [step.tableName]

      if (step.target === 'table' && !tableExists(step.tableName)) {
        errors.push(`${stepLabel}: table() targets ${droppedTables.has(step.tableName) ? 'dropped' : 'unknown'} table "${step.tableName}"`)
        continue
      }

      for (const op of step.ops) {
        for (const tbl of targets) {
          const cols = columnState[tbl]
          if (!cols) continue

          if (op._type === 'dropColumn') {
            if (!cols.has(op.name)) {
              if (step.target !== 'all')
                warnings.push(`${stepLabel}: dropColumn("${op.name}") on "${tbl}" — column doesn't exist, will be ignored`)
            } else {
              // Warn if any index depends on this column
              const affectedIndexes = (schema[tbl]?.indexes ?? []).filter(idx => idx.cols.includes(op.name))
              for (const idx of affectedIndexes)
                warnings.push(`${stepLabel}: dropping "${op.name}" on "${tbl}" will remove index "${idx.name}" (${idx.unique ? 'UNIQUE, ' : ''}cols: ${idx.cols.join(', ')})`)
              cols.delete(op.name)
            }
          }

          else if (op._type === 'renameColumn') {
            if (!cols.has(op.from)) {
              errors.push(`${stepLabel}: renameColumn("${op.from}", "${op.to}") on "${tbl}" — column "${op.from}" doesn't exist`)
            } else {
              cols.delete(op.from)
              cols.add(op.to)
            }
          }

          else if (op._type === 'setField') {
            cols.add(op.name)
          }

          else if (op._type === 'keepColumns') {
            // Drop everything NOT in the keep list
            for (const col of [...cols]) {
              if (!op.names.includes(col)) {
                // Warn if a dropped column has an index
                const affectedIndexes = (schema[tbl]?.indexes ?? []).filter(idx => idx.cols.includes(col) && idx.cols.every(c => !op.names.includes(c)))
                for (const idx of affectedIndexes)
                  warnings.push(`${stepLabel}: keep() on "${tbl}" will remove index "${idx.name}" (drops col "${col}")`)
                cols.delete(col)
              }
            }
            // Warn about any requested cols that don't exist
            for (const name of op.names) {
              if (!cols.has(name) && step.target !== 'all')
                warnings.push(`${stepLabel}: keep("${name}") on "${tbl}" — column doesn't exist`)
            }
          }

          else if (op._type === 'mask') {
            if (!cols.has(op.name))
              errors.push(`${stepLabel}: mask("${op.name}") on "${tbl}" — column doesn't exist`)
          }

          else if (op._type === 'redactBlock') {
            // No validation needed — redact silently skips columns that don't exist
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// STEP #2.5 ─── Preview ───────────────────────────────────────────────────────
// Simulates row-reducing ops read-only against the source db.
// Returns a table showing surviving row counts per table after each step.

// ─── Pipeline shard extraction ───────────────────────────────────────────────
// Scans a pipeline for a $.shard() marker and splits it into:
//   { sharedPipeline, splitBy, postSplit }
function parseShard(pipeline) {
  const idx = pipeline.findIndex(s => s?._type === 'shard')
  if (idx === -1) return { sharedPipeline: pipeline, splitBy: null, postSplit: [] }
  return {
    sharedPipeline: pipeline.slice(0, idx),
    splitBy:        pipeline[idx].tableName,
    postSplit:      pipeline.slice(idx + 1),
  }
}

// ─── Config normalisation ─────────────────────────────────────────────────────
// Supports both shapes:
//   new: export let pipeline = [...]
//        export let config = { db, pipeline, splitBy, ... }
//   old: export const db = ..., export const pipeline = [...], etc.
function resolveConfig(mod) {
  const base = mod.config ? { ...mod.config, pipeline: mod.pipeline ?? mod.config.pipeline } : mod
  // Strip old-style splitBy/postSplit — these now live in the pipeline via $.shard()
  const { splitBy: _s, postSplit: _p, ...rest } = base
  return rest
}

export async function preview(configPath) {
  const abs    = resolve(configPath)
  const mod    = await import(`file://${abs}`)
  const { db: dbPath, pipeline: rawPipeline, filename, redact: redactConfig } = resolveConfig(mod)
  const pipeline = flattenPipeline(rawPipeline ?? [])
  const { sharedPipeline, splitBy, postSplit } = parseShard(pipeline)



  const resolvedDbPath = resolve(dbPath)
  if (!existsSync(resolvedDbPath)) throw new Error(`Database not found: ${resolvedDbPath}`)

  const db     = new Database(resolvedDbPath, { readonly: true })
  const schema = introspectSQL(db)

  // Seed row counts from live db
  const counts = {}
  for (const tableName of Object.keys(schema)) {
    counts[tableName] = db.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get().n
  }

  // Estimate bytes-per-row from db size / total rows
  const { size: dbSize } = statSync(resolvedDbPath)
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)
  const bytesPerRow = totalRows > 0 ? dbSize / totalRows : 0

  const tableNames = Object.keys(schema)
  const droppedTables = new Set()

  const steps = []  // { label, counts: {table: n}, dropped: Set }

  for (let i = 0; i < sharedPipeline.length; i++) {
    const step = sharedPipeline[i]
    const label = `Step ${i + 1}: ${previewStepLabel(step)}`
    let changed = false

    if (step._type === 'dropTable') {
      if (schema[step.tableName] && !droppedTables.has(step.tableName)) {
        droppedTables.add(step.tableName)
        delete counts[step.tableName]
        changed = true
      }
    }

    else if (step._type === 'scope') {
      const tbl = step.tableName
      if (schema[tbl] && !droppedTables.has(tbl)) {
        if (typeof step.fn === 'string') {
          counts[tbl] = db.query(`SELECT COUNT(*) as n FROM "${tbl}" WHERE ${step.fn}`).get().n
        } else {
          const rows = db.query(`SELECT * FROM "${tbl}"`).all()
          counts[tbl] = rows.filter(step.fn).length
        }
        // Cascade: estimate child counts proportionally based on parent reduction ratio
        if (step.fn !== false) {
          const fkGraph = buildFKGraph(schema)
          const visited = new Set([tbl])
          const queue   = [tbl]
          while (queue.length) {
            const parent = queue.shift()
            for (const child of fkGraph[parent] ?? []) {
              if (visited.has(child) || droppedTables.has(child)) continue
              visited.add(child)
              const fks = schema[child].foreignKeys.filter(fk => fk.table === parent)
              if (!fks.length) continue
              const fk = fks[0]
              // Use IN subquery for accurate count
              let where
              if (fk.composite) {
                const fromCols = fk.from.map(c => `"${c}"`).join(', ')
                const toCols   = fk.to.map(c => `"${c}"`).join(', ')
                where = `(${fromCols}) IN (SELECT ${toCols} FROM "${parent}")`
              } else {
                where = `"${fk.from}" IN (SELECT "${fk.to}" FROM "${parent}")`
              }
              // For preview we query source db, which hasn't been filtered yet
              // So we compute what WOULD survive proportionally
              const parentOriginal = db.query(`SELECT COUNT(*) as n FROM "${parent}"`).get().n
              const parentRatio    = parentOriginal > 0 ? counts[parent] / parentOriginal : 0
              const childOriginal  = db.query(`SELECT COUNT(*) as n FROM "${child}"`).get().n
              counts[child] = Math.round(childOriginal * parentRatio)
              queue.push(child)
            }
          }
        }
        changed = true
      }
    }

    else if (step._type === 'filter') {
      const targets = step.tableName === 'all'
        ? tableNames.filter(t => !droppedTables.has(t))
        : [step.tableName]
      for (const tbl of targets) {
        if (!schema[tbl] || droppedTables.has(tbl)) continue
        let rawCount
        if (typeof step.fn === 'string') {
          rawCount = db.query(`SELECT COUNT(*) as n FROM "${tbl}" WHERE ${step.fn}`).get().n
        } else {
          const rows = db.query(`SELECT * FROM "${tbl}"`).all()
          rawCount = rows.filter(step.fn).length
        }
        // Can't exceed what scope already reduced to
        counts[tbl] = Math.min(counts[tbl], rawCount)
        changed = true
      }
    }

    else if (step._type === 'limit' || step._type === 'sample') {
      const targets = step.tableName === 'all'
        ? tableNames.filter(t => !droppedTables.has(t))
        : [step.tableName]
      const parsed = parseLimit(step.n)
      for (const tbl of targets) {
        if (!schema[tbl] || droppedTables.has(tbl)) continue
        const current = counts[tbl]
        let   target
        if (parsed.type === 'rows')    target = parsed.value
        if (parsed.type === 'percent') target = Math.floor(current * parsed.value / 100)
        if (parsed.type === 'bytes')   target = bytesPerRow > 0 ? Math.floor(parsed.value / bytesPerRow) : current
        counts[tbl] = Math.min(current, Math.max(0, target ?? current))
        changed = true
      }
    }

    if (changed) steps.push({ label, counts: { ...counts }, dropped: new Set(droppedTables) })
  }

  db.close()

  // ── Print preview table ───────────────────────────────────────────────────
  const allTables    = Object.keys(schema)
  const initialCounts = {}
  for (const t of allTables) {
    initialCounts[t] = db.query ? 0 : schema[t] // already closed — use fresh read
  }

  // Re-read initial counts
  const db2 = new Database(resolvedDbPath, { readonly: true })
  for (const t of allTables) {
    initialCounts[t] = db2.query(`SELECT COUNT(*) as n FROM "${t}"`).get().n
  }
  const splitCount = splitBy ? db2.query(`SELECT COUNT(*) as n FROM "${splitBy}"`).get().n : 0
  db2.close()

  const colW = Math.max(...allTables.map(t => t.length), 5) + 2
  const dim  = s => `\x1b[2m${s}\x1b[0m`
  const bold = s => `\x1b[1m${s}\x1b[0m`
  const green = s => `\x1b[32m${s}\x1b[0m`
  const red   = s => `\x1b[31m${s}\x1b[0m`
  const cyan  = s => `\x1b[36m${s}\x1b[0m`

  console.log(`\n${bold('📋 Preview')}  ${dim(resolvedDbPath)}\n`)

  // Header row
  const header = '  ' + 'step'.padEnd(40) + allTables.map(t => t.padStart(colW)).join('')
  console.log(dim(header))
  console.log(dim('  ' + '─'.repeat(40) + allTables.map(() => '─'.repeat(colW)).join('')))

  // Source row
  const sourceRow = '  ' + 'source'.padEnd(40) + allTables.map(t => String(initialCounts[t]).padStart(colW)).join('')
  console.log(bold(sourceRow))

  // Step rows
  for (const step of steps) {
    const row = '  ' + step.label.slice(0, 39).padEnd(40) + allTables.map(t => {
      if (step.dropped.has(t)) return dim('dropped'.padStart(colW))
      const n    = step.counts[t]
      const prev = initialCounts[t]   // compare to source for colour
      if (n === undefined) return ' '.repeat(colW)
      const str = String(n).padStart(colW)
      return n < prev ? red(str) : str
    }).join('')
    console.log(row)
  }

  // Final row
  const finalCounts = steps.length > 0 ? steps[steps.length - 1].counts : initialCounts
  const finalDropped = steps.length > 0 ? steps[steps.length - 1].dropped : new Set()
  const estBytes = Object.entries(finalCounts).reduce((sum, [, n]) => sum + n * bytesPerRow, 0)
  console.log(dim('  ' + '─'.repeat(40) + allTables.map(() => '─'.repeat(colW)).join('')))

  const finalRow = '  ' + green(bold('output'.padEnd(40))) + allTables.map(t => {
    if (finalDropped.has(t)) return dim('dropped'.padStart(colW))
    const n = finalCounts[t] ?? initialCounts[t]
    return green(bold(String(n).padStart(colW)))
  }).join('')
  console.log(finalRow)

  console.log(`\n  ${dim('estimated output size:')} ${green(fmtBytes(estBytes))}`)

  if (splitBy) {
    console.log(`\n  ${dim('split by:')} ${cyan(splitBy)}  ${dim(`(${splitCount} output files)`)}`)
    if (postSplit?.length) {
      console.log(`\n  ${bold('postSplit')} ${dim('(applied per output file, after per-entity scope)')}`)
      for (const step of postSplit) {
        console.log(`    ${dim('·')} ${previewStepLabel(step)}`)
      }
    }
  }

  console.log()
}

function previewStepLabel(step) {
  if (step._type === 'shard')     return `shard by ${step.tableName}`
  if (step._type === 'dropTable') return `drop table ${step.tableName}`
  if (step._type === 'truncateTable') return `truncate ${step.tableName}`
  if (step._type === 'dropExcept')   return `dropExcept (keep: ${step.keep.join(', ')})`
  if (step._type === 'scope')     return `scope ${step.tableName}`
  if (step._type === 'filter')    return `filter ${step.tableName}`
  if (step._type === 'limit')     return `limit ${step.tableName} n=${step.n}`
  if (step._type === 'sample')    return `sample ${step.tableName} n=${step.n}`
  if (step._type === 'target') {
    const ops = step.ops.map(o =>
      o._type === 'dropColumn' ? `drop(${o.name})` :
      o._type === 'keepColumns' ? `keep(${o.names.join(',')})` :
      o._type === 'mask' ? `mask(${o.name})` :
      o._type === 'setField' ? `set(${o.name})` :
      o._type === 'renameColumn' ? `rename(${o.from}→${o.to})` : o._type
    ).join(' ')
    return `${step.target === 'all' ? 'all' : step.tableName} ${ops}`
  }
  return step._type
}

// STEP #3 ─── Execute ─────────────────────────────────────────────────────────
// run is injected from runner.js to keep execution logic separate

function applyPragmas(db) {
  db.run(`PRAGMA journal_mode = OFF`)
  db.run(`PRAGMA synchronous = OFF`)
  db.run(`PRAGMA cache_size = -65536`)
  db.run(`PRAGMA temp_store = MEMORY`)
  db.run(`PRAGMA mmap_size = 268435456`)
}

function runOne(srcPath, outPath, pipeline, { verbose, suppressWarnings = false }, run) {
  copyFileSync(srcPath, outPath)
  const db = new Database(outPath)
  applyPragmas(db)

  const schema = introspectSQL(db)
  const { valid, errors, warnings } = plan(pipeline, schema)

  if (warnings.length && verbose && !suppressWarnings) warnings.forEach(w => console.warn(`⚠️  ${w}`))

  if (!valid) {
    console.error('\n❌ Pipeline has errors:')
    errors.forEach(e => console.error(`   ${e}`))
    db.close()
    return null
  }

  const t0 = performance.now()
  db.run('BEGIN')
  run(db, pipeline, { verbose })
  db.run('COMMIT')
  db.run('PRAGMA journal_mode = DELETE')  // switch off WAL before VACUUM
  db.run('VACUUM')
  const elapsed   = (performance.now() - t0).toFixed(0)
  const sizeBytes = statSync(outPath).size

  // Warn if any $.all size-based limits are close to the actual output size (within 20%)
  const sizeLimits = pipeline.filter(s =>
    (s._type === 'limit' || s._type === 'sample') &&
    s.tableName === 'all' &&
    typeof s.n === 'string' && parseLimit(s.n).type === 'bytes'
  )
  for (const step of sizeLimits) {
    const { value: limitBytes } = parseLimit(step.n)
    const actualBytes = getTotalDbBytes(db)
    const ratio = actualBytes / limitBytes
    if (ratio > 0.8) {
      const pct = (ratio * 100).toFixed(0)
      console.warn(`⚠️  Size limit warning: ${outPath} is ${pct}% of the ${step.n} limit (${fmtBytes(actualBytes)} / ${fmtBytes(limitBytes)})`)
    }
  }

  db.close()

  return { outPath, elapsed, sizeBytes }
}

export async function execute(configPath, { dryRun = false, verbose = true, outputPath, only = null, concurrency = 8, skipExisting = false, force = false } = {}, run) {
  const totalT0 = performance.now()
  const abs = resolve(configPath)
  const mod = await import(`file://${abs}`)
  const { db: dbPath, pipeline: rawPipeline, filename, redact: redactConfig } = resolveConfig(mod)
  const pipeline = flattenPipeline(rawPipeline ?? [])
  const { sharedPipeline, splitBy, postSplit } = parseShard(pipeline)

  const resolvedDbPath = resolve(dbPath)
  if (!existsSync(resolvedDbPath)) throw new Error(`Database not found: ${resolvedDbPath}`)

  for (const ext of ['-wal', '-shm']) {
    if (existsSync(resolvedDbPath + ext))
      console.warn(`⚠️  Stale ${ext} file found next to source db — this may cause unexpected results.\n   Fix: sqlite3 ${resolvedDbPath} "PRAGMA wal_checkpoint(TRUNCATE)"`)
  }

  if (typeof pipeline === 'function')
    throw new Error(`pipeline must be a plain array. Use splitBy = 'table' to fan out.`)

  // ── Validate pipeline before touching anything ────────────────────────────
  const srcDb = new Database(resolvedDbPath, { readonly: true })
  const schema = introspectSQL(srcDb)
  srcDb.close()

  // Stamp resolved redact config onto any redactBlock ops so workers get plain data
  function stampRedact(steps) {
    return steps.map(s => {
      if (s._type !== 'target') return s
      return { ...s, ops: s.ops.map(op =>
        op._type === 'redactBlock' ? { ...op, cfg: redactConfig ?? {} } : op
      )}
    })
  }

  const stampedShared = stampRedact(sharedPipeline)
  const stampedPost   = stampRedact(postSplit)

  if (verbose && !splitBy) {
    console.log(`\n📂 Database: ${resolvedDbPath}`)
    console.log(`📋 Tables: ${Object.keys(schema).join(', ')}`)
    console.log(`🔢 Pipeline steps: ${pipeline.length}\n`)
  }

  const { valid, errors, warnings } = plan(pipeline, schema)
  if (warnings.length && verbose) warnings.forEach(w => console.warn(`⚠️  ${w}`))
  if (!valid) {
    console.error('\n❌ Pipeline has errors:')
    errors.forEach(e => console.error(`   ${e}`))
    process.exit(1)
  }

  if (dryRun) {
    console.log('\n🔍 Dry run — no changes applied')
    return
  }

  // ── Single mode ───────────────────────────────────────────────────────────
  if (!splitBy) {
    const pipeline = stampedShared  // single mode uses shared pipeline (no shard marker)
    const defaultName = resolvedDbPath.replace(/\.db$/, '') + '.transformed.db'
    let out
    if (!outputPath) {
      out = defaultName
    } else {
      const resolved = resolve(outputPath)
      // If it ends with / or is an existing directory, treat as directory + infer filename
      const isDir = outputPath.endsWith('/') || outputPath.endsWith('\\') ||
        (existsSync(resolved) && statSync(resolved).isDirectory())
      if (isDir) {
        const basename = resolvedDbPath.replace(/.*[/\\]/, '').replace(/\.db$/, '') + '.transformed.db'
        mkdirSync(resolved, { recursive: true })
        out = resolve(resolved, basename)
      } else {
        out = resolved
      }
    }

    const result = runOne(resolvedDbPath, out, pipeline, { verbose, suppressWarnings: true }, run)
    if (!result) process.exit(1)
    if (verbose) console.log(`\n💾 Output: ${result.outPath}  ${c.dim}(${fmtBytes(result.sizeBytes)}  ${result.elapsed}ms)${c.reset}`)
    if (verbose) console.log(`${c.dim}⏱  Total: ${((performance.now() - totalT0) / 1000).toFixed(2)}s${c.reset}`)
    writeManifest(out.replace(/\.db$/, '.manifest.json'), {
      source: resolvedDbPath, config: abs,
      completedAt: new Date().toISOString(),
      totalMs: Math.round(performance.now() - totalT0),
      files: [await fileEntry(result.outPath)],
    })
    return result.outPath
  }

  // Strip non-serializable method props from steps before postMessage
  function serializeStep(s) {
    if (!s || typeof s !== 'object') return s
    // Only copy known plain-data fields — excludes any chaining methods
    const FIELDS = ['_type','tableName','fn','n','ops','cascade','names','from','to','strategy','name','keep','target']
    const plain = {}
    for (const f of FIELDS) {
      const v = s[f]
      if (v === undefined) continue
      if (typeof v === 'function') continue   // skip methods that leaked onto the step
      plain[f] = f === 'ops' ? v.map(serializeStep) : v
    }
    return plain
  }

  // ── Split mode ────────────────────────────────────────────────────────────
  // Step 1: run pipeline once → intermediate db
  const intermediateOut = resolvedDbPath.replace(/\.db$/, '') + '.__intermediate.db'
  const outDir = outputPath ? resolve(outputPath) : resolvedDbPath.replace(/[^/\\]+$/, '')
  const nameFn = filename ?? (row => `${splitBy}-${row.id}.db`)

  // Guard against stale intermediate from a previously crashed run
  if (existsSync(intermediateOut)) {
    if (!force) {
      console.error(`\n❌ Stale intermediate file found: ${intermediateOut}`)
      console.error(`   This is left over from a previous run that didn't finish cleanly.`)
      console.error(`   Delete it manually, or re-run with --force to overwrite it.\n`)
      process.exit(1)
    }
    if (verbose) console.warn(`⚠️  Overwriting stale intermediate file (--force)`)
    unlinkSync(intermediateOut)
  }

  if (verbose) {
    console.log(`\n📂 Database:  ${resolvedDbPath}`)
    console.log(`📋 Tables:    ${Object.keys(schema).join(', ')}`)
    console.log(`🔢 Pipeline:  ${sharedPipeline.length} steps (+ ${postSplit.length} postShard)`)
    console.log(`✂️  Split by:  ${splitBy}`)
    console.log(`📁 Output:    ${outDir}\n`)
  }

  if (verbose) console.log(`${c.bold}── Shared pipeline ──────────────────────────────────────${c.reset}`)
  const t0 = performance.now()
  const intermediate = runOne(resolvedDbPath, intermediateOut, stampedShared, { verbose, suppressWarnings: true }, run)
  if (!intermediate) process.exit(1)
  const sharedMs = (performance.now() - t0).toFixed(0)
  if (verbose) console.log(`\n${c.dim}Shared pass complete (${sharedMs}ms)${c.reset}`)

  // Step 2: read split rows from the already-transformed intermediate db
  const intDb = new Database(intermediateOut, { readonly: true })
  let rows  = intDb.query(`SELECT * FROM "${splitBy}"`).all()
  intDb.close()

  // Filter to --only ids if specified
  if (only) {
    const onlySet = new Set(only.map(v => String(v)))
    rows = rows.filter(row => onlySet.has(String(row.id)))
    if (rows.length === 0) {
      console.error(`❌ --only filter matched no rows. Specified: ${only.join(', ')}`)
      process.exit(1)
    }
    if (verbose) console.log(`\n${c.dim}--only: processing ${rows.length} of ${only.length} requested (${only.join(', ')})${c.reset}`)
  }

  // Step 3: parallel splits via Bun workers
  const poolSize     = Math.min(rows.length, Math.max(1, concurrency))

  if (verbose) console.log(`\n${c.bold}── Splitting into ${rows.length} files  ${c.dim}(${poolSize} parallel)${c.reset}${c.bold} ──────────────────────────${c.reset}`)
  const results  = []
  const failures = []

  // Build all work items — skip already-completed files if requested
  const skipped = []
  const work = rows.map(row => ({
    row,
    outPath: resolve(outDir, nameFn(row)),
    splitPipeline: [
      { _type: 'scope', tableName: splitBy, fn: `id = ${row.id}`, cascade: true },
      ...(stampedPost ?? []).map(serializeStep),
    ],
  })).filter(item => {
    if (skipExisting && existsSync(item.outPath)) {
      skipped.push(item.outPath)
      return false
    }
    return true
  })

  if (skipped.length && verbose)
    console.log(`\n${c.dim}⏭  Skipping ${skipped.length} existing file${skipped.length > 1 ? 's' : ''}${c.reset}`)

  // Worker pool — runs poolSize workers at a time, properly awaits all
  const queue   = [...work]
  const running = []

  function startNext() {
    if (queue.length === 0) return null
    const item = queue.shift()
    const { row, outPath, splitPipeline } = item

    if (verbose) console.log(`\n${'─'.repeat(56)}\n🗂  ${nameFn(row)}`)

    const workerBlob = new Blob([workerBundleSource], { type: 'application/javascript' })
    const workerBlobURL = URL.createObjectURL(workerBlob)
    const worker = new Worker(workerBlobURL)
    worker.postMessage({ srcPath: intermediateOut, outPath, splitPipeline })

    const p = new Promise((res) => {
      worker.onmessage = ({ data }) => {
        worker.terminate()
        URL.revokeObjectURL(workerBlobURL)
        if (data.warnings?.length) data.warnings.forEach(w => console.warn(`⚠️  ${w}`))
        if (data.ok) {
          results.push({ outPath: data.outPath, elapsed: data.elapsed, sizeBytes: data.sizeBytes })
          if (verbose) {
            if (data.lines?.length) data.lines.forEach(l => console.log(l))
            console.log(`\n💾 ${data.outPath}  ${c.dim}(${fmtBytes(data.sizeBytes)}  ${data.elapsed}ms)${c.reset}`)
          }
        } else {
          failures.push({ row, outPath, error: data.error })
          console.error(`\n❌ Failed: ${nameFn(row)}  ${c.dim}${data.error}${c.reset}`)
          try { if (existsSync(outPath)) unlinkSync(outPath) } catch {}
        }
        res()
      }
      worker.onerror = (err) => {
        worker.terminate()
        URL.revokeObjectURL(workerBlobURL)
        failures.push({ row, outPath, error: err.message })
        console.error(`\n❌ Worker error: ${nameFn(row)}  ${c.dim}${err.message}${c.reset}`)
        res()
      }
    })

    return p
  }

  // Drain the queue: when a slot frees, start the next item
  async function runSlot() {
    while (queue.length > 0) {
      await startNext()
    }
  }

  await Promise.all(Array.from({ length: poolSize }, runSlot))

  // Step 4: clean up intermediate
  try { unlinkSync(intermediateOut) } catch {}

  if (verbose) {
    if (failures.length) {
      console.log(`\n${c.dim}❌ ${failures.length} failed:${c.reset}`)
      failures.forEach(f => console.log(`   ${c.dim}• ${nameFn(f.row)}: ${f.error}${c.reset}`))
    }
    const skippedNote = skipped.length ? `  ${c.dim}${skipped.length} skipped${c.reset}` : ''
    const statusLine = failures.length
      ? `${c.green}${c.bold}✓ ${results.length} written${c.reset}  ${c.dim}${failures.length} failed${c.reset}${skippedNote}`
      : `${c.green}${c.bold}✓ ${results.length} files written${c.reset}${skippedNote}`
    console.log(`\n${statusLine}  ${c.dim}(${((performance.now() - totalT0) / 1000).toFixed(2)}s total)${c.reset}`)
  }

  if (failures.length > 0 && results.length === 0) process.exit(1)

  // Write manifest
  const manifestPath = resolve(outDir, 'manifest.json')
  const fileEntries  = await Promise.all(results.map(r => fileEntry(r.outPath)))
  writeManifest(manifestPath, {
    source: resolvedDbPath, config: abs,
    splitBy, only: only ?? null,
    completedAt: new Date().toISOString(),
    totalMs: Math.round(performance.now() - totalT0),
    written: results.length, skipped: skipped.length, failed: failures.length,
    failures: failures.map(f => ({ file: nameFn(f.row), error: f.error })),
    files: fileEntries,
  })
  if (verbose) console.log(`${c.dim}📋 Manifest: ${manifestPath}${c.reset}`)

  return results.map(r => r.outPath)
}

// ─── Size/limit parsing ───────────────────────────────────────────────────────

export function parseLimit(n) {
  if (typeof n === 'number') return { type: 'rows', value: n }
  if (typeof n !== 'string') throw new Error(`limit/sample expects a number, percentage, or size string. Got: ${n}`)
  const s = n.trim().toLowerCase()
  if (s.endsWith('%')) {
    const pct = parseFloat(s)
    if (isNaN(pct) || pct <= 0 || pct > 100) throw new Error(`Invalid percentage: "${n}"`)
    return { type: 'percent', value: pct / 100 }
  }
  const units = { b: 1, kb: 1024, mb: 1024**2, gb: 1024**3, tb: 1024**4 }
  const match = s.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)$/)
  if (!match) throw new Error(`Invalid limit: "${n}". Use rows (500), percent ('10%'), or size ('50mb', '1gb')`)
  const bytes = parseFloat(match[1]) * units[match[2]]
  return { type: 'bytes', value: bytes }
}

// Returns estimated size info for a table based on actual file size
function getTableStats(db, tableName) {
  const rows = db.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get().n
  if (rows === 0) return { rows: 0, bytes: 0, avgRowBytes: 0 }

  // Use freelist-adjusted file bytes / total rows — accounts for SQLite page overhead
  const fileBytes = getTotalDbBytes(db)

  const totalRows = db.query(
    `SELECT SUM(n) as total FROM (` +
    db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all()
      .map(t => `SELECT COUNT(*) as n FROM "${t.name}"`).join(' UNION ALL ') +
    `)`
  ).get().total || rows

  const avgRowBytes = fileBytes / totalRows
  return { rows, bytes: Math.round(avgRowBytes * rows), avgRowBytes }
}

function getTotalDbBytes(db) {
  const { page_size }      = db.query('PRAGMA page_size').get()
  const { page_count }     = db.query('PRAGMA page_count').get()
  const { freelist_count } = db.query('PRAGMA freelist_count').get()
  return page_size * (page_count - freelist_count)
}

function fmtBytes(bytes) {
  if (bytes >= 1024**3) return `${(bytes / 1024**3).toFixed(1)}gb`
  if (bytes >= 1024**2) return `${(bytes / 1024**2).toFixed(1)}mb`
  if (bytes >= 1024)    return `${(bytes / 1024).toFixed(1)}kb`
  return `${bytes}b`
}

// Resolve a parsed limit to a concrete row count for a specific table
export function resolveRowCount(db, tableName, parsed) {
  const { rows, avgRowBytes } = getTableStats(db, tableName)
  if (parsed.type === 'rows')    return Math.min(parsed.value, rows)
  if (parsed.type === 'percent') return Math.max(1, Math.floor(rows * parsed.value))
  if (parsed.type === 'bytes') {
    if (avgRowBytes === 0) return rows
    return Math.max(1, Math.min(rows, Math.floor(parsed.value / avgRowBytes)))
  }
  return rows
}

// For $.all.limit/sample — distribute target bytes proportionally across all tables
export function resolveAllRowCounts(db, tableNames, parsed) {
  if (parsed.type === 'rows') {
    return Object.fromEntries(tableNames.map(t => [t, parsed.value]))
  }
  if (parsed.type === 'percent') {
    return Object.fromEntries(tableNames.map(t => {
      const { rows } = getTableStats(db, t)
      return [t, Math.max(1, Math.floor(rows * parsed.value))]
    }))
  }
  if (parsed.type === 'bytes') {
    const totalBytes = getTotalDbBytes(db)
    if (totalBytes === 0) return Object.fromEntries(tableNames.map(t => [t, Infinity]))
    const ratio = parsed.value / totalBytes
    return Object.fromEntries(tableNames.map(t => {
      const { rows } = getTableStats(db, t)
      return [t, Math.max(1, Math.floor(rows * ratio))]
    }))
  }
  return Object.fromEntries(tableNames.map(t => [t, Infinity]))
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

function writeManifest(path, data) {
  try { writeFileSync(path, JSON.stringify(data, null, 2)) } catch {}
}

async function fileEntry(filePath) {
  try {
    const db   = new Database(filePath, { readonly: true })
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name)
    const rows = Object.fromEntries(tables.map(t => [t, db.query(`SELECT COUNT(*) as n FROM "${t}"`).get().n]))
    db.close()
    const { size } = statSync(filePath)
    return { file: filePath, sizeBytes: size, rows }
  } catch {
    return { file: filePath }
  }
}

// ─── Runtime params ────────────────────────────────────────────────────────────
// Usage in config: const { accountIds } = params({ accountIds: [1, 2, 3] })
// Override at CLI:  bun run.js config.js --params='{"accountIds":[5,10,69]}'

export function params(defaults = {}) {
  const overrides = process.env.TRANSFORM_PARAMS
    ? JSON.parse(process.env.TRANSFORM_PARAMS)
    : {}
  return { ...defaults, ...overrides }
}

import { createHash } from 'crypto'

const maskStrategies = {
  redact:  ()  => '***',
  last4:   (v) => v == null ? null : String(v).slice(-4).padStart(String(v).length, '*'),
  first2:  (v) => v == null ? null : String(v).slice(0, 2) + '*'.repeat(Math.max(0, String(v).length - 2)),
  hash:    (v) => v == null ? null : createHash('sha256').update(String(v)).digest('hex').slice(0, 16),
}

// ─── Redact lists ────────────────────────────────────────────────────────────

export const REDACT_DEFAULTS = {
  SECRETS: ['password', 'token', 'accessToken', 'secrets', 'apiKey'],
  PII:     ['email', 'phone', 'dob', 'firstName', 'lastName', 'address1', 'address2', 'city', 'zip', 'postalCode', 'country'],
}

// Resolve the column names to null for a given mode, merging config overrides
function resolveRedactColumns(mode, configRedact = {}) {
  const secrets = configRedact.SECRETS ?? REDACT_DEFAULTS.SECRETS
  const pii     = configRedact.PII     ?? REDACT_DEFAULTS.PII
  if (!mode || mode === 'ALL') return [...new Set([...secrets, ...pii])]
  if (mode === 'SECRETS')      return secrets
  if (mode === 'PII')          return pii
  throw new Error(`redact() unknown mode "${mode}". Use 'SECRETS', 'PII', or omit for both.`)
}

// ─── Primitives (internal) ───────────────────────────────────────────────────

const dropColumn   = (name)          => ({ _type: 'dropColumn', name })
const renameColumn = (from, to)      => ({ _type: 'renameColumn', from, to })
const setField     = (name, fn)      => ({ _type: 'setField', name, fn })
const keepColumns  = (...names)      => ({ _type: 'keepColumns', names })
const redactField  = (name)           => ({ _type: 'redactField', name })
const maskField    = (name, strategy) => {
  if (!maskStrategies[strategy]) throw new Error(`Unknown mask strategy "${strategy}". Valid: ${Object.keys(maskStrategies).join(', ')}`)
  return { _type: 'mask', name, strategy }
}

// ─── $ Proxy ─────────────────────────────────────────────────────────────────
// $.accounts.scope(fn)                  — scope with FK cascade
// $.users.filter(fn)                    — row filter, no cascade
// $.users.sample(500)                   — random N rows
// $.users.limit(500)                    — first N rows
// $.all.drop('email', 'password')       — column ops across all tables
// $.leads.keep('id', 'status')          — whitelist columns, drop the rest
// $.leads.mask('phone', 'last4')        — built-in masking strategies
// $.leads.drop('phone').set('full_name', fn)  — chainable per-table ops

function makeTableStep(tableName) {
  const ops  = []
  const step = {
    _type:  'target',
    target:  tableName === 'all' ? 'all' : 'table',
    tableName,
    get ops() { return ops },
    drop(...names)         { ops.push(...names.map(dropColumn));    return step },
    set(name, fn)          { ops.push(setField(name, fn));          return step },
    rename(from, to)       { ops.push(renameColumn(from, to));      return step },
    keep(...names)         { ops.push(keepColumns(...names));        return step },
    mask(name, strategy)   { ops.push(maskField(name, strategy));   return step },
    redact(mode, cfg)      { ops.push({ _type: 'redactBlock', mode, cfg });  return step },
  }
  return step
}

// Wraps a row-op step to allow chaining column ops after it.
// Produces a compound step that flattens to [rowStep, targetStep] at execution.
function makeChainableRowStep(rowStep, tableName) {
  const target  = makeTableStep(tableName)
  const builder = {
    // Looks like the row step itself (for planner/runner compat when not chained)
    ...rowStep,
    // Column op chains — each returns the builder for further chaining
    drop(...names)       { target.drop(...names);       return toCompound() },
    set(name, fn)        { target.set(name, fn);        return toCompound() },
    rename(from, to)     { target.rename(from, to);     return toCompound() },
    keep(...names)       { target.keep(...names);        return toCompound() },
    mask(name, strategy) { target.mask(name, strategy); return toCompound() },
  }
  function toCompound() {
    return {
      _type:  'compound',
      steps:  [rowStep, target],
      // Keep column chains going off the compound
      drop(...names)       { target.drop(...names);       return this },
      set(name, fn)        { target.set(name, fn);        return this },
      rename(from, to)     { target.rename(from, to);     return this },
      keep(...names)       { target.keep(...names);        return this },
      mask(name, strategy) { target.mask(name, strategy); return this },
    }
  }
  return builder
}

// Flatten compound steps before execution/planning
function flattenPipeline(pipeline) {
  return pipeline.flatMap(step =>
    step?._type === 'compound' ? step.steps : [step]
  )
}

export const $ = new Proxy({}, {
  get(_, tableName) {
    // Top-level methods on $ itself (not table-scoped)
    if (tableName === 'shard') return (table = 'accounts') => ({ _type: 'shard', tableName: table })
    return {
      // Row ops — chainable into column ops via makeChainableRowStep
      scope:  (fn) => makeChainableRowStep({ _type: 'scope',  tableName, fn, cascade: true }, tableName),
      filter: (fn) => makeChainableRowStep({ _type: 'filter', tableName, fn }, tableName),
      sample: (n)  => makeChainableRowStep({ _type: 'sample', tableName, n  }, tableName),
      limit:  (n)  => makeChainableRowStep({ _type: 'limit',  tableName, n  }, tableName),

      // Column/field ops — return a chainable table step
      // drop() with no args = drop the whole table
      // drop('col', ...) with args = drop columns (chainable)
      drop:   (...names) => names.length === 0
        ? { _type: 'dropTable', tableName }
        : makeTableStep(tableName).drop(...names),
      truncate:    () => ({ _type: 'truncateTable', tableName }),
      dropExcept:  (...keep) => ({ _type: 'dropExcept', keep }),
      set:    (name, fn)        => makeTableStep(tableName).set(name, fn),
      rename: (from, to)        => makeTableStep(tableName).rename(from, to),
      keep:   (...names)        => makeTableStep(tableName).keep(...names),
      mask:   (name, strategy)  => makeTableStep(tableName).mask(name, strategy),
      redact: (mode, cfg)        => makeTableStep(tableName).redact(mode, cfg),
    }
  }
})

export { maskStrategies, resolveRedactColumns }
