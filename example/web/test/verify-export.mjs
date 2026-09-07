/*
 * verify-export.mjs — the governed extract, out of a real shop.
 *
 * `FJS-D228` phase 1b under `FJS-D230`: Studio previews, the app issues. The
 * plugin has unit coverage in junction; this is the half those tests cannot
 * reach — a real schema with a real gate ladder, a `view` gated ABOVE the rows
 * it aggregates, `tenancy { strategy database }` so there is no `app.db` at
 * all, and `cartClaim`, a principal resolver that runs per request.
 *
 * The point of running it here is the point `FJS-972` made about `view`: a
 * construct that ships and that no app calls is one nothing has ever run.
 *
 *   bun run verify:export
 *
 * Starts and stops its own API. No browser. Seeds first, because the row counts
 * below are the seed's.
 *
 * Two traps this shape has:
 *   • Every route is under `/api` — the app declares a prefix, so `/exports` is
 *     a 404 and reads exactly like a plugin that did not mount.
 *   • The extract streams, so a refusal AFTER the first row cannot be a status
 *     code. Every refusal asserted here is one that happens before it, which is
 *     what the route's first-row hold exists to guarantee.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const BASE = `${API}/api`

const PASSWORD = 'correct-horse-battery'
// Three standings, not two. `sam` is role 'user' with `isStaff`, which reads
// every order; `alex` is role 'admin', which is the only one that clears the
// view's gate of 5; `robin` is a shopper. The ladder is what makes the
// projection assertions below say anything.
const STAFF = 'sam@shop.test', ADMIN = 'alex@shop.test', SHOPPER = 'robin@buyer.test'

// ─── Server ────────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

{
  let busy = false
  try { await fetch(`${BASE}/products`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port 8110 already answers — the API is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
start('bun', ['run', 'api/index.ts'], 'api')
if (!await waitFor(`${BASE}/products`, 'api')) { stopAll(); process.exit(1) }

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

const login = async (email) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  return (await res.json()).token
}
const as = (token) => (token ? { authorization: `Bearer ${token}` } : {})
const take = (path, token) => fetch(`${BASE}${path}`, { headers: as(token) })
const rows = async (res) => (await res.text()).trim().split('\n').filter(Boolean)

const staffToken   = await login(STAFF)
const adminToken   = await login(ADMIN)
const shopperToken = await login(SHOPPER)

// ─── What this shop says may leave ─────────────────────────────────────────

console.log('\nwhat may leave')
{
  const res  = await take('/exports', staffToken)
  const body = await res.json()
  check('the app lists its declared datasets', res.status, 200)
  // Both KINDS, which is the thing a model-only reading of `@@export` misses.
  check('a model and a view, each with its format',
        body.map(d => [d.dataset, d.kind, d.format]),
        [['Order', 'model', 'ndjson'], ['revenueByStatus', 'view', 'csv']])
  check('and the column a caller resumes on',
        body.find(d => d.dataset === 'Order').resumeOn, 'createdAt')
  check('a stranger is not told what a shop holds', (await take('/exports', null)).status, 401)
}

// ─── The extract is the caller's ───────────────────────────────────────────

console.log('\nthe rows that leave are the rows that account can read')
let staffCount = 0
{
  const staff = await take('/exports/Order', staffToken)
  check('staff take an extract', staff.status, 200)
  staffCount = (await rows(staff)).length
  check('and it is not empty', staffCount, n => n > 1)

  // The pair that carries the whole claim. One number alone proves nothing —
  // it is the DIFFERENCE that says the row policy compiled into this read.
  const shopper = await take('/exports/Order', shopperToken)
  check('a shopper takes one too', shopper.status, 200)
  const shopperCount = (await rows(shopper)).length
  check('and it is strictly smaller, from the same declaration',
        [shopperCount > 0, shopperCount < staffCount], [true, true])

  check('a stranger takes none', (await take('/exports/Order', null)).status, 401)
}

// ─── A view, gated above the rows it aggregates ────────────────────────────

console.log('\na projection is gated above what it sums')
{
  // `revenueByStatus` reads at 5 over `Order`, which reads at 1 — so a shopper
  // who legitimately exported their own orders above may not export the sum of
  // everybody's. This is `FJS-970`'s inversion, asked through a second surface.
  const admin = await take('/exports/revenueByStatus', adminToken)
  check('an admin exports the projection', admin.status, 200)
  check('as CSV, with a header naming its columns',
        (await admin.text()).split('\n')[0], h => h.includes('status') && h.includes(','))

  // TWO refusals, one rung apart, and the second is the one worth having: a
  // caller who reads every ORDER still may not read the SUM of them, because
  // the projection is gated above the rows it aggregates (`FJS-970`).
  check('the shopper who just exported their own orders may not export the sum',
        (await take('/exports/revenueByStatus', shopperToken)).status, 403)

  const staff = await take('/exports/revenueByStatus', staffToken)
  check('nor may staff, who exported EVERY order a moment ago', staff.status, 403)
  // The refusal is decided on the first page read, which is AFTER the CSV
  // column header is written — so a route that answered as soon as it could
  // would have handed this caller a well-formed file with a header and no rows.
  check('and no file comes back, not a header with nothing under it',
        (await staff.text()).includes('status,'), false)
}

// ─── Resuming ──────────────────────────────────────────────────────────────

console.log('\nthe cursor is a column the schema named')
{
  const first = await take('/exports/Order', staffToken)
  check('the response names the resume column', first.headers.get('x-export-resume-on'), 'createdAt')

  const all = (await rows(first)).map(l => JSON.parse(l))
  const cut = all[0].createdAt
  const rest = await rows(await take(`/exports/Order?since=${encodeURIComponent(cut)}`, staffToken))
  check('resuming from the first row returns fewer', rest.length, n => n < all.length)

  check('a dataset with no since: refuses a cursor rather than ignoring it',
        (await take('/exports/revenueByStatus?since=2020-01-01', staffToken)).status, 400)
}

// ─── What an operator may type and a caller may not ────────────────────────

console.log('\nthe two flags that belong to the CLI')
{
  // `--system` and `--include-protected` exist on `runExport` and must not be
  // reachable from a URL. Asserted as a PAIR with the ordinary extract, or a
  // route that had broken entirely would pass both.
  const forged = await take('/exports/Order?system=true&includeProtected=true', shopperToken)
  const forgedRows = (await rows(forged)).length
  const plain = (await rows(await take('/exports/Order', shopperToken))).length
  check('neither flag is a query parameter — the extract is still this caller\'s',
        [forgedRows, forgedRows === plain, forgedRows < staffCount], [plain, true, true])

  check('an undeclared model is a 404 that names what IS exportable',
        await (async () => {
          const res = await take('/exports/Product', staffToken)
          return [res.status, (await res.json()).datasets]
        })(),
        [404, ['Order', 'revenueByStatus']])
}

// ─── Result ────────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass}/${pass + fail} checks passed\n`)
stopAll()
process.exit(fail === 0 ? 0 : 1)
