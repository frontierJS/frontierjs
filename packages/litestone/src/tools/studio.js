// studio.js — Litestone Studio's server: \`litestone studio\`. A battery
// (FJS-D635): it reads through createClient and \$setAuth like any caller, and
// nothing under src/core/ imports it. The page is studio.html; the commands'
// shared helpers are cli-helpers.js.

import { existsSync, writeFileSync, readFileSync } from 'fs'
import { resolve, relative, join, dirname, basename } from 'path'
import { spawnSync }                                from 'child_process'
import { openDatabase }                             from '../core/engine.js'
import { parse, parseFile, inlineImports, resolveImportSpecifier, markShipped } from '../core/parser.js'
import { introspect }                               from '../core/migrate.js'
import { schemaAnchor }                             from '../core/db-path.js'
import { resolveTenancy }                           from '../core/tenancy.js'
import { CATALOG, GROUPS, POSITIONS, positionsOf, docFor, synonymsFor, tierFor } from '../core/catalog.js'
import { modelToAccessor }                          from '../core/ddl.js'
import { authModelOf }                              from './principal.js'
import { openSavedQueries, sidecarFor }           from './studio-queries.js'
import { bold, dim, green, red, cyan, rel, header, flag, getFlag,
         loadSchema, getEncKey, resolveDbPath, clientDb, loadGateResolver,
         loadBaselineSchema, parseBaseline, git } from './cli-helpers.js'

// An asset that must survive \`bun build --compile\`: a text import is embedded
// in the binary, a readFileSync beside the source is not.
import STUDIO_HTML from './studio.html' with { type: 'text' }

// ─── EXPLAIN QUERY PLAN parser ────────────────────────────────────────────────
// Converts a SQLite EXPLAIN QUERY PLAN detail string into a rating + advice.
//
// A plan line on its own is not enough to advise on. "USE TEMP B-TREE FOR ORDER
// BY" used to answer "add an index on your ORDER BY column", which is wrong
// whenever that column is the primary key — and it usually is, because the
// default list query orders by it. Measured on `ORDER BY "id"` against a
// `String @id`: adding the advised index changes the plan not at all, because
// the column already carries sqlite_autoindex_<table>_1.
//
// The sort is not a missing index, it is TWO jobs and one index. SQLite uses a
// single index per table here; it spent it on the WHERE, and that index's
// entries are ordered by (its columns, rowid) rather than by the ORDER BY
// column. What removes the sort is one index that does both jobs — the filter
// columns first, the sort columns after. So the advice needs the query, the
// rest of the plan, and the indexes the table actually has.

// The indexes a table really carries, the implicit PRIMARY KEY one included.
//
// PRAGMA takes no bound parameters, so the name has to be interpolated. It is
// resolved through sqlite_master first and the stored name is what gets used —
// never the caller's text (Invariant 8).
function tableIndexes(db, table) {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
    if (!row) return []
    const safe = row.name.replace(/"/g, '""')
    return db.prepare(`PRAGMA index_list("${safe}")`).all().map(ix => ({
      name:    ix.name,
      cols:    db.prepare(`PRAGMA index_info("${ix.name.replace(/"/g, '""')}")`).all().map(c => c.name),
      unique:  !!ix.unique,
      partial: !!ix.partial,
      // 'pk' is the index PRIMARY KEY created for you; 'c' is one you declared.
      implicit: ix.origin === 'pk' || ix.origin === 'u',
      sql:     db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(ix.name)?.sql ?? null,
    }))
  } catch { return [] }
}

