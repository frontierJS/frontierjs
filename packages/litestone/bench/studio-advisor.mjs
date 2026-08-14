// Studio's schema advisor — is what it reports TRUE?
//
//   bun bench/studio-advisor.mjs
//
// It claimed a missing index on User.accountId while the schema declared
// @@index([accountId]) and the index existed. It was querying sqlite_master by
// MODEL name against a table created under its snake_case name, so it saw no
// indexes at all and reported all 48 FK columns on basecamp.
//
// The last two checks are the ones that matter: every verdict is graded against
// EXPLAIN QUERY PLAN, in BOTH directions. A checker that only proves its own
// complaints cannot catch what it misses — and the misses are what a
// performance advisor exists for. Two traps the oracle itself fell into:
// litestone always carries "deletedAt IS NULL", so a probe without it cannot
// use a partial index; and "USING INDEX" is not enough, because SQLite will use
// idx_<t>_deletedAt for the predicate while still scanning for the column asked
// about — the plan has to seek on THAT column.
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
const R = '/home/j/code/FRONTIER/frontierjs', PORT = 7503
let fails = 0
const ok = (n,c,x='') => { console.log((c?'ok   ':'FAIL ')+n+(c?'':'  → '+x)); if(!c) fails++ }
const work = mkdtempSync(join(tmpdir(),'adv-')); cpSync(`${R}/packages/basecamp/db`, work, { recursive: true })
const studio = spawn('bun',[`${R}/packages/litestone/src/tools/cli.js`,'studio',`--port=${PORT}`],{cwd:work,env:{...process.env,ENCRYPTION_KEY:'a'.repeat(64)},stdio:'ignore'})
try {
  let up=false
  for(let i=0;i<60&&!up;i++){await new Promise(r=>setTimeout(r,250));up=await fetch(`http://127.0.0.1:${PORT}/`).then(r=>r.ok).catch(()=>false)}
  if(!up){console.log('studio down');process.exit(1)}
  const { issues } = await fetch(`http://127.0.0.1:${PORT}/api/perf/advisor`).then(r=>r.json())
  const fk = issues.filter(i => i.title.startsWith('Missing FK index'))
  const pending = issues.filter(i => i.title.startsWith('Pending'))
  console.log(`     ${issues.length} issues — ${fk.length} "missing FK index", ${pending.length} "pending index"`)

  ok('User.accountId is NOT reported — the schema declares it',
     !fk.some(i => /User\.accountId/.test(i.title)), fk.map(i=>i.title).join(' | ').slice(0,180))
  ok('no declared @@index is called pending', pending.length === 0, pending.map(i=>i.title).join(', ').slice(0,180))
  ok('not every FK is flagged', fk.length < 40, `${fk.length} of 48 FK columns flagged`)
  if (fk.length) console.log('     still flagged:', fk.map(i=>i.title.replace('Missing FK index on ','')).join(', ').slice(0,220))

  // any SQL it suggests must actually be litestone's own index name
  const withSql = issues.filter(i => i.sql)
  ok('suggested SQL uses litestone index naming',
     withSql.every(i => /CREATE (UNIQUE )?INDEX "idx_/.test(i.sql)), withSql.map(i=>i.sql).join(' ').slice(0,160))
  ok('suggested SQL targets a table that exists',
     withSql.every(i => !/ON "[A-Z]/.test(i.sql)), withSql.map(i=>i.sql).join(' ').slice(0,160))
  if (withSql.length) console.log('     sample sql:', withSql[0].sql)

  // ── grade every verdict against SQLite's own planner ─────────────────────
  // EXPLAIN QUERY PLAN is a real oracle: "SCAN" means the scan the advisor
  // claims, "SEARCH ... USING INDEX" means it is wrong. Both directions —
  // a checker that only proves its complaints cannot catch what it misses.
  const { createClient } = await import(R + '/packages/litestone/src/index.js')
  const { autoMigrate }  = await import(R + '/packages/litestone/src/core/migrations.js')
  const { modelToTableName } = await import(R + '/packages/litestone/src/core/ddl.js')
  const probe = await createClient({ schema: work + '/schema.lite', db: ':memory:', encryptionKey: 'a'.repeat(64) })
  await autoMigrate(probe)
  const scans = (table, col, soft) => probe.$db.query(
    `EXPLAIN QUERY PLAN SELECT * FROM "${table}" WHERE "${col}" = ?` + (soft ? ` AND "deletedAt" IS NULL` : ``))
    .all().map(r => r.detail).join(' ')

  const reported = new Set(fk.map(i => i.title.replace('Missing FK index on ', '')))
  let wrongComplaint = [], missed = []
  for (const m of probe.$schema.models) {
    const dbName = m.attributes?.find(a => a.kind === 'db')?.name ?? 'main'
    if ((probe.$databases?.[dbName]?.driver ?? 'sqlite') !== 'sqlite') continue
    const table = modelToTableName(m, false)
    for (const f of m.fields) {
      for (const col of (f.attributes.find(a => a.kind === 'relation')?.fields ?? [])) {
        let plan
        const soft = m.attributes?.some(a => a.kind === 'softDelete')
        try { plan = scans(table, col, soft) } catch { continue }
        // "USING INDEX" is not enough: on a soft-delete model SQLite happily
        // uses idx_<t>_deletedAt for the predicate while still scanning for the
        // column asked about. The question is whether the plan seeks on THIS col.
        const reallyScans = !new RegExp(`\\(${col}=`).test(plan)
        const key = `${m.name}.${col}`
        if (reported.has(key) && !reallyScans)  wrongComplaint.push(`${key}: ${plan}`)
        if (!reported.has(key) && reallyScans)  missed.push(`${key}: ${plan}`)
      }
    }
  }
  probe.$close()
  ok('every reported column really does scan', wrongComplaint.length === 0, wrongComplaint.slice(0,3).join(' | '))
  ok('no real scan goes unreported',          missed.length === 0,        missed.slice(0,3).join(' | '))

  // a logger-database model has no SQLite indexes to miss
  ok('logger-db models are not audited', !issues.some(i => /auditLogs/i.test(i.table ?? '')),
     issues.filter(i=>/auditLogs/i.test(i.table??'')).map(i=>i.title).join(', '))
} finally { studio.kill('SIGKILL') }
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
