/*
 * verify-studio-preview.mjs — the table dump and the acting-as disclosure.
 *
 * `FJS-D230` rules that Studio PREVIEWS and the app ISSUES. Three things fall
 * out of that ruling and none of them was covered by anything:
 *
 *   FJS-978  the route was called /api/export, which is the governed extract's
 *            word. It is /api/table-dump now.
 *   FJS-976  its column list knew about relations, @computed and @transient and
 *            nothing about protection, so the DEFAULT branch — asSystem(), what
 *            an operator who has chosen no principal gets — wrote @secret and
 *            @guarded values in plaintext into a downloadable CSV.
 *   FJS-977  every preview was graded by toolbelt's default resolver and
 *            nothing said so, and a principal built here carries no claim the
 *            app resolves per request. Under `strategy row` that is an EMPTY
 *            answer, which is the same screen as a policy doing its job.
 *
 *   node packages/litestone/test/verify-studio-preview.mjs
 *
 * Starts and stops TWO servers, 7506 (default resolver) and 7507 (--gate), and
 * a Chrome. Nothing to launch first. Needs Chrome on PATH or $FJS_CHROME.
 *
 * It owns its schema and its database, in a temp directory, unlike the other
 * four Studio drives which read `example`. Two reasons and the second is the
 * one that decided it: the assertions need a model carrying BOTH a @guarded and
 * a @secret column beside a model carrying neither, which is a shape `example`
 * does not have in one place; and the sharpest assertion here is that a real
 * secret VALUE is absent from the file, which needs a row whose value this file
 * knows and therefore a row this file wrote.
 *
 * The trap this harness inherits: never return a bare `null` from a probe. CDP
 * serializes it with no `value` key, so it reads back as `undefined` and the
 * assertion fails for a reason that has nothing to do with the page.
 */

import { spawn } from 'node:child_process'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tempDir } from '../src/tmp-dirs.js'
import { join, resolve as pathResolve } from 'node:path'

const PORT_DEFAULT = process.env.STUDIO_PORT      ?? '7506'
const PORT_GATED   = process.env.STUDIO_PORT_GATE ?? '7507'
const UI     = `http://localhost:${PORT_DEFAULT}`
const GATED  = `http://localhost:${PORT_GATED}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const CLI    = pathResolve(import.meta.dirname, '../src/tools/cli.js')

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

// ─── the app this drive owns ──────────────────────────────────────────────

const APP = tempDir('fjs-studio-preview-')
mkdirSync(join(APP, 'db'), { recursive: true })
const SCHEMA = join(APP, 'db', 'schema.lite')

// `claim cartToken` is the whole of the FJS-977 half: a claim declared in the
// schema that is not a column on the @@auth model cannot ride on the row the
// picker hands to $setAuth, so no principal built in Studio carries it.
writeFileSync(SCHEMA, `
database main { path "./preview.db" }

claim cartToken

model Account {
  id      String  @id @default(cuid())
  email   String  @unique
  isAdmin Boolean @default(false)
  @@auth
  @@gate("0")
}

/// Both protections at once, beside two ordinary columns. The ordinary ones are
/// the control: a fix that dumped NOTHING would satisfy any test that only
/// asked whether the protected values were absent.
model Basket {
  id         Int    @id @default(autoincrement())
  label      String
  token      String @unique @guarded @default(cuid())
  secretNote String @secret
  @@gate("0")
}

