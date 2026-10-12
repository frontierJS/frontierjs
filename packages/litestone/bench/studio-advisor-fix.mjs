// The advisor's "Fix in the schema" button.
//
//   bun bench/studio-advisor-fix.mjs
//
// Works on a tmpdir copy of basecamp's schema, so it edits nothing real.
// The last two checks are the claim that matters: after the edit, a migration
// built from that schema creates the index and SQLite stops scanning. Asserting
// the text landed in the file would prove the button typed, not that it helped.
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../mesa/src/drive.js'
const R = join(dirname(fileURLToPath(import.meta.url)), '../../..'), PORT = 7503
let fails = 0
const ok = (n,c,x='') => { console.log((c?'ok   ':'FAIL ')+n+(c?'':'  → '+x)); if(!c) fails++ }
const work = mkdtempSync(join(tmpdir(),'fix-')); cpSync(`${R}/packages/basecamp/db`, work, { recursive: true })
// the schema imports @frontierjs/* packages, which resolve only with a node_modules above the copy
symlinkSync(`${R}/packages/basecamp/node_modules`, join(work, 'node_modules'))
const schemaPath = join(work, 'schema.lite')
// a studio already on the port would answer for the one started below, over a different db
if (await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)) { console.log(`port ${PORT} already answers`); process.exit(1) }
const studio = spawn('bun',[`${R}/packages/litestone/src/tools/cli.js`,'studio',`--port=${PORT}`],{cwd:work,env:{...process.env,ENCRYPTION_KEY:'a'.repeat(64)},stdio:'ignore'})
const api = (p,b) => fetch(`http://127.0.0.1:${PORT}/api${p}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json())
try {
  let up=false
  for(let i=0;i<60&&!up;i++){await new Promise(r=>setTimeout(r,250));up=await fetch(`http://127.0.0.1:${PORT}/`).then(r=>r.ok).catch(()=>false)}
  if(!up){console.log('studio down');process.exit(1)}

  const before = readFileSync(schemaPath,'utf8')
  const { issues } = await fetch(`http://127.0.0.1:${PORT}/api/perf/advisor`).then(r=>r.json())
  // The advisor's first index fix for a model schema.lite declares: one from an
  // imported fragment has no block here for the fix to write into.
  const target = issues.find(i => i.fix?.kind === 'index' && new RegExp(`^model ${i.fix.model} `, 'm').test(before))
  ok('the issue carries a machine-readable fix', !!target, issues.filter(i => i.fix).length + ' issues have .fix')
  const M = target.fix.model, C = target.fix.columns[0], attr = `@@index\\(\\[${C}\\]\\)`
  const [, indexName, tableName] = target.sql.match(/CREATE INDEX "([^"]+)" ON "([^"]+)"/)

  const res = await api('/perf/advisor/fix', { model: M, columns: [C] })
  ok('the fix applied', res.ok === true, res.error)
  ok('it says the index does not exist yet', /migration/i.test(res.note ?? ''), res.note)

  const after = readFileSync(schemaPath,'utf8')
  ok('exactly one line was added', after.split('\n').length === before.split('\n').length + 1,
     `${before.split('\n').length} → ${after.split('\n').length}`)
  const block = after.slice(after.indexOf(`model ${M} `), after.indexOf('\n}', after.indexOf(`model ${M} `)))
  ok('the attribute landed in the right model', new RegExp(attr).test(block), block.slice(-260))
  ok('it sits with the other @@ attributes',
     new RegExp(attr).test(block.split('\n').slice(-6).join('\n')), block.split('\n').slice(-6).join(' | '))
  ok('indentation matches the block', new RegExp(`^  ${attr}$`, 'm').test(after))
  console.log(`     tail of ${M}:\n       ` + block.split('\n').slice(-5).join('\n       '))

  // the file must still parse, and the parser must now see the index
  const val = await api('/schema-validate', { source: after })
  ok('the file still parses', val.valid === true, JSON.stringify(val.errors)?.slice(0,200))

  const again = await api('/perf/advisor/fix', { model: M, columns: [C] })
  ok('a second click is refused, not duplicated', !again.ok && /already declares/.test(again.error ?? ''), again.error)

  const nope = await api('/perf/advisor/fix', { model: 'NoSuchModel', columns: ['x'] })
  ok('an unknown model is refused', !nope.ok && /not found/.test(nope.error ?? ''), nope.error)

  // ── the button itself, in a browser ──────────────────────────────────────
  // The API half already added the index; the button needs it absent again.
  writeFileSync(schemaPath, before)
  const browser = await openChrome({ windowSize: '1500,900' })
  try {
    const w = async (fn,t=80)=>{for(let i=0;i<t;i++){await new Promise(r=>setTimeout(r,250));const v=await fn().catch(()=>null);if(v)return v}return null}
    const send = browser.cmd
    const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value
    await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`})
    await w(async()=>(await ev(`document.querySelectorAll('#tableList .table-item').length`))>0)
    await ev(`showTool('perf')`)
    await w(async()=>(await ev(`perfIssues.length`))>0)
    const idx = await ev(`perfIssues.findIndex(i => i.fix && i.fix.kind === 'index' && i.fix.model === ${JSON.stringify(M)} && i.fix.columns[0] === ${JSON.stringify(C)})`)
    ok('an issue offers a schema fix', idx >= 0, String(idx))
    await ev(`perfSelectIssue(${idx})`)
    const label = await ev(`(() => { const b = [...document.querySelectorAll('#perfIssueDetail button')].find(x => /@@index/.test(x.textContent)); return b ? b.textContent.replace(/\\s+/g,' ').trim() : null })()`)
    ok('the detail shows the button', /Add @@index\(\[/.test(label ?? ''), String(label))
    console.log('     button:', label)
    await ev(`[...document.querySelectorAll('#perfIssueDetail button')].find(x => /@@index/.test(x.textContent)).click()`)
    const t2 = await w(async()=>await ev(`(() => { const t = document.getElementById('toast'); return !t.hidden ? t.textContent : null })()`))
    ok('the toast says a migration is still needed', /migrate to create it/.test(t2 ?? ''), String(t2))
    ok('and offers the migrations panel', /Migrations/.test(t2 ?? ''), String(t2))
    console.log('     toast:', String(t2))
  } finally { await browser.close() }

  // and the whole point: a migration built from the edited schema creates it
  const { createClient } = await import(R + '/packages/litestone/src/index.js')
  const { autoMigrate }  = await import(R + '/packages/litestone/src/core/migrations.js')
  const probe = await createClient({ schema: schemaPath, db: ':memory:', encryptionKey: 'a'.repeat(64) })
  await autoMigrate(probe)
  const idx = probe.$db.query(`PRAGMA index_list("${tableName}")`).all().map(r => r.name)
  ok(`a migration creates ${indexName}`, idx.includes(indexName), idx.join(', '))
  // An @@index on a soft-deleted model is partial, and SQLite uses it only for a
  // query that repeats the predicate, which litestone's own reads do.
  const live = probe.$db.query(`PRAGMA table_info("${tableName}")`).all().some(c => c.name === 'deletedAt') ? ' AND "deletedAt" IS NULL' : ''
  const plan = probe.$db.query(`EXPLAIN QUERY PLAN SELECT * FROM "${tableName}" WHERE "${C}" = ?${live}`).all().map(r=>r.detail).join(' ')
  ok('and SQLite now seeks instead of scanning', new RegExp(`\\(${C}=`).test(plan), plan)
  console.log('     plan:', plan)
  probe.$close()
} finally { studio.kill('SIGKILL') }
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
