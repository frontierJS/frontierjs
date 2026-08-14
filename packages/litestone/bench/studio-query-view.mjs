// Studio's "{ } Query" button — does /api/table hand back a Litestone query
// that RUNS and returns the rows the grid showed?
//
//   bun bench/studio-query-view.mjs
//
// No setup: it seeds a throwaway database, starts studio, asserts, and kills it.
// Two traps this shape exists to avoid:
//   · a studio started by hand serves the code it started with, so a process
//     left running from an earlier edit tests the previous file
//   · asserting on the emitted STRING proves nothing — the last two cases
//     execute it and compare rows, which is the only claim the button makes
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
// 7502 = test env, tooling category, studio — see packages/cli/core/ports.js
const PORT = 7502, ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const S = process.env.S ?? mkdtempSync(join(tmpdir(), 'studio-query-'))
let fails = 0
const ok = (name, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); if (!cond) fails++ }

// a throwaway db so the drive never touches the example's own file
const { createClient } = await import(ROOT + '/packages/litestone/src/index.js')
const seed = await createClient({ schema: ROOT + '/example/db/schema.lite', db: `${S}/studio-drive.db` })
const sys = seed.asSystem()
for (const n of ['Widget', 'Wodget', 'Gadget']) await sys.product.create({ data: { name: n, sku: n.slice(0,5).toUpperCase(), price: 9 } })
seed.$close()

const proc = spawn('bun', [ROOT + '/packages/litestone/src/tools/cli.js', 'studio', `--port=${PORT}`,
  `--schema=${ROOT}/example/db/schema.lite`, `--db=${S}/studio-drive.db`], { cwd: S, stdio: ['ignore','pipe','pipe'] })
let log = ''
proc.stdout.on('data', d => log += d)
proc.stderr.on('data', d => log += d)

const api = (path, body) => fetch(`http://127.0.0.1:${PORT}/api${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise(r => setTimeout(r, 250))
    up = await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.ok).catch(() => false)
  }
  if (!up) { console.log('studio never came up:\n' + log); process.exit(1) }

  // ── plain view, no search ────────────────────────────────────────────────
  let d = await api('/table', { table: 'product', pageSize: 50 })
  ok('rows came back', (d.items?.length ?? 0) === 3, JSON.stringify(d).slice(0, 200))
  ok('query is present', !!d.query, JSON.stringify(d.query))
  ok('names the accessor', d.query?.accessor === 'product', d.query?.accessor)
  ok('no principal → asSystem()', d.query?.code?.includes('db.asSystem().product.findMany('), d.query?.code)
  ok('repl form states no client', d.query?.replCode?.startsWith('db.product.findMany('), d.query?.replCode)
  ok('no filter → no where key', !d.query?.code?.includes('where'), d.query?.code)
  ok('not paged', d.paged === false)

  // ── search + sort + deleted ──────────────────────────────────────────────
  d = await api('/table', { table: 'product', pageSize: 25, search: 'wid',
                            orderBy: { col: 'name', dir: 'desc' }, withDeleted: true })
  ok('search narrowed the grid', d.items?.length === 1, String(d.items?.length))
  ok('where is the OR fan-out', d.query?.code?.includes('OR:'), d.query?.code)
  ok('sort reached the query', d.query?.code?.includes("name: 'desc'"), d.query?.code)
  ok('tie-break on id kept', d.query?.code?.includes("id: 'asc'"))
  ok('withDeleted carried', d.query?.code?.includes('withDeleted: true'))
  ok('limit is the page size', d.query?.args?.limit === 25, String(d.query?.args?.limit))

  // ── the point of the whole thing: it must RUN ────────────────────────────
  const db = await createClient({ schema: ROOT + '/example/db/schema.lite', db: `${S}/studio-drive.db` })
  const run = new Function('db', `return (async () => (${d.query.code.replace(/^await /, '')}))()`)
  const copied = await run(db)
  ok('copied query runs verbatim', Array.isArray(copied), String(copied))
  ok('copied query returns the grid rows',
     JSON.stringify(copied.map(r => r.name)) === JSON.stringify(d.items.map(r => r.name)),
     JSON.stringify(copied.map(r => r.name)) + ' vs ' + JSON.stringify(d.items.map(r => r.name)))
  db.$close()
} finally {
  proc.kill('SIGKILL')
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