/// No protected column anywhere. The negative control for the withheld header:
/// a header that always named something would pass every assertion below.
model Product {
  id   Int    @id @default(autoincrement())
  name String
  @@gate("0")
}
`, 'utf8')

// --gate wants a module. Four is what the default grader answers for a row with
// no flags on it, so the two resolvers are told apart by the SPEC being echoed
// back rather than by a level, which is the honest thing to assert: this drive
// is about whether Studio SAYS which resolver ran.
const GATEFILE = join(APP, 'gate.mjs')
writeFileSync(GATEFILE, 'export const getLevel = (user) => (user?.isAdmin ? 5 : 4)\n', 'utf8')

const ENV = { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) }

function startStudio(port, extra = []) {
  const p = spawn('bun', [CLI, 'studio', '--schema', SCHEMA, '--port', port, '--no-open', ...extra], {
    cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: ENV,
  })
  p.out = ''
  p.stdout.on('data', d => { p.out += d })
  p.stderr.on('data', d => { p.out += d })
  return p
}

const studio = startStudio(PORT_DEFAULT)
const gated  = startStudio(PORT_GATED, ['--gate', GATEFILE])

let chromeProc = null
let chromeProfile = null
function cleanup() {
  for (const p of [studio, gated]) { try { process.kill(-p.pid) } catch {} }
  if (chromeProc) { try { chromeProc.kill('SIGKILL') } catch {} ; chromeProc = null }
  if (chromeProfile) {
    // Removing the profile straight after the kill SUCCEEDS and Chrome writes
    // the directory back while it shuts down. An exit handler cannot await.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    try { rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch {}
    chromeProfile = null
  }
  try { rmSync(APP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT',  () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
process.on('uncaughtException',  (e) => { cleanup(); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { cleanup(); console.error(e); process.exit(1) })

async function waitFor(base, proc) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/auth-users`)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  console.error(`studio on ${base} never came up:\n` + proc.out)
  process.exit(1)
}
await waitFor(UI, studio)
await waitFor(GATED, gated)

const post = async (base, path, body) => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  return res
}

// ─── rows this drive wrote, so it knows the secret ────────────────────────

const SECRET = 'sk-live-DRIVE-SENTINEL'
await post(UI, '/api/row/create', { table: 'Basket', data: { label: 'one', secretNote: SECRET } })
await post(UI, '/api/row/create', { table: 'Product', data: { name: 'a widget' } })

// The token is @guarded and @default(cuid()), so the database minted it and
// only asSystem() can read it back. /api/table is that read.
// findManyCursor's own shape — `items`, never `rows`.
const basketRows = await (await post(UI, '/api/table', { table: 'Basket' })).json()
const TOKEN = basketRows.items?.[0]?.token ?? ''
t('fixture.tokenWasMinted', typeof TOKEN === 'string' && TOKEN.length > 8, true)

// ─── FJS-978 · one word, one meaning ──────────────────────────────────────

t('rename.oldRouteIsGone',   (await post(UI, '/api/export',     { table: 'Product', format: 'csv' })).status, 404)
t('rename.newRouteAnswers',  (await post(UI, '/api/table-dump', { table: 'Product', format: 'csv' })).status, 200)

// ─── FJS-976 · what leaves, and what does not ─────────────────────────────

const dump   = await post(UI, '/api/table-dump', { table: 'Basket', format: 'csv' })
const csv    = await dump.text()
const header = csv.split('\n')[0].split(',')

// The control. A fix that dumped nothing satisfies every assertion below it.
t('dump.ordinaryColumnsSurvive', ['id', 'label'].every(c => header.includes(c)), true)
t('dump.hasARow',                csv.trim().split('\n').length >= 2, true)

t('dump.guardedColumnWithheld',  header.includes('token'), false)
t('dump.secretColumnWithheld',   header.includes('secretNote'), false)

// The sharpest one: the VALUE, not the column name. A header check passes
// against a file that carries the value under a different heading.
t('dump.secretValueIsAbsent',    csv.includes(SECRET), false)
// Asked as a pair with the fixture row above: an empty TOKEN makes
// `csv.includes(TOKEN)` true of every file, so the guard reports "no sentinel"
// rather than quietly passing on nothing.
t('dump.tokenValueIsAbsent',     TOKEN.length > 8 ? csv.includes(TOKEN) : 'no sentinel', false)