// The columns named in the statement's own ORDER BY. Deliberately shallow: a
// subquery's ORDER BY would be a different table's problem, so anything that
// does not parse cleanly returns nothing and the advice stays general.
function orderByColumns(sql) {
  const m = /\border\s+by\s+([^)]+?)(?:\s+limit\b|\s+offset\b|;|$)/is.exec(sql ?? '')
  if (!m) return []
  return m[1].split(',')
    .map(part => part.trim()
      .replace(/\s+(asc|desc)$/i, '')
      .replace(/\s+(nulls\s+(first|last))$/i, '')
      .replace(/^.*\./, '')            // drop a table qualifier
      .replace(/^["'`\[]|["'`\]]$/g, ''))
    .filter(c => /^\w+$/.test(c))      // an expression is not a column
}

// The table this plan line is about, and the index it settled on.
function planTarget(detail) {
  const m = /^(?:SEARCH|SCAN)\s+"?(\w+)"?/i.exec(detail)
  return {
    table: m?.[1] ?? null,
    index: /USING\s+(?:COVERING\s+)?INDEX\s+"?([\w-]+)"?/i.exec(detail)?.[1] ?? null,
  }
}

// The concrete advice for a temp sort: name what is already indexed, then give
// the one index that would do both jobs.
function adviseOrderBySort(ctx) {
  const GENERAL = {
    advice: '<b>Temp sort</b> — SQLite sorted the results itself because no single index both '
          + 'satisfied the WHERE and returned rows in the ORDER BY order.',
    sql: null,
  }
  if (!ctx?.db || !ctx.sql) return GENERAL

  const cols = orderByColumns(ctx.sql)
  if (!cols.length) return GENERAL

  // The sort belongs to whichever table this plan actually reads. With more
  // than one, which ORDER BY column belongs to which table is a guess.
  const targets = (ctx.planRows ?? []).map(r => planTarget(r.detail ?? '')).filter(t => t.table)
  const tables  = [...new Set(targets.map(t => t.table))]
  if (tables.length !== 1) return GENERAL

  const table   = tables[0]
  const indexes = tableIndexes(ctx.db, table)
  if (!indexes.length) return GENERAL

  const chosenName = targets.find(t => t.index)?.index ?? null
  const chosen     = indexes.find(ix => ix.name === chosenName) ?? null

  // Is the ORDER BY already indexed? This is the whole reason the old advice
  // was wrong, so it is said out loud rather than implied.
  const alreadyIndexed = indexes.find(ix => cols.every((c, i) => ix.cols[i] === c))
  const already = alreadyIndexed
    ? `<b>${cols.join(', ')}</b> is already indexed (${alreadyIndexed.implicit
        ? 'the implicit index on its PRIMARY KEY / UNIQUE'
        : alreadyIndexed.name}), so a second index on it alone changes nothing. `
    : ''

  // One index doing both jobs: the filter columns lead, the sort columns follow.
  // The chosen index's own columns ARE the filter it was picked for, which is
  // steadier than re-parsing the constraint out of the plan string.
  const lead     = chosen ? chosen.cols : []
  const combined = [...lead, ...cols.filter(c => !lead.includes(c))]
  if (!lead.length || combined.length === lead.length) {
    return {
      advice: `${already}<b>Temp sort</b> — nothing here returns rows in ${cols.join(', ')} order. `
            + `Add an index leading with your WHERE columns and ending with ${cols.join(', ')}.`,
      sql: null,
    }
  }

  // Carry the chosen index's partial clause across. Litestone's own soft-delete
  // index is partial, and a partial replacement stays the same size.
  const where = chosen.partial
    ? / (WHERE .+)$/i.exec(chosen.sql ?? '')?.[1] ?? ''
    : ''
  const name  = `idx_${table}_${combined.join('_')}`
  const quoted = combined.map(c => `"${c}"`).join(', ')

  return {
    advice: `${already}<b>Temp sort</b> — SQLite spent its one index on the WHERE `
          + `(<b>${chosen.name}</b>), and that index returns rows in ${lead.join(', ')} order, not `
          + `${cols.join(', ')} order. One index that does both jobs removes the sort: `
          + `filter columns first, sort columns last.`,
    sql: `CREATE INDEX "${name}" ON "${table}" (${quoted})${where ? ' ' + where : ''};`
       + `\n-- in the schema: @@index([${combined.join(', ')}])`,
  }
}

function parsePlanDetail(detail, ctx) {
  const d = detail.toUpperCase()

  // Full table scan — worst case
  if (/^SCAN\b/.test(d) && !d.includes('COVERING INDEX') && !d.includes('USING INDEX')) {
    const tbl = detail.match(/^SCAN\s+"?(\w+)"?/i)?.[1] ?? 'table'
    return {
      rating: 'red',
      advice: `<b>Full table scan</b> on "${tbl}" — every row is read. Add an index on the column(s) in your WHERE clause.`,
    }
  }

  // Temp B-tree for ORDER BY or GROUP BY — sort without index
  if (d.includes('TEMP B-TREE FOR ORDER BY')) {
    return { rating: 'yellow', ...adviseOrderBySort(ctx) }
  }
  if (d.includes('TEMP B-TREE FOR GROUP BY')) {
    return {
      rating: 'yellow',
      advice: `<b>Temp sort</b> — GROUP BY required a temporary B-tree. An index on the GROUP BY column would eliminate this.`,
    }
  }
  if (d.includes('TEMP B-TREE FOR DISTINCT')) {
    return {
      rating: 'yellow',
      advice: `<b>Temp sort</b> — DISTINCT required a temporary B-tree. An index may help if used with a WHERE clause.`,
    }
  }

  // Index scan — good
  if (d.includes('USING COVERING INDEX')) {
    return {
      rating: 'green',
      advice: 'Covering index — all needed columns are in the index, no row lookups required. Optimal.',
    }
  }
  if (d.includes('USING INDEX')) {
    return { rating: 'green', advice: 'Index scan — query is using an index.' }
  }

  // PK lookup — best
  if (d.includes('INTEGER PRIMARY KEY') || d.includes('USING PRIMARY KEY') || d.includes('ROWID')) {
    return { rating: 'green', advice: 'Primary key lookup — O(log n) via the rowid B-tree. Optimal.' }
  }

  // SEARCH without index qualifier — could still be ok (auto-index)
  if (/^SEARCH\b/.test(d)) {
    if (d.includes('AUTOMATIC') || d.includes('AUTO-INDEX')) {
      return {
        rating: 'yellow',
        advice: `<b>Auto-index</b> — SQLite built a temporary index at query time. Create a permanent index to avoid this overhead.`,
      }
    }
    return { rating: 'green', advice: 'Index-based search.' }
  }

  // Correlated subquery — warn
  if (d.includes('CORRELATED') || d.includes('SUBQUERY')) {
    return {
      rating: 'yellow',
      advice: 'Correlated subquery — runs once per outer row. Consider rewriting as a JOIN.',
    }
  }

  // Multi-index OR
  if (d.includes('MULTI-INDEX OR')) {
    return { rating: 'yellow', advice: 'Multi-index OR — each branch uses an index but results are merged. Generally fine.' }
  }

  // Default — informational
  return { rating: 'green', advice: null }
}

// ─── Studio ───────────────────────────────────────────────────────────────────

export async function cmdStudio(cfg) {
  header('litestone studio')

  const { isSoftDelete }  = await import('../core/ddl.js')
  const { statSync, readdirSync } = await import('fs')
  const { createClient }  = await import('../core/client.js')
  const { status: migStatus, apply: migApply, autoMigrate: migAuto,
          create: migCreate, createForDatabase: migCreateForDb } = await import('../core/migrations.js')
  const { diffSchemas, buildPristine, generateMigrationSQL, summarizeDiff } = await import('../core/migrate.js')
  const { columnPlan }    = await import('../export.js')

  // 8502 is dev/tooling/project 0/service 2 in the framework's port scheme —
  // the block reserved whole for tools somebody runs beside whatever app they
  // are working on, so the URL is the same tomorrow. Written as a literal
  // because this package sits below the CLI that owns the formula. It was 5001
  // for its whole life, which the scheme had never heard of: the reserved slot
  // answered nothing and the tool sat outside the range (`FJS-557`).
  const port        = parseInt(getFlag('port') ?? '8502')

  // ── --host without --token ────────────────────────────────────────────────
  // Refused here, before the schema is read and before a database is opened, so
  // a misconfigured start costs nothing and leaves no handle behind.
  //
  // The two guards below both work and nothing connected them: `--token` was
  // consulted only inside `if (TOKEN)`, so `--host=0.0.0.0` with no token served
  // `/api/repl` — arbitrary JS holding `db` and `sys` — to every interface, and
  // the pairing was stated in a comment (`FJS-1029`). Advice that fails open
  // reads exactly like a guard.
  //
  // `--readonly` is NOT the substitute: it blocks the REPL and leaves
  // `/api/query`'s SELECT open, which is every row of every table.
  //
  // Loopback is the exemption rather than the absence of `--host`, because
  // `--host=127.0.0.1` is the default said out loud and refusing it would teach
  // people that the flag itself is the problem.
  const hostFlag = getFlag('host') ?? null
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
  if (hostFlag && !LOOPBACK.has(hostFlag) && !getFlag('token') && !flag('insecure')) {
    console.error(`
  ${red('✗')}  ${bold(`--host=${hostFlag}`)} serves Litestone Studio beyond loopback, and it has no
      authentication of its own. Off 127.0.0.1 this exposes, to anything that
      can reach the port:

        POST /api/repl    arbitrary JS holding \`db\` and \`sys\`
        POST /api/query   raw SQL
        POST /api/schema-source, /api/migrations/*   schema and migration writes

      Pair it with a bearer token:

        litestone studio --host=${hostFlag} --token=$(openssl rand -hex 16)

      ${dim('--readonly is not a substitute — it blocks the REPL and leaves /api/query\'s SELECT open.')}
      ${dim('--insecure says you meant it anyway.')}
`)
    process.exit(1)
  }

  const parseResult = loadSchema(cfg.schema)

  // Studio was the only one of the three principal-taking commands that did not
  // accept `--gate`, so every preview here was graded by toolbelt's default
  // `gradeStanding` and nothing said so (`FJS-977`). For an app whose own
  // getLevel reads the same columns that default does, the two agree and the
  // preview is faithful; for one that grades from anywhere else it silently is
  // not, in either direction.
  const gateSpec    = getFlag('gate')
  const appGetLevel = await loadGateResolver(gateSpec)
  const gatePlugins = []
  if (appGetLevel) {
    const { GatePlugin } = await import('../plugins/gate.js')
    gatePlugins.push(new GatePlugin({ getLevel: appGetLevel }))
  }

  const db     = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey(),
                                      ...(gatePlugins.length ? { plugins: gatePlugins } : {}) })
  const rawDb  = db.$db
  const rawDbs = db.$rawDbs
  const savedQueries = openSavedQueries(sidecarFor(rawDb.query('PRAGMA database_list').all().find(d => d.name === 'main')?.file))

  // ── Studio flags ───────────────────────────────────────────────────────────
  // --readonly: block every mutating endpoint (row writes, imports, schema
  //   saves, migrations, maintenance, REPL, non-SELECT SQL, transform runs).
  // --token:    require a bearer token on every /api call. Required by the
  //   --host guard above, which refuses a non-loopback bind without one.
  const READONLY = flag('readonly')   // bare boolean flag — getFlag() returns null for these
  const TOKEN    = getFlag('token') ?? null

  // ── Active database context ────────────────────────────────────────────────
  // Studio normally serves the base client; opening a tenant re-points the
  // data endpoints at that tenant's client. Base migrations/schema editing
  // always target the base project.
  let activeTenant = null
  let activeDb     = db
  let activeRawDb  = rawDb
  let activeRawDbs = rawDbs

  // ── Tenant registry (lazy) ─────────────────────────────────────────────────
  const _schemaDir      = dirname(resolve(cfg.schema))
  // The schema's own block is consulted before the defaults, so Studio's tenant
  // switcher lists the files `litestone tenant list` does. `strategy row` has
  // no files at all, hence the strategy test rather than mere presence.
  const _declaredTenancy = parseResult.schema?.tenancy
    ? resolveTenancy(parseResult.schema, { schemaPath: resolve(cfg.schema) })
    : null
  const _fileTenancy    = _declaredTenancy?.strategy === 'database' ? _declaredTenancy : null
  const _tenantDirOpt   = cfg.tenants?.dir      ? resolve(cfg.tenants.dir)      : (_fileTenancy?.dir      ?? join(_schemaDir, 'tenants'))
  const _tenantRegOpt   = cfg.tenants?.registry ? resolve(cfg.tenants.registry) : (_fileTenancy?.registry ?? join(_schemaDir, 'tenants-registry.db'))
  const tenantsEnabled  = !!cfg.tenants || !!_fileTenancy || existsSync(_tenantRegOpt)
  let   _tenantRegistry = null
  async function getRegistry() {
    if (!_tenantRegistry) {
      const { createTenantRegistry } = await import('../tenant.js')
      _tenantRegistry = await createTenantRegistry({
        parsed:        parseResult,
        path:          resolve(cfg.schema),
        dir:           _tenantDirOpt,
        registry:      _tenantRegOpt,
        migrationsDir: cfg.tenants?.migrationsDir ? resolve(cfg.tenants.migrationsDir) : (existsSync(cfg.migrations) ? cfg.migrations : null),
        encryptionKey: getEncKey() ?? null,
      })
    }
    return _tenantRegistry
  }

  // Build softDeleteMap from the augmented schema so auto-generated models are included
  const softDeleteMap = {}
  for (const model of activeDb.$schema.models)
    softDeleteMap[model.name] = isSoftDelete(model)
  const html        = STUDIO_HTML

  // ── Persistent query log ───────────────────────────────────────────────────
  // Ring buffer fed by $tapQuery — captures every ORM operation Studio's
  // client executes (Browse, edits, REPL, import/export), plus raw SQL-panel
  // queries pushed manually. Newest entries last; capped at QUERY_LOG_MAX.
  const QUERY_LOG_MAX = 2000
  const queryLog = []
  let queryLogSeq = 0
  function pushQueryLog(e) {
    queryLog.push({
      id:        ++queryLogSeq,
      ts:        Date.now(),
      operation: e.operation ?? 'sql',
      model:     e.model ?? null,
      database:  e.database ?? null,
      sql:       typeof e.sql === 'string' ? e.sql : null,
      params:    Array.isArray(e.params) ? e.params.slice(0, 32) : null,
      duration:  typeof e.duration === 'number' ? +e.duration.toFixed(2) : 0,
      rowCount:  e.rowCount ?? null,
      actorId:   e.actorId ?? null,
    })
    if (queryLog.length > QUERY_LOG_MAX) queryLog.splice(0, queryLog.length - QUERY_LOG_MAX)
  }
  const _qlTapped = new WeakSet()
  function tapClient(c) { if (!_qlTapped.has(c)) { c.$tapQuery(pushQueryLog); _qlTapped.add(c) } }
  tapClient(db)

  // Build per-database migration status
  // ── The schema as it is on disk, not as it was at boot ────────────────────
  //
  // Studio parses once at startup and holds the result for the life of the
  // process. Every panel built on that parse describes the file as it was when
  // the server started — and says so with the same confidence it would if the
  // file had not moved. That is the drift the badge exists to report, and the
  // access panel has to read THROUGH it or it would report on a stale surface
  // while telling you the surface has changed.
  //
  // Re-parsed only when the bytes differ, so the common case is a string
  // compare. An edit that does not parse keeps the last good result: a
  // half-typed model should leave the panel showing the last thing that was
  // true, not an empty schema.
  const BOOT_SCHEMA_TEXT = (() => {
    try { return readFileSync(resolve(cfg.schema), 'utf8') } catch { return null }
  })()

  let _liveParse = { text: BOOT_SCHEMA_TEXT, parsed: parseResult }

  function currentSchemaParse() {
    try {
      const text = readFileSync(resolve(cfg.schema), 'utf8')
      if (text === _liveParse.text) return _liveParse.parsed
      // The cache key is the ROOT file's text, so an edit to an imported file
      // alone does not invalidate it. Studio reloads on a touch of the schema
      // it was pointed at; that is the granularity, not a claim about imports.
      const next = parseFile(resolve(cfg.schema))
      if (!next.valid) return _liveParse.parsed
      _liveParse = { text, parsed: next }
      return next
    } catch { return _liveParse.parsed }
  }

  function getAllMigrationStatus() {
    const result = {}
    for (const db of parseResult.schema.databases) {
      if (db.driver === 'jsonl' || db.driver === 'logger') continue
      const handle = rawDbs[db.name]
      if (!handle) continue
      try { result[db.name] = migStatus(handle, join(cfg.migrations, db.name)) } catch { result[db.name] = [] }
    }
    // Single-DB schemas have no database blocks — use main connection
    if (!Object.keys(result).length)
      try { result.main = migStatus(rawDb, cfg.migrations) } catch { result.main = [] }
    return result
  }

  // ── What the data panels are actually reading ─────────────────────────────
  //
  // Two different ways an answer about the live database can describe a
  // database nobody runs, and neither is visible from the answer.
  //
  // Under `tenancy { strategy database }` the rows live in a file per tenant
  // and the declared `database main` path is opened by every reader that is
  // NOT a fleet — Studio included. Nothing migrates that file after Studio
  // creates it, so a panel comparing the schema to its DDL answers about a
  // skeleton frozen at whatever the schema said the first time Studio ran
  // (`FJS-993`). The other way is ordinary: an open database can simply be
  // behind the file it is being graded against.
  //
  // This travels WITH the answer rather than sitting on a badge, because the
  // reading and the caveat are read at different moments otherwise.
  async function diffAgainstSchema(dbName, handle) {
    const { buildPristineForDatabase } = await import('../core/migrate.js')
    const pristineDb = openDatabase(':memory:')
    try {
      const pristine = buildPristineForDatabase(pristineDb, parseResult, dbName)
      const live     = introspect(handle)
      return diffSchemas(pristine, live, parseResult, dbName, { pluralize: cfg.pluralize })
    } finally { pristineDb.close() }
  }

  // `reason` is what a panel renders INSTEAD of an answer; `behind` heads one
  // it still gives. They are separate because a tenant that is behind has real
  // findings and the base skeleton has none worth showing.
  async function activeDatabaseSource() {
    const meta = activeDb.$databases?.main
    const path = (meta && (!meta.driver || meta.driver === 'sqlite') && meta.path)
      || (cfg.db ? resolve(cfg.db) : null)
    const src  = { path, tenant: activeTenant, tenantsEnabled, reason: null, behind: null }

    if (tenantsEnabled && !activeTenant) { src.reason = 'no-tenant'; return src }

    try {
      const diff = await diffAgainstSchema('main', activeRawDbs?.main ?? activeRawDb)
      if (diff.hasChanges) src.behind = summarizeDiff(diff)
    } catch { /* an unreadable handle is the caller's problem, not this field's */ }
    return src
  }

  async function getRowCounts() {
    const counts = {}
    const sysDb  = activeDb.asSystem()  // bypass policies — counts should reflect actual data
    for (const model of activeDb.$schema.models) {
      const accessor = modelToAccessor(model.name)
      try { counts[model.name] = await sysDb[accessor].count() } catch { counts[model.name] = 0 }
    }
    return counts
  }

  function getDbStats() {
    try {
      // Use db.$databases — canonical source of { driver, access, path } per named DB.
      // Falls back to a synthetic 'main' entry for single-DB schemas.
      const dbMeta  = activeDb.$databases  // { name: { driver, access, path } }
      const entries = Object.keys(dbMeta).length
        ? Object.entries(dbMeta)
        : [['main', { driver: 'sqlite', path: cfg.db ? resolve(cfg.db) : null }]]

      const databases = []
      let rollupSize = 0, rollupRows = 0, rollupTables = 0, rollupIndexes = 0

      for (const [name, meta] of entries) {
        const { driver = 'sqlite', path: absPath } = meta

        if (driver === 'jsonl' || driver === 'logger') {
          // No SQLite connection — report file/dir size only
          let size = 0
          if (absPath) {
            try {
              const st = statSync(absPath)
              if (st.isDirectory()) {
                size = readdirSync(absPath)
                  .filter(f => f.endsWith('.jsonl'))
                  .reduce((acc, f) => { try { return acc + statSync(`${absPath}/${f}`).size } catch { return acc } }, 0)
              } else {
                size = st.size
              }
            } catch { /* path may not exist yet */ }
          }
          rollupSize += size
          databases.push({ name, driver, size })
          continue
        }

        // SQLite database
        const conn  = activeRawDbs?.[name] ?? activeRawDb
        const entry = { name, driver: 'sqlite', size: 0 }

        if (absPath) {
          try { entry.size = existsSync(absPath) ? statSync(absPath).size : 0 } catch {}
        }

        try {
          entry.pageSize      = conn.query('PRAGMA page_size').get().page_size
          entry.pageCount     = conn.query('PRAGMA page_count').get().page_count
          entry.freelistCount = conn.query('PRAGMA freelist_count').get().freelist_count
          entry.walMode       = conn.query('PRAGMA journal_mode').get().journal_mode === 'wal'
          entry.foreignKeys   = conn.query('PRAGMA foreign_keys').get().foreign_keys === 1

          const tables = conn.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`
          ).all().map(r => r.name)

          entry.indexCount  = conn.query(`SELECT COUNT(*) as n FROM sqlite_master WHERE type='index'`).get().n
          entry.tableCount  = tables.length
          entry.tables      = {}
          entry.totalRows   = 0

          for (const t of tables) {
            const n = conn.query(`SELECT COUNT(*) as n FROM "${t}"`).get().n
            entry.tables[t] = n
            entry.totalRows += n
          }

          rollupRows    += entry.totalRows
          rollupTables  += entry.tableCount
          rollupIndexes += entry.indexCount
        } catch (innerErr) {
          entry.error = innerErr.message
        }

        rollupSize += entry.size
        databases.push(entry)
      }

      // cacheSize from main connection
      const cs        = db.$cacheSize
      const cacheSize = cs?.read != null ? cs : (cs?.main ?? { read: 0, write: 0 })

      // Flat fields for the header bar (main DB values)
      const mainEntry = databases.find(d => d.name === 'main') ?? databases[0] ?? {}

      return {
        databases,
        // header rollups
        size:         rollupSize,
        pageCount:    mainEntry.pageCount  ?? 0,
        tableCount:   rollupTables,
        indexCount:   rollupIndexes,
        totalRows:    rollupRows,
        cacheSize,
        // flat shape kept for backwards-compat (perf panel, etc.)
        pageSize:      mainEntry.pageSize,
        freelistCount: mainEntry.freelistCount,
        walMode:       mainEntry.walMode,
        foreignKeys:   mainEntry.foreignKeys,
        tables:        Object.assign({}, ...databases.map(d => d.tables ?? {})),
      }
    } catch (e) {
      console.error('[litestone:studio] getDbStats error:', e)
      return {}
    }
  }
  function json(data, status = 200) {
    return Response.json(data, { status })
  }

  // ── Server-side search / sort helpers for /api/table and /api/table-dump ──
  // Turns the Browse filter box text into a real WHERE clause: substring match
  // on String fields, exact match on numeric fields when the query is numeric,
  // prefix match on DateTime fields when the query looks date-ish.
  function buildSearchWhere(model, search) {
    const q = typeof search === 'string' ? search.trim() : ''
    if (!q) return undefined
    const or  = []
    const num = Number(q)
    const numeric = q !== '' && !Number.isNaN(num)
    for (const f of model.fields) {
      if (f.type.kind === 'relation' || f.type.array) continue
      if (f.attributes?.some(a => ['computed', 'transient', 'guarded', 'secret', 'encrypted', 'omit'].includes(a.kind))) continue
      const t = f.type.name
      if (t === 'String')                      or.push({ [f.name]: { contains: q } })
      else if ((t === 'Int' || t === 'Float') && numeric) or.push({ [f.name]: num })
      else if (t === 'DateTime' && /^\d{4}(-\d{2})?(-\d{2})?/.test(q)) or.push({ [f.name]: { gte: q, lt: q + '~' } })
    }
    // No matchable protected field fits this query shape → return an impossible
    // filter (empty `in` compiles to 0 = 1) so the result is "no rows"
    // rather than silently unfiltered.
    return or.length ? { OR: or } : { [model.fields[0]?.name ?? 'id']: { in: [] } }
  }

  function buildOrderBySpec(model, orderBy) {
    const hasId = model.fields.some(f => f.name === 'id')
    const fallback = hasId ? { id: 'asc' } : undefined
    if (!orderBy?.col) return fallback
    const f = model.fields.find(f => f.name === orderBy.col && f.type.kind !== 'relation')
    if (!f) return fallback
    const dir  = orderBy.dir === 'desc' ? 'desc' : 'asc'
    // Tie-break on id (when present and not already the sort column) so
    // cursor pagination stays stable on non-unique sort columns.
    return (hasId && orderBy.col !== 'id') ? [{ [orderBy.col]: dir }, { id: 'asc' }] : { [orderBy.col]: dir }
  }

  // ── "Give me this view as a query" ────────────────────────────────────────
  // Browse already builds a real Litestone query object on every load and then
  // throws it away. These render it back so the view can be copied into a
  // service or the REPL.

  // JS source, not JSON: unquoted keys where legal, single quotes, so what is
  // copied can be pasted. JSON.stringify would quote every key and force the
  // reader to edit it before it matches anything else in the codebase.
  // Bumped per generated row so two clicks are not the same row.
  let factorySeq = 0

  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
  function jsLiteral(v, indent = '') {
    if (v === null || v === undefined) return String(v)
    if (typeof v === 'string')  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    if (typeof v !== 'object')  return String(v)
    const inner = indent + '  '
    if (Array.isArray(v)) {
      if (!v.length) return '[]'
      const parts = v.map(x => jsLiteral(x, inner))
      const flat  = `[${parts.join(', ')}]`
      return flat.length <= 72 ? flat : `[\n${parts.map(p => inner + p).join(',\n')}\n${indent}]`
    }
    const entries = Object.entries(v).filter(([, val]) => val !== undefined)
    if (!entries.length) return '{}'
    const parts = entries.map(([k, val]) => `${IDENT.test(k) ? k : `'${k}'`}: ${jsLiteral(val, inner)}`)
    const flat  = `{ ${parts.join(', ')} }`
    return flat.length <= 72 ? flat : `{\n${parts.map(p => inner + p).join(',\n')}\n${indent}}`
  }

  // The client flavor is part of the query. A view browsed as a user and the
  // same args run through asSystem() return different rows, so emitting the
  // args alone hands back something that silently does not reproduce the view.
  function buildViewQuery(accessor, authCtx, args) {
    const argsCode = jsLiteral(args)
    const client   = authCtx ? 'db.$setAuth(user)' : 'db.asSystem()'
    // The REPL binds `db` already scoped from the auth selector, so its form
    // states no client — restating one there would scope the call twice.
    return {
      accessor,
      client,
      clientNote: authCtx
        ? `Browsed as ${authCtx.email ?? authCtx.name ?? `#${authCtx.id}`} — \`user\` stands in for that principal.`
        : 'Browsed with no principal selected, which Litestone Studio runs as asSystem().',
      args,
      argsCode,
      code:     `await ${client}.${accessor}.findMany(${argsCode})`,
      replCode: `db.${accessor}.findMany(${argsCode})`,
    }
  }

  // Bind to loopback by default — Studio exposes raw SQL, a JS REPL, and
  // schema writes. A non-loopback --host is refused above unless it carries a
  // --token, so by the time this runs the bind is either loopback or authed.
  const hostname = hostFlag ?? '127.0.0.1'
  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url  = new URL(req.url)
      const path = url.pathname
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}

      if (path === '/' || path === '/index.html')
        return new Response(html, { headers: { 'Content-Type': 'text/html' } })

      if (!path.startsWith('/api/')) return new Response('Not Found', { status: 404 })

      // ── Token auth (--token) ────────────────────────────────────────────────
      if (TOKEN) {
        const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token')
        if (given !== TOKEN) return json({ error: 'Unauthorized — pass ?token= or Authorization: Bearer' }, 401)
      }

      // ── Read-only mode (--readonly) ─────────────────────────────────────────
      if (READONLY) {
        const MUTATING = ['/api/row/', '/api/rows/', '/api/import', '/api/repl', '/api/factory',
          '/api/migrations/apply', '/api/migrations/auto', '/api/migrations/create',
          '/api/maint/', '/api/transform/run', '/api/tenants/migrate', '/api/perf/advisor/fix']
        if (MUTATING.some(p => path.startsWith(p)) && path !== '/api/maint/integrity')
          return json({ error: 'Litestone Studio is running in --readonly mode' }, 403)
        if (path === '/api/schema-source' && req.method !== 'GET')
          // allow validation, block the save
          if (!path.endsWith('validate')) return json({ error: 'Litestone Studio is running in --readonly mode' }, 403)
        if (path === '/api/query') {
          const q = (body.sql ?? '').trim().toUpperCase()
          if (!/^(SELECT|EXPLAIN|WITH|PRAGMA TABLE_INFO|PRAGMA INDEX_LIST|PRAGMA FOREIGN_KEY_LIST)/.test(q))
            return json({ error: 'Only SELECT/EXPLAIN queries are allowed in --readonly mode' }, 403)
        }
      }

      try {
        if (path === '/api/info') {
          const stats     = getDbStats()
          const counts    = await getRowCounts()
          // Use db.$schema — the augmented schema that includes auto-generated
          // logger models (e.g. auditLogs) and view stubs. parseResult.schema
          // is the raw parsed result and is missing these synthetic models.
          const liveSchema = activeDb.$schema
          const multiDb   = liveSchema.databases.some(db => !db.driver || db.driver === 'sqlite')
          const databases = liveSchema.databases.map(db => ({
            name:   db.name,
            driver: db.driver ?? 'sqlite',
          }))
          // Which file is `main`? Asked of the CLIENT, because a declaration wins
          // over `cfg.db`, which loadConfig always answers — `./development.db`
          // when nothing said otherwise. So every app that declares its databases
          // was told through this field that it was on a file the studio had
          // never opened. The printed banner asks the schema for the same reason
          // (`FJS-449`); this field went on answering the default.
          const mainMeta = activeDb.$databases?.main
          const mainPath = (mainMeta && (!mainMeta.driver || mainMeta.driver === 'sqlite') && mainMeta.path)
            || (cfg.db ? resolve(cfg.db) : null)
          return json({
            dbPath:     mainPath,
            schema:     liveSchema,
            softDelete: softDeleteMap,
            stats,
            counts,
            multiDb,
            databases,
            tenantsEnabled,
            activeTenant,
            readonly: READONLY,
          })
        }

        if (path === '/api/table') {
          const { table, cursor, withDeleted = false, auth: authCtx, search, orderBy, pageSize } = body
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const limit    = Math.max(10, Math.min(500, parseInt(pageSize) || 50))
          const where    = buildSearchWhere(model, search)
          const ob       = buildOrderBySpec(model, orderBy)
          const result   = await tableDb[accessor].findManyCursor({ cursor, limit, where, withDeleted, orderBy: ob })
          // Filtered total so the UI can show "N matching rows" (best effort)
          let total = null
          try { total = await tableDb[accessor].count({ where, withDeleted }) } catch {}
          const columns  = model.fields
            .filter(f => f.type.kind !== 'relation' && !f.attributes.find(a => a.kind === 'computed' || a.kind === 'transient'))
            .map(f => f.name) ?? []
          // findMany, not findManyCursor: `cursor` is opaque paging state that
          // means nothing pasted elsewhere. The filter and the sort are the
          // parts worth copying, so the query describes page one of this view.
          const query = buildViewQuery(accessor, authCtx, {
            where,
            orderBy: ob,
            limit,
            ...(withDeleted ? { withDeleted: true } : {}),
          })
          return json({ ...result, columns, total, query, paged: Boolean(cursor) })
        }

        // POST /api/row/restore — un-soft-delete a single row
        if (path === '/api/row/restore') {
          const { table, where, auth: authCtx } = body
          if (!table || !where) return json({ error: 'table, where required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            const result   = await tableDb[accessor].restore({ where })
            return json({ ok: true, count: result?.count ?? 0 })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/rows/bulk — bulk delete / hard-delete / restore by PK list
        if (path === '/api/rows/bulk') {
          const { table, action, ids, auth: authCtx } = body
          if (!table || !action || !Array.isArray(ids) || !ids.length)
            return json({ error: 'table, action, ids[] required' }, 400)
          if (ids.length > 10_000) return json({ error: 'Too many ids (max 10,000 per request)' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const idField  = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
            const where    = { [idField]: { in: ids } }
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            let count = 0
            if (action === 'delete') {
              const r = await tableDb[accessor].removeMany({ where })
              count = r?.count ?? 0
            } else if (action === 'hardDelete') {
              const r = await tableDb[accessor].deleteMany({ where })
              count = r?.count ?? 0
            } else if (action === 'restore') {
              const r = await tableDb[accessor].restore({ where })
              count = r?.count ?? 0
            } else {
              return json({ error: `Unknown action: ${action}` }, 400)
            }
            return json({ ok: true, count })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/table-dump — stream the FULL (filtered) table as CSV or JSON.
        //
        // NOT an export. `@@export` + `litestone export` is the governed extract
        // — a declared dataset, a gate required beside it, protected columns
        // omitted unless asked, and a manifest stamping who took it. This is the
        // owner's view of a table, and it is Studio's because Studio previews
        // (`FJS-D230`). One word may not mean both (`FJS-978`).
        if (path === '/api/table-dump') {
          const { table, format = 'json', search, withDeleted = false, auth: authCtx } = body
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const where    = buildSearchWhere(model, search)
          const ob       = buildOrderBySpec(model, null)
          // `columnPlan` is the one owner of *which columns leave*, shared with
          // `litestone export`. Studio had a second list here that knew about
          // relations, `@computed` and `@transient` and nothing about
          // protection, so the default branch below — `asSystem()`, which is
          // what an operator who has chosen no principal gets — wrote `@secret`
          // and `@guarded` values in plaintext into a downloadable CSV
          // (`FJS-976`).
          //
          // There is no way to ask for them back here, deliberately. A dump is
          // a preview and `fli db:export --include-protected` is the path that
          // records the decision (`FJS-D230`).
          const plan     = columnPlan(model, { includeProtected: false })
          const cols     = plan.columns.map(c => c.name)
          const withheld = plan.omitted.filter(o => o.reason === 'protected')
          const enc = new TextEncoder()
          const csvCell = (v) => {
            if (v == null) return ''
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          }
          const stream = new ReadableStream({
            async start(controller) {
              try {
                let cursor = null
                let first  = true
                controller.enqueue(enc.encode(format === 'csv' ? cols.join(',') + '\n' : '[\n'))
                while (true) {
                  const page = await tableDb[accessor].findManyCursor({ cursor, limit: 1000, where, withDeleted, orderBy: ob })
                  for (const row of page.items) {
                    if (format === 'csv') {
                      controller.enqueue(enc.encode(cols.map(c => csvCell(row[c])).join(',') + '\n'))
                    } else {
                      controller.enqueue(enc.encode((first ? '' : ',\n') + '  ' + JSON.stringify(row)))
                      first = false
                    }
                  }
                  if (!page.hasMore || !page.nextCursor) break
                  cursor = page.nextCursor
                }
                if (format !== 'csv') controller.enqueue(enc.encode('\n]\n'))
                controller.close()
              } catch (e) { controller.error(e) }
            }
          })
          return new Response(stream, { headers: {
            'Content-Type':        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${accessor}.${format === 'csv' ? 'csv' : 'json'}"`,
            // A file with columns missing and nothing saying so is the shape
            // somebody reconciles against a year later and gets wrong.
            'X-Withheld-Columns':  withheld.map(o => `${o.name} ${o.by}`).join(', '),
          }})
        }

        // POST /api/import — batched row import (client parses CSV/JSON to rows)
        if (path === '/api/import') {
          const { table, rows, auth: authCtx } = body
          if (!table || !Array.isArray(rows) || !rows.length)
            return json({ error: 'table, rows[] required' }, 400)
          if (rows.length > 50_000) return json({ error: 'Too many rows in one request (max 50,000)' }, 400)
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const BATCH    = 500
          let inserted   = 0
          const errors   = []
          for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH)
            try {
              const r = await tableDb[accessor].createMany({ data: batch })
              inserted += r?.count ?? batch.length
            } catch (e) {
              // Batch failed — retry row-by-row so one bad row doesn't sink 500
              for (let j = 0; j < batch.length; j++) {
                try { await tableDb[accessor].create({ data: batch[j] }); inserted++ }
                catch (rowErr) {
                  if (errors.length < 50) errors.push({ row: i + j + 1, error: rowErr.message })
                }
              }
            }
          }
          return json({ ok: errors.length === 0, inserted, failed: rows.length - inserted, errors })
        }

        if (path === '/api/query') {
          const { sql } = body
          if (!sql?.trim()) return json({ rows: [] })
          const t0   = performance.now()
          try {
            const rows = activeRawDb.prepare(sql.trim()).all()
            const ms   = (performance.now() - t0).toFixed(1)
            pushQueryLog({ operation: 'sql', sql: sql.trim(), duration: performance.now() - t0, rowCount: rows.length, database: 'main' })
            return json({ rows, ms })
          } catch (e) {
            pushQueryLog({ operation: 'sql', sql: sql.trim(), duration: performance.now() - t0, rowCount: 0, database: 'main' })
            throw e
          }
        }

        // POST /api/querylog — incremental fetch of the query log ring buffer
        if (path === '/api/querylog') {
          if (body.clear) { queryLog.length = 0; return json({ entries: [], cleared: true }) }
          const after = Number(body.after) || 0
          // Entries are id-ordered; find the first entry newer than `after`
          let start = 0
          if (after > 0) {
            start = queryLog.findIndex(e => e.id > after)
            if (start === -1) return json({ entries: [], latest: queryLogSeq, total: queryLog.length })
          }
          const entries = queryLog.slice(start, start + 500)
          return json({ entries, latest: queryLogSeq, total: queryLog.length })
        }

        if (path === '/api/migrations') {
          const allStatus = getAllMigrationStatus()

          // Build per-database diff summaries for multi-DB schemas
          const diffs = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const diffResult = await diffAgainstSchema(dbName, handle)
              diffs[dbName] = {
                diff: summarizeDiff(diffResult),
                sql:  diffResult.hasChanges ? generateMigrationSQL(diffResult, parseResult, { pluralize: cfg.pluralize }) : null,
              }
            } catch (e) { diffs[dbName] = { diff: e.message, sql: null } }
          }

          return json({ status: allStatus, diffs, multiDb: parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite') })
        }

        // ── GET /api/access ─────────────────────────────────────────────
        // The declared access surface, straight from deriveAccess(). One
        // formatter existed for this — the committed access.snapshot.md — and
        // it is good at being reviewed and bad at being read: 37 rows of
        // "4.4.4.5" answers *what does this model require* and never *what can
        // a level-4 caller do*. Same object, second reader.
        //
        // Read-only by construction, so --readonly needs no case here. The
        // payload is the same information the repo already commits in plain
        // text beside the schema, so it exposes nothing the schema did not.
        if (path === '/api/access') {
          const { deriveAccess } = await import('../access.js')
          return json(deriveAccess(currentSchemaParse().schema))
        }

        // ── GET /api/seed · POST /api/seed/run ──────────────────────────
        //
        // A database nothing has seeded is empty for the ordinary reason, and
        // Studio's answer to that was `No rows` on every table — the same
        // sentence a broken query produces. The app already says what its seed
        // is, in the one place it says what all its commands are, so this reads
        // `package.json` rather than guessing from a filename: `db/seed.ts` is
        // a convention and `"db:seed"` is a statement.
        //
        // **The command is a LOOKUP, exactly like the compare panel's ref.** The
        // client sends nothing — it asks to run *the seed*, and the server
        // resolves which script that is from a fixed list of names it knows.
        // Nothing caller-supplied reaches the argv, and the spawn is
        // shell-free, so the script's own text cannot be a second command here
        // however it is written.
        if (path === '/api/seed') return json(findSeed(cfg))

        if (path === '/api/seed/run') {
          if (READONLY) return json({ error: 'Litestone Studio is running in --readonly mode' }, 403)
          const seed = findSeed(cfg)
          if (!seed.script) return json({ error: seed.why ?? 'This project declares no seed' }, 400)

          // Run it where the app lives, not where Studio was started, or a seed
          // reading `./db/...` writes into a path that does not exist.
          const run = spawnSync('bun', ['run', seed.script], {
            cwd: seed.root, encoding: 'utf8', shell: false,
            timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
          })

          // Both streams, always. A seeder that prints its progress to stdout
          // and its refusal to stderr is the common shape, and showing one of
          // them is how a failed run reads as a silent one.
          const output = [run.stdout ?? '', run.stderr ?? ''].filter(Boolean).join('\n').trim()
          return json({
            ok:      run.status === 0,
            code:    run.status,
            timedOut: run.error?.code === 'ETIMEDOUT',
            command: seed.command,
            output:  output.slice(-20000),
          })
        }

        // ── GET /api/refs · POST /api/compare ───────────────────────────
        // What this branch did to the database and to who may do what.
        //
        // Every other panel answers *what is true now*. Two shipped commands
        // answer *what changed* — `litestone release --from` (can N-1 and N
        // serve one database at once) and `litestone access --from` (who may
        // now do more) — and neither had a surface, so the question you ask
        // last, with the most at stake, was the one thing Studio could not be
        // asked.
        //
        // **A REF IS NOT CALLER-SUPPLIED TEXT HERE.** `fli proves` takes no ref
        // over HTTP for exactly this reason: the value ends up on a git command
        // line, and `loadBaselineSchema` reads a plain FILE when one exists by
        // that name. So the server ENUMERATES the candidates and the client
        // picks one BY NAME from that list; the name is looked up and the
        // resolved SHA is what travels onward (Invariant 8's rule, one realm
        // over). A 40-hex sha is also never a path that exists, which closes
        // the file branch by construction rather than by argument.
        if (path === '/api/refs')    return json({ refs: gitBaselineRefs(cfg.schema) })

        if (path === '/api/compare') {
          const refs  = gitBaselineRefs(cfg.schema)
          const asked = refs.find(r => r.name === body.ref)
          if (!asked) return json({ error: `Unknown ref '${body.ref}' — pick one this repository listed` }, 400)

          const { deriveReleaseSurface, classifyPivot, classifyAccess, capabilityDrift } =
            await import('../release.js')

          const schemaPath = resolve(cfg.schema)
          const parsed     = currentSchemaParse()
          if (!parsed.schema) return json({ error: 'The schema on disk does not parse — fix it before comparing.' }, 400)

          const after    = deriveReleaseSurface(parsed.schema)
          const baseline = loadBaselineSchema(asked.sha, schemaPath)
          const before   = baseline.text ? parseBaseline(baseline.text, false, deriveReleaseSurface) : null

          if (!before?.surface) {
            return json({
              ref:   asked,
              error: before?.error ?? baseline.note ?? 'no baseline at that ref',
            })
          }

          // Both axes off ONE walk each of the same two surfaces. They
          // disagree by construction — removing a @@gate is an `expand` and the
          // widest thing a schema change can do — so they are two answers and
          // never one badge.
          const deploy = classifyPivot(before.surface, after)
          const access = classifyAccess(before.surface, after)
          const drift  = capabilityDrift(before.surface, after)

          return json({
            ref:    asked,
            note:   before.note ?? baseline.note ?? null,
            deploy: { verdict: deploy.verdict, counts: deploy.counts, findings: deploy.findings },
            access: { verdict: access.verdict, counts: access.counts, findings: access.findings },
            drift:  drift?.lost?.length ? drift : null,
          })
        }

        // ── GET /api/drift ──────────────────────────────────────────────
        // Three questions that are not the same question, kept apart on
        // purpose: one badge saying "out of date" would blur them.
        //
        //   file      — has schema.lite changed since Studio parsed it?
        //   snapshot  — does the committed access.snapshot.md still match it?
        //   migrations— is anything pending/modified/orphaned?
        //
        // `file` is first because the other two are worthless without it:
        // Studio parses once at boot and holds the result for the life of the
        // process, so an edit made in an editor leaves every panel describing
        // the previous version, confidently.
        if (path === '/api/drift') {
          const out = { file: null, snapshot: null, migrations: null }

          // ── file ──
          try {
            const onDisk = readFileSync(resolve(cfg.schema), 'utf8')
            out.file = {
              path:    rel(resolve(cfg.schema)),
              changed: onDisk !== BOOT_SCHEMA_TEXT,
            }
          } catch (e) { out.file = { error: e.message } }

          // ── snapshot ──
          // Rendered from what is on disk NOW, not from the boot parse, or a
          // schema edited since startup would be compared against itself.
          try {
            const { deriveAccess, renderAccessSnapshot } = await import('../access.js')
            const snapPath = join(dirname(resolve(cfg.schema)), 'access.snapshot.md')
            if (!existsSync(snapPath)) {
              // Absent is not "no drift" — it is "I cannot judge this", the
              // same distinction db.$checkWhere makes for an unknown accessor.
              out.snapshot = { exists: false, path: rel(snapPath) }
            } else {
              const live = currentSchemaParse()
              const body = renderAccessSnapshot(deriveAccess(live.schema),
                                                { source: basename(resolve(cfg.schema)) })
              out.snapshot = {
                exists:  true,
                path:    rel(snapPath),
                current: readFileSync(snapPath, 'utf8') === body,
                command: `litestone access --schema ${rel(resolve(cfg.schema))}`,
              }
            }
          } catch (e) { out.snapshot = { error: e.message } }

          // ── migrations ──
          try {
            const counts = { pending: 0, modified: 0, orphaned: 0 }
            for (const rows of Object.values(getAllMigrationStatus()))
              for (const r of rows) if (counts[r.state] !== undefined) counts[r.state]++
            out.migrations = counts
          } catch (e) { out.migrations = { error: e.message } }

          return json(out)
        }

        // The catalog is the .lite language itself rather than this app's use of
        // it, so it is served whole and never filtered by what the schema
        // happens to declare — a word with no rows is exactly what the explorer
        // exists to show.
        // Positions are computed here rather than sent as a rule the panel
        // re-applies: one implementation of "where is this legal", and the
        // browser gets an answer instead of a second copy of POSITION_RULES.
        if (path === '/api/catalog')
          return json({
            catalog:   CATALOG.map(r => ({ ...r, positions: positionsOf(r), doc: docFor(r),
                                          synonyms: synonymsFor(r), tier: tierFor(r) })),
            groups:    GROUPS,
            positions: POSITIONS,
          })

        // The visibility table and the rules, over the schema as it stands. The
        // interview needs the table with no edit in hand, and the rules are
        // worth reading without proposing one.
        if (path === '/api/advise') {
          const { VISIBILITY, PER_CALLER, checkRules, RULES } = await import('../core/advise.js')
          // Two questions about one schema and they are not the same one: a
          // rule is legal-and-wrong, an opportunity is legal-and-missing. One
          // endpoint because a panel asks both at once; two lists because a
          // defect and a suggestion cannot share a severity word.
          const { OPPORTUNITIES, checkOpportunities } = await import('../core/opportunities.js')
          const parsed = currentSchemaParse().schema
          return json({
            visibility:    VISIBILITY,
            perCaller:     PER_CALLER,
            rules:         RULES.map(({ id, severity, title }) => ({ id, severity, title })),
            findings:      checkRules(parsed),
            opportunities: OPPORTUNITIES.map(({ id, confidence, word, title }) => ({ id, confidence, word, title })),
            missing:       checkOpportunities(parsed),
          })
        }

        // What a proposed edit DOES, before it is written. The seed fans out
        // into DDL, an access surface, a JSON Schema and a deploy verdict, and
        // no panel here could see the fan-out — the four are computed in four
        // places and read in four others.
        //
        // Everything is derived from the SUBMITTED text, never from the file, so
        // the answer is about the change rather than about what is on disk. The
        // UI realm is deliberately absent: which control a form renders is
        // sierra's `field-rules.js`, and litestone cannot import sierra without
        // inverting the dependency. A second table here would be the drift the
        // one-owner rule exists to stop.
        if (path === '/api/preview') {
          const { source, model: modelName } = body
          if (typeof source !== 'string') return json({ error: 'preview needs a source' }, 400)

          const { deriveAccess }                        = await import('../access.js')
          const { deriveReleaseSurface, classifyPivot,
                  classifyAccess }                      = await import('../release.js')
          const { generateJsonSchema }                  = await import('../jsonschema.js')
          const { generateModelDDL }                    = await import('../core/ddl.js')
          const { checkRules }                          = await import('../core/advise.js')
          const { checkOpportunities }                  = await import('../core/opportunities.js')

          // Imports are inlined from the file's own directory so a fragment the
          // app imports is in the parse, exactly as it is when Studio boots.
          //
          // The options were an empty object, so `resolveChild` and `read` were
          // undefined and this threw on the FIRST import line — every preview
          // of a schema that imports anything came back
          // `opts.resolveChild is not a function` dressed as a parse error. A
          // schema with no imports never reaches the callback, which is why it
          // read as working (`FJS-829`).
          const previewMissing = []
          const previewShipped = new Map()
          let after
          try {
            after = parse(inlineImports(source, resolve(cfg.schema), {
              resolveChild: (parent, spec) => resolveImportSpecifier(spec, parent).path,
              read:         (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
              seen:         new Set([resolve(cfg.schema)]),
              missing:      previewMissing,
              shipped:      previewShipped,
            }))
            // The pane before is a parseFile, which knows a package's models;
            // the draft is a splice, which is told (opportunities.js `authored`).
            markShipped(after.schema, previewShipped)
          }
          catch (e) { return json({ valid: false, errors: [e.message] }) }
          // A fragment that cannot be read describes a SMALLER schema than the
          // one being previewed, and every verdict below would be about that
          // smaller one. Said rather than absorbed.
          if (previewMissing.length)
            return json({ valid: false, errors: [
              `cannot read ${previewMissing.length === 1 ? 'the import' : 'imports'} ` +
              `${previewMissing.map(m => `"${m}"`).join(', ')} — the preview would describe a smaller schema than the file does`,
            ] })
          if (!after.valid) return json({ valid: false, errors: after.errors })

          const before = currentSchemaParse()

          // Each pane is asked separately, because parse() is more permissive
          // than the layers above it: a gate string parses and then throws the
          // moment deriveAccess reads it. A preview whose whole job is to say
          // what a word does must answer with the message, not a 500 that says
          // nothing about the other three realms.
          const rejected = []
          const pane = (label, fn) => {
            try { return fn() }
            catch (e) { rejected.push({ pane: label, message: e.message }); return null }
          }

          const forModel = (parsed, side) => {
            const m = parsed.schema.models.find(x => x.name === modelName)
            if (!m) return { ddl: null, access: null, json: null }
            return {
              ddl:    pane(`ddl (${side})`,    () => generateModelDDL(m, parsed.schema)),
              access: pane(`access (${side})`, () => deriveAccess(parsed.schema).models.find(x => x.name === modelName) ?? null),
              json:   pane(`schema (${side})`, () => generateJsonSchema(parsed.schema).$defs?.[modelName] ?? null),
            }
          }

          const a = modelName ? forModel(before, 'before') : {}
          const b = modelName ? forModel(after,  'after')  : {}

          const surfaceBefore = pane('release (before)', () => deriveReleaseSurface(before.schema))
          const surfaceAfter  = pane('release (after)',  () => deriveReleaseSurface(after.schema))
          const both = surfaceBefore && surfaceAfter

          return json({
            valid:   true,
            model:   modelName ?? null,
            ddl:     { before: a.ddl    ?? null, after: b.ddl    ?? null },
            access:  { before: a.access ?? null, after: b.access ?? null },
            json:    { before: a.json   ?? null, after: b.json   ?? null },
            release: both ? pane('release', () => classifyPivot(surfaceBefore, surfaceAfter))  : null,
            reach:   both ? pane('reach',   () => classifyAccess(surfaceBefore, surfaceAfter)) : null,
            rejected,
            // Legal and wrong is a class the parser cannot report, so the
            // findings are about the PROPOSED schema and the ones already true
            // of the file are marked rather than dropped — a warning that was
            // there before this edit is not this edit's fault.
            rules:   diffFindings('rules', checkRules, before, after, pane),
            // Same treatment for the other question: an edit that ADDS a Json
            // column adds a suggestion about it, and one that was already there
            // is not this edit's doing.
            missing: diffFindings('missing', checkOpportunities, before, after, pane),
            warnings: after.warnings ?? [],
          })
        }

        if (path === '/api/stats') return json(getDbStats())

        // POST /api/row/detail — full row + belongsTo parents + hasMany child counts
        if (path === '/api/row/detail') {
          const { table, id, auth: authCtx } = body
          if (!table || id === undefined) return json({ error: 'table, id required' }, 400)
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const idField  = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
          const row = await tableDb[accessor].findUnique({ where: { [idField]: id }, withDeleted: true }).catch(() => null)
            ?? await tableDb[accessor].findFirst({ where: { [idField]: id } }).catch(() => null)
          if (!row) return json({ error: 'Row not found' }, 404)

          // belongsTo parents — relation fields on THIS model carrying an FK
          const parents = []
          for (const f of model.fields) {
            const rel = f.attributes.find(a => a.kind === 'relation')
            if (!rel?.fields?.length) continue
            const fk     = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
            const refCol = (Array.isArray(rel.references) ? rel.references[0] : rel.references) ?? 'id'
            if (row[fk] == null) continue
            const targetAccessor = modelToAccessor(f.type.name)
            try {
              const parent = await tableDb[targetAccessor].findFirst({ where: { [refCol]: row[fk] }, withDeleted: true })
              parents.push({ relation: f.name, table: f.type.name, fk, value: row[fk], row: parent })
            } catch { parents.push({ relation: f.name, table: f.type.name, fk, value: row[fk], row: null }) }
          }

          // hasMany children — other models with a belongsTo FK pointing here
          const children = []
          for (const other of activeDb.$schema.models) {
            if (other.name === model.name) continue
            for (const f of other.fields) {
              const rel = f.attributes.find(a => a.kind === 'relation')
              if (!rel?.fields?.length || f.type.name !== model.name) continue
              const fk = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
              try {
                const count = await tableDb[modelToAccessor(other.name)].count({ where: { [fk]: row[idField] } })
                children.push({ table: other.name, fk, count })
              } catch {}
            }
          }
          return json({ row, idField, parents, children })
        }

        // ── Saved SQL queries (base project) — studio-queries.js
        if (path === '/api/queries' && req.method === 'GET') {
          try { return json({ queries: savedQueries.list() }) }
          catch (e) { return json({ queries: [], error: e.message }) }
        }
        if (path === '/api/queries') {
          if (READONLY) return json({ error: 'Litestone Studio is running in --readonly mode' }, 403)
          const { name, sql } = body
          if (!name?.trim() || !sql?.trim()) return json({ error: 'name and sql required' }, 400)
          savedQueries.save(name.trim().slice(0, 80), sql)
          return json({ ok: true })
        }
        if (path === '/api/queries/delete') {
          if (READONLY) return json({ error: 'Litestone Studio is running in --readonly mode' }, 403)
          savedQueries.remove(body.id)
          return json({ ok: true })
        }

        // POST /api/schema-diff — live "what would this edit change" for the editor.
        // Always diffs against the BASE project databases (schema editing is base-scoped).
        if (path === '/api/schema-diff') {
          const { source } = body
          if (typeof source !== 'string') return json({ error: 'source required' }, 400)
          const parsed = parse(source)
          if (!parsed.valid) return json({ valid: false, errors: parsed.errors, diffs: {} })
          const { buildPristineForDatabase } = await import('../core/migrate.js')
          const diffs = {}
          for (const [dbName, handle] of Object.entries(rawDbs)) {
            if (!handle) continue
            try {
              const pristineDb = openDatabase(':memory:')
              const pristine   = buildPristineForDatabase(pristineDb, parsed, dbName)
              pristineDb.close()
              const live       = introspect(handle)
              const diffResult = diffSchemas(pristine, live, parsed, dbName, { pluralize: cfg.pluralize })
              diffs[dbName] = {
                hasChanges: diffResult.hasChanges,
                summary:    diffResult.hasChanges ? summarizeDiff(diffResult) : null,
                sql:        diffResult.hasChanges ? generateMigrationSQL(diffResult, parsed, { pluralize: cfg.pluralize }) : null,
              }
            } catch (e) { diffs[dbName] = { error: e.message } }
          }
          return json({ valid: true, warnings: parsed.warnings ?? [], diffs })
        }


        // ── Tenant registry ─────────────────────────────────────────────────

        if (path === '/api/tenants') {
          if (!tenantsEnabled) return json({ enabled: false, tenants: [] })
          try {
            const reg = await getRegistry()
            const ids = reg.list()
            const tenants = ids.map(id => {
              const meta = (() => { try { return reg.meta.get(id) } catch { return {} } })()
              let size = 0
              try { const p = join(_tenantDirOpt, `${id}.db`); if (existsSync(p)) size = statSync(p).size } catch {}
              return { id, meta, size, active: id === activeTenant }
            })
            return json({ enabled: true, tenants, openCount: reg.openCount, dir: _tenantDirOpt, activeTenant })
          } catch (e) { return json({ enabled: true, tenants: [], error: e.message }) }
        }

        // POST /api/tenants/open { id } — re-point data endpoints at a tenant.
        // POST /api/tenants/open {} — back to the base project database.
        if (path === '/api/tenants/open') {
          const { id } = body
          if (!id) {
            activeTenant = null; activeDb = db; activeRawDb = rawDb; activeRawDbs = rawDbs
            return json({ ok: true, activeTenant: null })
          }
          try {
            const reg = await getRegistry()
            const tdb = await reg.get(id)
            tapClient(tdb)   // tenant queries appear in the query log too
            activeTenant = id
            activeDb     = tdb
            activeRawDb  = tdb.$db
            activeRawDbs = tdb.$rawDbs
            return json({ ok: true, activeTenant: id })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/tenants/migrate — fleet-wide migration via the registry
        if (path === '/api/tenants/migrate') {
          try {
            const reg = await getRegistry()
            const r = await reg.migrate()
            return json({ ok: !r.failed?.length, ...r })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // ── Maintenance actions ─────────────────────────────────────────────
        // Each iterates the open sqlite connections (skips jsonl/logger).

        if (path === '/api/maint/backup') {
          const { vacuum = false } = body
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const multi = Object.entries(activeRawDbs).filter(([, h]) => h).length > 1
          const dest  = cfg.db
            ? resolve(dirname(resolve(cfg.db)), `backup-${stamp}${multi ? '' : '.db'}`)
            : resolve(process.cwd(), `backup-${stamp}`)
          const result = await activeDb.$backup(dest, { vacuum })
          return json({ ok: true, dest, result })
        }

        if (path === '/api/maint/vacuum') {
          const results = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const pageSize = handle.query('PRAGMA page_size').get().page_size
              const before   = handle.query('PRAGMA page_count').get().page_count
              handle.run('VACUUM')
              const after    = handle.query('PRAGMA page_count').get().page_count
              results[dbName] = { ok: true, freedBytes: Math.max(0, (before - after) * pageSize), pagesBefore: before, pagesAfter: after }
            } catch (e) { results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: true, results })
        }

        if (path === '/api/maint/analyze') {
          const results = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const t0 = performance.now()
              handle.run('PRAGMA analysis_limit=400')
              handle.run('ANALYZE')
              results[dbName] = { ok: true, ms: +(performance.now() - t0).toFixed(0) }
            } catch (e) { results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: true, results })
        }

        if (path === '/api/maint/checkpoint') {
          const results = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const r = handle.query('PRAGMA wal_checkpoint(TRUNCATE)').get()
              results[dbName] = { ok: true, busy: r?.busy ?? null, walPages: r?.log ?? null, checkpointed: r?.checkpointed ?? null }
            } catch (e) { results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: true, results })
        }

        if (path === '/api/maint/integrity') {
          const results = {}
          let allOk = true
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const t0   = performance.now()
              const rows = handle.query('PRAGMA quick_check').all()
              const msgs = rows.map(r => Object.values(r)[0])
              const ok   = msgs.length === 1 && msgs[0] === 'ok'
              if (!ok) allOk = false
              results[dbName] = { ok, messages: msgs.slice(0, 20), ms: +(performance.now() - t0).toFixed(0) }
            } catch (e) { allOk = false; results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: allOk, results })
        }

        if (path === '/api/maint/optimize-fts') {
          const results = {}
          const sys = activeDb.asSystem()
          for (const model of activeDb.$schema.models) {
            if (!model.attributes?.some(a => a.kind === 'fts')) continue
            const accessor = modelToAccessor(model.name)
            try {
              const t0 = performance.now()
              await sys[accessor].optimizeFts()
              results[model.name] = { ok: true, ms: +(performance.now() - t0).toFixed(0) }
            } catch (e) { results[model.name] = { ok: false, error: e.message } }
          }
          if (!Object.keys(results).length) return json({ ok: true, results, message: 'No @@fts models in schema' })
          return json({ ok: true, results })
        }

        if (path === '/api/maint/rotate-key') {
          const { newKey } = body
          if (!/^[0-9a-fA-F]{64}$/.test(newKey ?? ''))
            return json({ error: 'newKey must be 64 hex characters (32 bytes)' }, 400)
          try {
            const t0    = performance.now()
            const stats = await activeDb.$rotateKey(newKey)
            return json({ ok: true, stats, ms: +(performance.now() - t0).toFixed(0),
                          note: 'Client now uses the new key. Update your ENCRYPTION_KEY env before restarting the app.' })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // GET /api/perf/sizes — per-table + per-index disk usage via dbstat
        if (path === '/api/perf/sizes') {
          const perDb = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              // dbstat vtab: one row per page — aggregate bytes per object
              const rows = handle.query(
                `SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC`
              ).all()
              // Map indexes to their tables + pull stat1 (present after ANALYZE)
              const idxInfo = handle.query(
                `SELECT name, tbl_name FROM sqlite_master WHERE type='index'`
              ).all()
              const idxToTable = Object.fromEntries(idxInfo.map(r => [r.name, r.tbl_name]))
              let stat1 = {}
              try {
                stat1 = Object.fromEntries(handle.query(`SELECT idx, stat FROM sqlite_stat1 WHERE idx IS NOT NULL`).all().map(r => [r.idx, r.stat]))
              } catch {}
              const tables = {}
              for (const r of rows) {
                const owner = idxToTable[r.name] ?? r.name
                if (!tables[owner]) tables[owner] = { table: owner, tableBytes: 0, indexBytes: 0, indexes: [] }
                if (idxToTable[r.name]) {
                  tables[owner].indexBytes += r.bytes
                  tables[owner].indexes.push({ name: r.name, bytes: r.bytes, stat: stat1[r.name] ?? null })
                } else {
                  tables[owner].tableBytes += r.bytes
                }
              }
              perDb[dbName] = { ok: true, tables: Object.values(tables).sort((a, b) => (b.tableBytes + b.indexBytes) - (a.tableBytes + a.indexBytes)) }
            } catch {
              // dbstat requires SQLITE_ENABLE_DBSTAT_VTAB (not compiled into
              // Bun's SQLite) — fall back to sampled payload estimation:
              // sum column byte-lengths over up to 1,000 rows, scale by count.
              try {
                const tableNames = handle.query(
                  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`
                ).all().map(r => r.name)
                const idxInfo = handle.query(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`).all()
                let stat1 = {}
                try {
                  stat1 = Object.fromEntries(handle.query(`SELECT idx, stat FROM sqlite_stat1 WHERE idx IS NOT NULL`).all().map(r => [r.idx, r.stat]))
                } catch {}
                const tables = []
                for (const t of tableNames) {
                  try {
                    const n = handle.query(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
                    let bytes = 0
                    if (n > 0) {
                      const cols = handle.query(`PRAGMA table_info("${t}")`).all().map(c => c.name)
                      const expr = cols.map(c => `COALESCE(LENGTH(CAST("${c}" AS BLOB)),0)`).join(' + ')
                      const avg  = handle.query(`SELECT AVG(len) AS a FROM (SELECT (${expr}) AS len FROM "${t}" LIMIT 1000)`).get().a ?? 0
                      bytes = Math.round(avg * n * 1.15)   // ~15% page/btree overhead
                    }
                    tables.push({
                      table: t, tableBytes: bytes, indexBytes: null, estimated: true,
                      indexes: idxInfo.filter(i => i.tbl_name === t).map(i => ({ name: i.name, bytes: null, stat: stat1[i.name] ?? null })),
                    })
                  } catch {}
                }
                tables.sort((a, b) => b.tableBytes - a.tableBytes)
                perDb[dbName] = { ok: true, estimated: true, tables }
              } catch (e2) {
                perDb[dbName] = { ok: false, error: e2.message }
              }
            }
          }
          return json({ perDb })
        }

        // POST /api/migrations/apply — apply pending migration files
        if (path === '/api/migrations/apply') {
          const multi   = parseResult.schema.databases.some(d => !d.driver || d.driver === 'sqlite')
          const results = {}
          let   applied = 0
          let   failed  = false
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            const dir = multi ? join(cfg.migrations, dbName) : cfg.migrations
            try {
              // Pass the live client so JS migrations get full ORM access
              const r = await migApply(handle, dir, db)
              const ok = (r.applied ?? []).filter(a => a.ok)
              applied += ok.length
              if (r.failed) failed = true
              results[dbName] = { applied: ok.map(a => ({ file: a.file, elapsed: a.elapsed })),
                                  failed: r.failed ?? null, error: r.error ?? null, message: r.message ?? null }
            } catch (e) { failed = true; results[dbName] = { error: e.message } }
          }
          return json({ ok: !failed, applied, results })
        }

        // POST /api/migrations/auto — dev autoMigrate (applies diff directly)
        if (path === '/api/migrations/auto') {
          try {
            const results = migAuto(db, parseResult, { pluralize: cfg.pluralize, force: true })
            const summary = {}
            for (const [dbName, r] of Object.entries(results))
              summary[dbName] = { state: r.state, applied: r.applied ?? 0, sql: r.sql ?? null, reason: r.reason ?? null }
            return json({ ok: true, results: summary })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // POST /api/migrations/create — write a migration file from the pending diff
        if (path === '/api/migrations/create') {
          const { label } = body
          const cleanLabel = String(label || 'studio').slice(0, 60)
          const multi   = parseResult.schema.databases.some(d => !d.driver || d.driver === 'sqlite')
          const results = {}
          let   created = 0
          try {
            for (const [dbName, handle] of Object.entries(activeRawDbs)) {
              if (!handle) continue
              const dir = multi ? join(cfg.migrations, dbName) : cfg.migrations
              const r = multi
                ? migCreateForDb(handle, parseResult, dbName, cleanLabel, dir, { pluralize: cfg.pluralize })
                : migCreate(handle, parseResult, cleanLabel, dir, { pluralize: cfg.pluralize })
              if (r.created) created++
              results[dbName] = { created: r.created, file: r.name ?? null, path: r.filePath ?? null, message: r.message ?? null, summary: r.summary ?? null }
            }
            return json({ ok: true, created, results })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // GET /api/schema-source — return raw schema.lite text + path
        if (path === '/api/schema-source' && req.method === 'GET') {
          const absPath = resolve(cfg.schema)
          try {
            const source = readFileSync(absPath, 'utf8')
            return json({ source, path: absPath })
          } catch (e) {
            return json({ error: `Cannot read schema: ${e.message}` }, 500)
          }
        }

        // POST /api/schema-validate — validate schema.lite without saving
        if (path === '/api/schema-validate') {
          const { source } = body
          if (typeof source !== 'string') return json({ error: 'source required' }, 400)
          const result = parse(source)
          return json({ valid: result.valid, errors: result.errors, warnings: result.warnings ?? [] })
        }

        // POST /api/schema-source — validate + save schema.lite
        if (path === '/api/schema-source') {
          const { source } = body
          if (typeof source !== 'string') return json({ error: 'source required' }, 400)
          const result = parse(source)
          if (!result.valid) return json({ valid: false, errors: result.errors, warnings: result.warnings ?? [] })
          // Valid — write to disk
          const absPath = resolve(cfg.schema)
          writeFileSync(absPath, source, 'utf8')
          return json({ valid: true, errors: [], warnings: result.warnings ?? [] })
        }

        // POST /api/perf/advisor/fix — write an advisor's fix into schema.lite
        //
        // The schema is the source, so the fix belongs there rather than in a
        // hand-run CREATE INDEX: an index litestone did not name is one no later
        // migration will ever drop. Writing the attribute does NOT create the
        // index — a migration still has to run, and the response says so rather
        // than letting a green toast imply the table changed.
        if (path === '/api/perf/advisor/fix') {
          const { model: modelName, columns } = body
          if (!modelName || !Array.isArray(columns) || !columns.length)
            return json({ error: 'model and columns[] required' }, 400)
          const absPath = resolve(cfg.schema)
          try {
            const source = readFileSync(absPath, 'utf8')
            const lines  = source.split('\n')

            // Locate the model block by brace depth rather than by regex over
            // the whole file — a doc comment inside a model may contain braces,
            // and `model X {` may sit anywhere in a multi-model file.
            const openIdx = lines.findIndex(l => new RegExp(`^\\s*model\\s+${modelName}\\s*\\{`).test(l))
            if (openIdx < 0) return json({ error: `model ${modelName} not found in ${absPath}` }, 400)
            let depth = 0, closeIdx = -1
            for (let i = openIdx; i < lines.length; i++) {
              const bare = lines[i].replace(/\/\/.*$/, '').replace(/\/\/\/.*$/, '')
              for (const ch of bare) { if (ch === '{') depth++; else if (ch === '}') depth-- }
              if (depth === 0) { closeIdx = i; break }
            }
            if (closeIdx < 0) return json({ error: `model ${modelName} block is not closed` }, 400)

            const attr = `@@index([${columns.join(', ')}])`
            const body_ = lines.slice(openIdx + 1, closeIdx)
            if (body_.some(l => l.replace(/\s/g, '').includes(attr.replace(/\s/g, ''))))
              return json({ error: `${modelName} already declares ${attr}` }, 400)

            // Sit with the other model attributes when there are any, so the
            // block keeps the shape the rest of the file uses.
            const lastAttr = body_.reduce((acc, l, i) => /^\s*@@/.test(l) ? i : acc, -1)
            const at       = lastAttr >= 0 ? openIdx + 1 + lastAttr + 1 : closeIdx
            const indent   = (body_.find(l => l.trim())?.match(/^\s*/)?.[0]) ?? '  '
            const next     = [...lines]
            next.splice(at, 0, `${indent}${attr}`)
            const updated  = next.join('\n')

            const parsed = parse(updated)
            if (!parsed.valid) return json({ error: `Would not parse: ${parsed.errors?.[0]?.message ?? 'unknown'}` }, 400)
            writeFileSync(absPath, updated, 'utf8')
            return json({
              ok: true, added: attr, model: modelName, line: at + 1, path: absPath,
              note: 'Written to the schema. The index does not exist until a migration runs.',
            })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // GET /api/perf/advisor — schema-level index analysis
        if (path === '/api/perf/advisor') {
          const issues = []
          const source = await activeDatabaseSource()
          // Every check below compares the schema to the live DDL, so on a
          // fleet with no tenant open there is nothing here to compare: the
          // base file is a skeleton no tenant uses. Grading it and labeling
          // the label would still put red rows in front of somebody, and a red
          // row is acted on (`FJS-993`).
          if (source.reason === 'no-tenant') return json({ issues, source })
          const models = activeDb.$schema.models
          const { modelToTableName } = await import('../core/ddl.js')
          const pluralize = cfg.pluralize ?? false

          for (const model of models) {
            // `sqlite_master.tbl_name` holds the name as written at CREATE TABLE
            // time, and SQL string equality is case-sensitive even though SQLite
            // resolves identifiers case-insensitively. Querying for the MODEL
            // name ("User") against a table created as "user" matched nothing,
            // so every index looked absent and every FK was reported unindexed.
            const modelName = model.name
            const tableName = modelToTableName(model, pluralize)

            // A model assigned to a jsonl/logger database has no SQLite indexes
            // to be missing, and lives in a different handle if it has any.
            const dbName = model.attributes?.find(a => a.kind === 'db')?.name ?? 'main'
            if ((activeDb.$databases?.[dbName]?.driver ?? 'sqlite') !== 'sqlite') continue
            const handle = activeRawDbs?.[dbName] ?? activeRawDb
            if (!handle) continue

            // PRAGMA rather than parsing sqlite_master.sql, for two reasons:
            // an implicit UNIQUE index has sql = NULL (so a `sql IS NOT NULL`
            // filter hides every @@unique behind a false positive), and the
            // pragma hands back columns already in order instead of a regex
            // over DDL text that also has to survive partial-index predicates.
            let existingIndexes = []
            try {
              existingIndexes = handle.query(`PRAGMA index_list("${tableName}")`).all().map(r => ({
                name:    r.name,
                unique:  Boolean(r.unique),
                columns: handle.query(`PRAGMA index_info("${r.name}")`).all()
                  .sort((a, b) => a.seqno - b.seqno).map(c => c.name).filter(Boolean),
              }))
            } catch { continue }   // table not created yet — migrations pending
            const idxColumnsOf = idx => idx.columns
            // Only the LEADING column of an index makes a lookup on that column
            // fast — SQLite uses a leftmost prefix. Counting every column meant
            // an index on (username, accountId) was read as covering accountId,
            // which is the false negative that hides a real scan.
            const indexedCols = new Set(existingIndexes.map(idx => idxColumnsOf(idx)[0]).filter(Boolean))

            // 1. FK columns without indexes
            const fkFields = model.fields.filter(f =>
              f.attributes.some(a => a.kind === 'relation' && a.fields?.length)
            )
            for (const field of fkFields) {
              const relAttr = field.attributes.find(a => a.kind === 'relation')
              const fkCols  = relAttr?.fields ?? []
              for (const col of fkCols) {
                if (!indexedCols.has(col)) {
                  issues.push({
                    severity:    'red',
                    title:       `Missing FK index on ${modelName}.${col}`,
                    table:       modelName,
                    description: `Foreign key column "${col}" on "${modelName}" has no leading index, so any read that starts from the OTHER side scans this table — the parent's hasMany (include({ ${modelName.toLowerCase()}s: true })), a where on "${col}", and ON DELETE CASCADE. Reading the parent from here (include({ ${field.name}: true })) is not affected: that resolves by primary key.`,
                    impact:      'Measured on 50k rows: 2,000 lookups by this column take 4.0s unindexed vs 56ms indexed (72×), and a cascade delete of 200 parents 656ms vs 8ms (83×). The index costs ~1.7× on insert and ~60% more disk.',
                    fix:         { kind: 'index', model: modelName, columns: [col] },
                    sql:         `CREATE INDEX "idx_${tableName}_${col}" ON "${tableName}" ("${col}");`,
                    notes:       `SQLite does not index foreign key columns for you. Declare it — @@index([${col}]) on ${modelName} — and migrate, so the index carries the name litestone manages; one created by hand survives every later migration.`,
                  })
                }
              }
            }

            // 2. Soft-delete tables: deletedAt should be indexed
            const hasSoftDelete = model.attributes.some(a => a.kind === 'softDelete')
            if (hasSoftDelete && !indexedCols.has('deletedAt')) {
              issues.push({
                severity:    'yellow',
                title:       `No index on ${modelName}.deletedAt`,
                table:       modelName,
                description: `"${modelName}" uses @@softDelete but "deletedAt" is not indexed. Every query filters "WHERE deletedAt IS NULL" — without an index this scans the full table.`,
                impact:      'All findMany/findFirst/count calls filter on deletedAt. This becomes slower as rows accumulate.',
                sql:         `CREATE INDEX "idx_${tableName}_deletedAt" ON "${tableName}" ("deletedAt");`,
                notes:       'A partial index (WHERE deletedAt IS NULL) is even better but requires SQLite 3.8+.',
                fix:         { kind: 'index', model: modelName, columns: ['deletedAt'] },
              })
            }

            // 3. @@index declared in schema but not in live db
            const declaredIndexes = model.attributes.filter(a => a.kind === 'index' || a.kind === 'unique')
            for (const attr of declaredIndexes) {
              const cols     = attr.fields ?? []
              const isUnique = attr.kind === 'unique'
              // Check if any existing index covers exactly these cols
              const covered = existingIndexes.some(idx => {
                const idxCols = idxColumnsOf(idx)
                return cols.length === idxCols.length && cols.every((c, i) => c === idxCols[i])
              })
              if (!covered && cols.length) {
                const idxName = `idx_${tableName}_${cols.join('_')}`
                issues.push({
                  severity:    'red',
                  title:       `Pending ${isUnique ? 'unique ' : ''}index on ${modelName}`,
                  table:       modelName,
                  description: `Schema declares @@${isUnique ? 'unique' : 'index'}([${cols.join(', ')}]) on "${modelName}" but this index doesn't exist in the live database. Run a migration to create it.`,
                  impact:      'Queries filtering or sorting on these columns are doing full table scans.',
                  sql:         `CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX "${idxName}" ON "${tableName}" (${cols.map(c => `"${c}"`).join(', ')});`,
                  notes:       'Run "litestone migrate apply" to apply pending schema changes.',
                })
              }
            }

            // 4. High row-count tables with no indexes at all (except PK)
            try {
              const rowCount = handle.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get().n
              const nonPkIndexes = existingIndexes.filter(idx => !idx.name.startsWith('sqlite_'))
              if (rowCount > 5000 && nonPkIndexes.length === 0) {
                issues.push({
                  severity:    'yellow',
                  title:       `Large table with no indexes: ${modelName}`,
                  table:       modelName,
                  description: `"${modelName}" has ${rowCount.toLocaleString()} rows but only a primary key index. Any WHERE clause on non-PK columns will scan all rows.`,
                  impact:      'Queries filtering by non-PK columns are doing full table scans across all rows.',
                  sql:         null,
                  notes:       'Add @@index([column]) to your schema for columns you filter or sort by frequently.',
                })
              }
            } catch {}
          }

          return json({ issues, source })
        }

        // POST /api/perf/analyze — EXPLAIN QUERY PLAN for a SQL statement
        if (path === '/api/perf/analyze') {
          const { sql } = body
          if (!sql?.trim()) return json({ error: 'sql is required' }, 400)
          try {
            // An EXPLAIN left unfinalized holds the connection's next read
            // snapshot until GC, so Studio would show stale rows (`FJS-1753`).
            const explain  = activeRawDb.prepare(`EXPLAIN QUERY PLAN ${sql.trim()}`)
            const planRows = (() => { try { return explain.all() } finally { explain.finalize() } })()

            // Parse each plan row into a rated node. A temp sort can only be
            // explained against the whole plan and the table's real indexes,
            // so the context travels with every line.
            const ctx = { sql: sql.trim(), planRows, db: activeRawDb }
            const nodes = planRows.map(row => {
              const detail = row.detail ?? ''
              return { detail, ...parsePlanDetail(detail, ctx) }
            })

            // Overall score 0–5
            const hasRed    = nodes.some(n => n.rating === 'red')
            const hasYellow = nodes.some(n => n.rating === 'yellow')
            const score = hasRed ? 1 : hasYellow ? 3 : 5

            const summary = hasRed
              ? 'This query has full table scans. Add indexes on the columns in your WHERE clause.'
              : hasYellow
              ? 'This query could be faster. A temp sort or subquery was detected.'
              : 'This query is using indexes efficiently.'

            return json({ nodes, score, summary })
          } catch(e) {
            return json({ error: e.message }, 400)
          }
        }

        // POST /api/transform/preview — preview row counts without writing
        if (path === '/api/transform/preview') {
          const { srcDb, steps } = body
          if (!srcDb) return json({ error: 'srcDb is required' }, 400)
          const absDb = resolve(srcDb)
          if (!existsSync(absDb)) return json({ error: `DB not found: ${absDb}` }, 404)
          try {
            const { introspectSQL } = await import('../transform/framework.js')
            const tmpDb = openDatabase(absDb, { readonly: true })
            const rawSchema = introspectSQL(tmpDb)
            const source = {}
            for (const [t] of Object.entries(rawSchema)) {
              source[t] = tmpDb.query(`SELECT COUNT(*) as n FROM "${t}"`).get().n
            }
            // Apply simple row-reducing steps for estimate
            const tables = { ...source }
            for (const s of (steps ?? [])) {
              if ((s.type === 'drop-table' || s.type === 'truncate') && tables[s.target] !== undefined) {
                if (s.type === 'truncate') tables[s.target] = 0
                else delete tables[s.target]
              }
              if (s.type === 'limit' || s.type === 'sample') {
                const tgts = s.target === 'all' ? Object.keys(tables) : [s.target]
                for (const t of tgts) {
                  if (tables[t] !== undefined) {
                    const n = parseFloat(s.n)
                    if (!isNaN(n) && n < tables[t]) tables[t] = Math.floor(n)
                  }
                }
              }
            }
            const { statSync } = await import('fs')
            const { size: dbSize } = statSync(absDb)
            const totalRows = Object.values(source).reduce((a, b) => a + b, 0)
            const bpr = totalRows > 0 ? dbSize / totalRows : 0
            const estBytes = Object.values(tables).reduce((a, b) => a + b * bpr, 0)
            tmpDb.close()
            return json({ source, tables, estimatedBytes: Math.round(estBytes) })
          } catch (e) {
            return json({ error: e.message }, 500)
          }
        }

        // POST /api/transform/run — execute a pipeline
        if (path === '/api/transform/run') {
          const { srcDb, outPath, steps, filenameFn } = body
          if (!srcDb) return json({ error: 'srcDb is required' }, 400)
          const absDb = resolve(srcDb)
          if (!existsSync(absDb)) return json({ error: `DB not found: ${absDb}` }, 404)
          if (!steps?.length) return json({ error: 'No steps provided' }, 400)
          try {
            const { $, execute } = await import('../transform/framework.js')
            const { run }        = await import('../transform/runner.js')

            // Build pipeline from serialized steps
            const pipeline = steps.map(s => {
              const t = s.target === 'all' ? $.all : $[s.target]
              switch (s.type) {
                case 'scope':       return t.scope(s.sql)
                case 'filter':      return t.filter(s.sql)
                case 'limit':       return t.limit(s.n)
                case 'sample':      return t.sample(s.n)
                case 'drop-col':    return t.drop(...(s.cols||'').split(',').map(c => c.trim()).filter(Boolean))
                case 'keep':        return t.keep(...(s.cols||'').split(',').map(c => c.trim()).filter(Boolean))
                case 'mask':        return t.mask(s.col, s.strategy)
                case 'rename':      return t.rename(s.from, s.to)
                case 'set':         return t.set(s.col, eval(s.expr)) // eslint-disable-line no-eval
                case 'redact':      return t.redact(s.mode === 'both' ? undefined : s.mode)
                case 'drop-table':  return $[s.target].drop()
                case 'truncate':    return $[s.target].truncate()
                case 'drop-except': return $.any.dropExcept(...(s.keep||'').split(',').map(c => c.trim()).filter(Boolean))
                case 'shard':       return $.shard(s.target)
                default: return null
              }
            }).filter(Boolean)

            const resolvedOut = outPath ? resolve(outPath) : null
            const t0 = performance.now()
            const lines = []
            const origLog = console.log.bind(console)
            console.log = (...a) => { lines.push(a.join(' ')); origLog(...a) }

            const outputs = []
            const result = await execute(
              absDb,
              { verbose: true, outputPath: resolvedOut, schemaPath: cfg.schema },
              run,
              pipeline,
            ).catch(e => { throw e })
            .finally(() => { console.log = origLog })

            const ms = Math.round(performance.now() - t0)
            const outFiles = (Array.isArray(result) ? result : [result]).filter(Boolean)
            const { statSync } = await import('fs')
            for (const f of outFiles) {
              try { outputs.push({ path: f, size: statSync(f).size }) } catch {}
            }
            return json({ ok: true, ms, lines, outputs })
          } catch (e) {
            return json({ error: e.message }, 500)
          }
        }

        // POST /api/repl — evaluate a Litestone client expression
        if (path === '/api/repl') {
          const { code } = body
          if (!code?.trim()) return json({ result: null })
          try {
            // Wrap in AsyncFunction so top-level await and bare expressions both work
            const wrappedCode = code.trim().includes('\n') || !code.trim().startsWith('db.')
              ? `return (async () => { ${code} })()`
              : `return (async () => (${code}))()`

            // Compile outside the timed region — new Function() JIT cost is not DB cost
            // sys = activeDb.asSystem() — bypasses all @@allow/@@deny policies, useful for debugging
            // db = scoped to current auth context (or no-auth if none selected)
            const { auth: replAuth } = body
            const replDb = replAuth ? activeDb.$setAuth(replAuth) : activeDb.asSystem()
            const fn = new Function('db', 'sys', wrappedCode)

            // Capture all ORM queries fired during this execution via $tapQuery
            const sqlLog = []
            const stopTap = activeDb.$tapQuery(e => sqlLog.push(e))

            const t0     = performance.now()
            let result, execError
            try {
              result = await fn(replDb, activeDb.asSystem())
            } catch (e) {
              execError = e
            } finally {
              stopTap()
            }

            const execMs = (performance.now() - t0).toFixed(1)
            if (execError) return json({ error: execError.message, sqlLog })

            // Response.json handles serialization natively in Bun (JSC-optimized)
            return Response.json({ result: result ?? null, execMs, sqlLog })
          } catch (e) {
            return json({ error: e.message })
          }
        }

        // GET /api/auth-users — rows from the @@auth model for the auth picker,
        // and what the picker CANNOT say on its own (`FJS-977`).
        //
        // Acting as somebody here is a real `$setAuth`, so row policies, field
        // policies and gates all apply. What it cannot reproduce is a principal
        // the REQUEST builds: an app resolves claims per request (junction's
        // `createApp({ principal })`) and Studio has no request, so a declared
        // claim that is not a column on this model is absent from every
        // principal built here. Under `strategy row` that is not a smaller
        // answer, it is an empty one — and an empty screen from a missing claim
        // is the same screen as an empty screen from a policy doing its job.
        if (path === '/api/auth-users') {
          const schema    = activeDb.$schema
          const authModel = authModelOf(schema)

          // A claim that is a column on the @@auth model rides along on the row
          // the picker hands to $setAuth. Everything else declared cannot.
          const onRow     = new Set((authModel?.fields ?? []).map(f => f.name))
          const declared  = [...(schema.claims ?? [])]
          if (schema.tenancy?.strategy === 'row' && schema.tenancy.claim) declared.push(schema.tenancy.claim)
          const offRow    = [...new Set(declared)].filter(c => !onRow.has(c))

          const grading = {
            gradedBy:   gateSpec ? 'app' : 'default',
            resolver:   gateSpec || 'gradeStanding',
            offRow,
            tenancyClaim: schema.tenancy?.strategy === 'row' ? (schema.tenancy.claim ?? null) : null,
          }

          if (!authModel) return json({ users: [], modelName: null, ...grading })
          try {
            const rows = await activeDb.asSystem()[modelToAccessor(authModel.name)].findMany({ limit: 50 })
            return json({ users: rows, modelName: authModel.name, ...grading })
          } catch { return json({ users: [], modelName: authModel.name, ...grading }) }
        }

        // POST /api/row/update — update a single row
        if (path === '/api/row/update') {
          const { table, where, data: rowData, auth: authCtx } = body
          if (!table || !where || !rowData) return json({ error: 'table, where, data required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            const result   = await tableDb[accessor].update({ where, data: rowData })
            return json({ ok: true, row: result })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/row/create — insert a new row
        if (path === '/api/row/create') {
          const { table, data: rowData, auth: authCtx } = body
          if (!table || !rowData) return json({ error: 'table, data required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            const result   = await tableDb[accessor].create({ data: rowData })
            return json({ ok: true, row: result })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/factory — create one plausible row from the schema alone
        //
        // The same generator the test realm uses, pointed at the live database.
        // Two properties are the point rather than conveniences:
        //   · withParents() fills every required belongsTo recursively, so the
        //     row satisfies its own FKs — which is why a click can write to
        //     several tables and why the response says which ones.
        //   · it runs as the principal the sidebar selects, so a @@gate refusal
        //     here is the gate working, not the button failing.
        if (path === '/api/factory') {
          const { table, auth: authCtx, asSystem: forceSystem, pins } = body
          if (!table) return json({ error: 'table required' }, 400)
          try {
            const { factoryFrom } = await import('../testing.js')
            const schema = activeDb.$schema
            const model  = schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            // A model names its database with @@db(name); no attribute is main.
            // There is no modelDbMap on $schema — the attribute is the mapping.
            const dbName = model.attributes?.find(a => a.kind === 'db')?.name ?? 'main'
            const driver = activeDb.$databases?.[dbName]?.driver ?? 'sqlite'
            if (driver !== 'sqlite')
              return json({ error: `${model.name} lives in a ${driver} database — append-only, nothing to generate into` }, 400)

            // Asked for explicitly, never a silent fallback: the refusal is the
            // useful answer, and a button that quietly escalates past a gate
            // teaches you the gate is not there.
            const factoryDb = (forceSystem || !authCtx) ? activeDb.asSystem() : activeDb.$setAuth(authCtx)
            // withParents() resolves a parent through the registry, so every
            // model needs an entry and they must share one object — the graph
            // is cyclic and a factory built per lookup would recurse forever.
            const registry = {}
            for (const m of schema.models) registry[modelToAccessor(m.name)] = factoryFrom(schema, m.name, factoryDb, registry)

            // Unseeded output is deliberately plain and deterministic; a seed is
            // what makes fake.js hand back real words for known field names.
            // Counter rather than a constant, so two clicks differ.
            // A pin is sent as an id and re-read HERE, through the same client
            // the factory will write with — otherwise pinning would be a side
            // channel that hands a principal a row its own policy hides.
            const pinRows = {}
            for (const [pinModel, pinId] of Object.entries(pins ?? {})) {
              const pm = schema.models.find(m => m.name === pinModel)
              if (!pm) continue                       // stale pin for a model that went away
              const idField = pm.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
              const seen = await factoryDb[modelToAccessor(pm.name)].findFirst({ where: { [idField]: pinId } })
              if (!seen) return json({
                error: `Pinned ${pinModel} is not visible to this principal — unpin it, or switch who you are acting as`,
              }, 400)
              pinRows[pinModel] = seen
            }

            const created = []
            const stopTap = activeDb.$tapQuery(e => { if (e.operation === 'create') created.push(e.model) })
            let row
            try {
              row = await registry[modelToAccessor(model.name)]
                .seed(++factorySeq)
                .withParents({ pins: pinRows })
                .createOne()
            } finally { stopTap() }

            const tally = []
            for (const t of created) {
              const hit = tally.find(x => x.table === t)
              if (hit) hit.count++
              else tally.push({ table: t, count: 1 })
            }
            return json({ ok: true, row, created: tally, asSystem: Boolean(forceSystem || !authCtx) })
          } catch (e) {
            // A gate refusal is a different kind of answer from a bad row, and
            // only it has a sensible retry. Discriminate on the error, never on
            // the wording of its message.
            const denied = e.name === 'AccessDeniedError' || e.code === 'ACCESS_DENIED'
            return json({ error: e.message, retryAsSystem: denied && !forceSystem && Boolean(authCtx) }, 400)
          }
        }

        // POST /api/row/delete — delete a single row
        if (path === '/api/row/delete') {
          const { table, where, soft, auth: authCtx } = body
          if (!table || !where) return json({ error: 'table, where required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            if (soft) await tableDb[accessor].remove({ where })
            else      await tableDb[accessor].delete({ where })
            return json({ ok: true })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        return json({ error: 'Not found' }, 404)
      } catch (e) {
        return json({ error: e.message }, 500)
      }
    },
  })

  const displayHost = (hostname === '127.0.0.1' || hostname === '0.0.0.0') ? 'localhost' : hostname
  // server.port, never the requested one: `--port=0` asks the OS for any free
  // port, and printing the request back prints `:0`. That is what makes 0 the
  // right thing for a test to ask for — a fixed number, however unlikely, can
  // be taken by whatever else the run is doing.
  const url = `http://${displayHost}:${server.port}`
  console.log(`  ${green('✓')}  Litestone Studio at ${cyan(url)}${hostname !== '127.0.0.1' ? dim(`  (listening on ${hostname})`) : ''}`)

  // A schema that declares gates and a Studio that grades them with somebody
  // else's resolver is a preview nobody can act on. Said here as well as in the
  // page, because the two are read at different moments (`FJS-977`).
  if (!gateSpec && parseResult.schema.models.some(m => m.attributes?.some(a => a.kind === 'gate')))
    console.log(`     ${dim('levels graded by the default resolver —')} ${cyan('--gate <path>')} ${dim("to use this app's own")}`)
  // Which file is this? Asked of the SCHEMA first, because a declaration wins
  // over `cfg.db` — the same rule `clientDb()` applies when building the client.
  // Testing `cfg.db` instead made this branch unreachable: `cfg.db` defaults to
  // './development.db', so every app that declares its databases was told it was
  // on a file it had never opened, and the branch that names the real ones had
  // never run (`FJS-449`).
  //
  // Printed relative to the CWD, so a path that is not below it leads with `..`
  // — which is the signal that this command was typed somewhere unexpected.
  const _declared = parseResult.schema?.databases?.filter(d => !d.driver || d.driver === 'sqlite') ?? []
  if (_declared.length) {
    for (const d of _declared) {
      const absPath = resolveDbPath(d.path, null, schemaAnchor(cfg.schema))
      if (absPath) console.log(`  ${dim(`db (${d.name}):`)}  ${rel(absPath)}`)
    }
  } else if (cfg.db) console.log(`  ${dim('db:')}     ${rel(resolve(cfg.db))}`)
  console.log(`  ${dim('Press Ctrl+C to stop')}\n`)

  // Open browser. `--no-open` is what a script wants: a studio started by a
  // test or a tutorial spawns a browser window on the machine running it, which
  // on a CI runner is a process nobody closes.
  if (!flag('no-open')) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open'
    try { Bun.spawn([opener, url]) } catch {}
  }
}

/**
 * The findings a proposed edit leaves, with the ones that were already there
 * marked rather than dropped.
 *
 * A warning that predates the edit is not the edit's fault, and hiding it would
 * make a card look clean while the file is not. Both questions want this and
 * both wanted it identically, which is the whole argument for one function:
 * the key is (id, model, field), because that triple is what "the same finding"
 * means for a rule and for an opportunity alike.
 */
function diffFindings(label, check, before, after, pane) {
  const now  = pane(`${label} (after)`,  () => check(after.schema))  ?? []
  const was  = pane(`${label} (before)`, () => check(before.schema)) ?? []
  const key  = f => `${f.id}:${f.model}:${f.field}`
  const seen = new Set(was.map(key))
  return now.map(f => ({ ...f, preexisting: seen.has(key(f)) }))
}

// ─── What this project calls its seed ────────────────────────────────────────
//
// Read off `package.json`, because that is where an app states its commands —
// `db/seed.ts` is a convention somebody may or may not follow and `"db:seed"`
// is a statement they made. The names are tried in order and the FIRST that
// exists wins, so a project with both is not ambiguous.
//
// The root is found by walking up from the schema: `db/schema.lite` sits inside
// the app, and Studio may have been started from anywhere.
const SEED_SCRIPTS = ['db:seed', 'seed', 'seed:dev']

function findSeed(cfg) {
  let dir = dirname(resolve(cfg.schema))
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      let pkg
      try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) }
      catch (e) { return { script: null, why: `package.json at ${rel(pkgPath)} does not parse (${e.message})` } }
      const scripts = pkg.scripts ?? {}
      const script  = SEED_SCRIPTS.find(n => typeof scripts[n] === 'string')
      if (!script) {
        return {
          script: null,
          root:   dir,
          why:    `${rel(pkgPath)} declares no seed script — Litestone Studio looks for ${SEED_SCRIPTS.map(n => `\`${n}\``).join(', ')}`,
        }
      }
      // What the script IS, shown so a person can see what they are about to
      // run, and `bun run <name>` is what actually gets spawned.
      return { script, root: dir, command: `bun run ${script}`, runs: scripts[script] }
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return { script: null, why: 'no package.json above the schema — nothing here says what a seed would be' }
}

// ─── The baselines a comparison may name ─────────────────────────────────────
//
// Studio's diff panel does not take a ref typed by whoever has the page open.
// It takes a NAME this function listed, and hands `loadBaselineSchema` the sha
// it resolved for that name — so the value reaching a git command line was
// produced here and never received. That is Invariant 8's rule (the name is
// looked up, never interpolated) applied one realm over, and it is also the
// reason `fli proves` takes no ref over HTTP at all.
//
// The list is the baselines somebody would actually compare against, cheapest
// first: where you are, where you branched from, the release tags, and the
// commits that touched THIS SCHEMA — the last being the only ones that can
// possibly differ, so a repo with a thousand commits offers the handful whose
// answer is not `unchanged`.
//
// Everything is best-effort: a shallow clone has no merge-base, a fresh repo
// has no tags, and a directory that is not a repository answers an empty list
// rather than an error, because *there is nothing to compare against* is a
// state the panel renders and not a failure.
function gitBaselineRefs(schemaPath, { tags = 6, commits = 12 } = {}) {
  if (!git(['rev-parse', '--git-dir'])) return []

  const out  = []
  const seen = new Set()

  // Keyed on the SHA and not on the name. A monorepo tags every package at one
  // commit, so the first listing here was eight `@frontierjs/*@x.y.z` rows
  // resolving to one sha, crowding out the entries whose answer is not
  // `unchanged` — and HEAD and `main` are usually the same commit too. One row
  // per commit, and the first name to claim it is the one worth reading.
  const push = (name, kind, note) => {
    const sha = git(['rev-parse', '--verify', `${name}^{commit}`])
    if (!sha || seen.has(sha)) return
    seen.add(sha)
    out.push({ name, kind, note, sha, subject: git(['log', '-1', '--format=%s', sha]) ?? '' })
  }

  push('HEAD', 'head', 'the commit you are on')

  // Where this branch left the trunk. The most useful of the lot and the one
  // nobody types: it is what a review compares against, and it answers
  // `unchanged` for every commit the branch did not make.
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  for (const trunk of ['main', 'master']) {
    if (head === trunk) continue
    const base = git(['merge-base', 'HEAD', trunk])
    if (base) { push(base, 'merge-base', `where this branch left ${trunk}`); break }
  }
  for (const trunk of ['main', 'master']) push(trunk, 'branch', 'the trunk as it stands')

  // Commits that touched the SCHEMA — ahead of the tags, because they are the
  // only ones that can possibly differ. `--follow` so a renamed file keeps its
  // history, which is the moment a comparison is most wanted.
  //
  // The pathspec is written `:/path` — root-relative. A plain pathspec is
  // relative to the CWD and Studio runs in the app directory, so the
  // root-relative path this resolves was matching nothing and the list came
  // back tags-only, with no error anywhere. `git show <ref>:<path>` in
  // `loadBaselineSchema` is root-relative by definition, which is why that half
  // was right all along and this one was not.
  const root    = git(['rev-parse', '--show-toplevel'])
  const tracked = root ? relative(root, resolve(schemaPath)).split('\\').join('/') : null
  if (tracked) {
    const log = git(['log', `-${commits}`, '--follow', '--format=%H\u0001%ad\u0001%s', '--date=short', '--', `:/${tracked}`])
    for (const line of (log ?? '').split('\n').filter(Boolean)) {
      const [sha, date, subject] = line.split('\u0001')
      if (!sha || seen.has(sha)) continue
      seen.add(sha)
      out.push({ name: sha, kind: 'schema-commit', note: `${date} — touched the schema`, sha, subject: subject ?? '' })
    }
  }

  for (const t of (git(['tag', '--sort=-creatordate']) ?? '').split('\n').filter(Boolean).slice(0, tags))
    push(t, 'tag', 'a release tag')

  return out
}