// Withheld columns are NAMED. A file with columns missing and nothing saying so
// is what somebody reconciles against a year later and gets wrong.
const withheld = dump.headers.get('X-Withheld-Columns') ?? ''
t('dump.withheldNamesTheGuarded', withheld.includes('token @guarded'), true)
t('dump.withheldNamesTheSecret',  withheld.includes('secretNote @secret'), true)

// The negative control for the header itself.
const clean = await post(UI, '/api/table-dump', { table: 'Product', format: 'csv' })
await clean.text()
t('dump.nothingWithheldOnACleanModel', clean.headers.get('X-Withheld-Columns') ?? '', '')

// ─── FJS-977 · how was this preview graded ────────────────────────────────

const dflt = await (await fetch(`${UI}/api/auth-users`)).json()
const app  = await (await fetch(`${GATED}/api/auth-users`)).json()

t('grading.defaultIsReported',   dflt.gradedBy, 'default')
t('grading.defaultNamesGrader',  dflt.resolver, 'gradeStanding')
t('grading.appIsReported',       app.gradedBy, 'app')
t('grading.appNamesTheFile',     app.resolver === GATEFILE, true)

// The claim declared in the schema is on no column of the @@auth model, so no
// principal Studio builds can carry it. Paired with the columns that DO ride
// along, or the assertion passes against a server reporting everything missing.
t('grading.offRowNamesTheClaim', dflt.offRow, ['cartToken'])
t('grading.onRowClaimsNotListed', dflt.offRow.some(c => ['email', 'isAdmin', 'id'].includes(c)), false)

// ─── the page ─────────────────────────────────────────────────────────────

const profile = tempDir('fjs-studio-')
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
chromeProc = chrome
chromeProfile = profile
chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

const wsUrl = await new Promise((res, rej) => {
  let buf = ''
  const timer = setTimeout(() => rej(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(timer); res(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej })
    setTimeout(() => pending.has(id) && rej(new Error(`${method} timed out`)), 30000)
  })
}

const consoleErrors = []
browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: rs, reject: rj } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rj(new Error(msg.error.message)) : rs(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown')
    consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type))
    consoleErrors.push('error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const cmd = (m, p) => send(m, p, sessionId)
await cmd('Page.enable')
await cmd('Runtime.enable')

async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

await cmd('Page.navigate', { url: UI })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const n = document.getElementById('authNote');
    if (n && !n.hidden) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

t('note.isVisible',      await evaluate(`return !document.getElementById('authNote').hidden`), true)
t('note.namesTheGrader', await evaluate(`return document.getElementById('authNote').textContent.includes('default')`), true)
t('note.saysHowToFixIt', await evaluate(`return document.getElementById('authNote').textContent.includes('--gate')`), true)
t('note.namesTheClaim',  await evaluate(`return document.getElementById('authNote').textContent.includes('cartToken')`), true)

// The picker must still WORK. A disclosure that broke acting-as would be a
// worse bug than the silence it replaced, and every assertion above passes
// against a picker that does nothing.
t('picker.listsTheAccount', await evaluate(`
  return [...document.getElementById('authSelect').options].some(o => o.textContent.includes('drive@preview.test'));
`), false)

await post(UI, '/api/row/create', { table: 'Account', data: { email: 'drive@preview.test' } })
t('picker.picksUpANewAccount', await evaluate(`
  await loadAuthUsers();
  return [...document.getElementById('authSelect').options].some(o => o.textContent.includes('drive@preview.test'));
`), true)

t('picker.actingAsStillBinds', await evaluate(`
  const sel = document.getElementById('authSelect');
  const opt = [...sel.options].find(o => o.textContent.includes('drive@preview.test'));
  onAuthChange(opt.value);
  return currentAuth !== null && currentAuth.email === 'drive@preview.test';
`), true)

t('consoleErrors', consoleErrors, [])

// ─── report ───────────────────────────────────────────────────────────────

let failed = 0
for (const { name, actual, expected } of results) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`)
}

console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${results.length} assertions passed`)

try { browser.close() } catch {}
cleanup()
process.exit(failed ? 1 : 0)
