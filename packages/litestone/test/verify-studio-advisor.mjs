/*
 * verify-studio-advisor.mjs — which database did this answer come from.
 *
 * Every row the Schema Advisor prints is the schema compared to the DDL of ONE
 * live database, and until `FJS-993` nothing said which one. Under
 * `tenancy { strategy database }` that database is the declared `database main`
 * path — a file no tenant runs on, which Studio itself creates and nothing
 * migrates afterwards. So the panel reported 23 critical missing-index rows
 * against a skeleton frozen hours earlier while the shop the app actually
 * serves carried every index the schema declares.
 *
 *   node packages/litestone/test/verify-studio-advisor.mjs
 *
 * Starts and stops THREE servers and a Chrome. Nothing to launch first. Needs
 * Chrome on PATH or $FJS_CHROME.
 *
 * It owns two apps in a temp directory, because both halves need a database
 * this file put into a known state:
 *
 *   7508  a fleet — `strategy database`, one tenant, one unindexed foreign key.
 *         The refusal, and the SAME advisor answering properly once a tenant is
 *         open, which is the control: a panel that graded nothing would satisfy
 *         every assertion about the refusal on its own.
 *   7509  a plain app whose database was built from one schema and is being
 *         graded against a later one — the second way an answer here can
 *         describe a database nobody is on.
 *   7510  the same database graded against the schema that built it. The
 *         control for 7509, or `behind` could be a field that is always set.
 *
 * The trap this harness inherits: never return a bare `null` from a probe. CDP
 * serializes it with no `value` key, so it reads back as `undefined` and the
 * assertion fails for a reason that has nothing to do with the page.
 */

import { spawn, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tempDir } from '../src/tmp-dirs.js'
import { join, resolve as pathResolve } from 'node:path'

const PORT_FLEET = process.env.STUDIO_PORT       ?? '7508'
const PORT_STALE = process.env.STUDIO_PORT_STALE ?? '7509'
const PORT_CTRL  = process.env.STUDIO_PORT_CTRL  ?? '7510'
const FLEET  = `http://localhost:${PORT_FLEET}`
const STALE  = `http://localhost:${PORT_STALE}`
const CTRL   = `http://localhost:${PORT_CTRL}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const CLI    = pathResolve(import.meta.dirname, '../src/tools/cli.js')
const ENV    = { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) }

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

// ─── the two apps this drive owns ─────────────────────────────────────────

// One unindexed foreign key, which is the finding the advisor exists to make.
// `Author` is the parent; nothing here declares @@index([authorId]).
const MODELS = `
model Author {
  id    Int    @id @default(autoincrement())
  name  String
  books Book[]
  @@gate("0")
}

model Book {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   Author @relation(fields: [authorId], references: [id], onDelete: Cascade)
  @@gate("0")
}
`

const APP = tempDir('fjs-studio-advisor-')
mkdirSync(join(APP, 'fleet'), { recursive: true })
mkdirSync(join(APP, 'plain'), { recursive: true })

const FLEET_SCHEMA = join(APP, 'fleet', 'schema.lite')
writeFileSync(FLEET_SCHEMA, `
tenancy {
  strategy database
  dir      "./shops"
  registry "./shops-registry.db"
}

database main { path "./base.db" }
${MODELS}`, 'utf8')

// The database the plain app HAS, and the schema it is being graded against.
// One @@index apart, so the only difference between the two servers below is
// whether the open file is current.
const PLAIN_SCHEMA = join(APP, 'plain', 'schema.lite')
const PLAIN_NEXT   = join(APP, 'plain', 'schema-next.lite')
writeFileSync(PLAIN_SCHEMA, `database main { path "./plain.db" }\n${MODELS}`, 'utf8')
writeFileSync(PLAIN_NEXT,
  `database main { path "./plain.db" }\n${MODELS}`.replace(
    '  author   Author @relation(fields: [authorId], references: [id], onDelete: Cascade)\n',
    '  author   Author @relation(fields: [authorId], references: [id], onDelete: Cascade)\n\n  @@index([authorId])\n'),
  'utf8')

function cli(args, cwd) {
  const r = spawnSync('bun', [CLI, ...args], { cwd, env: ENV, encoding: 'utf8' })
  return (r.stdout ?? '') + (r.stderr ?? '')
}

// The tenant has to exist before Studio starts: the panel's refusal is about
// there being a tenant to open, and a fleet with none is a different empty.
cli(['tenant', 'create', 'shop-one', '--schema', FLEET_SCHEMA], join(APP, 'fleet'))
// Built from PLAIN_SCHEMA, then graded against PLAIN_NEXT on 7509.
cli(['db', 'push', '--schema', PLAIN_SCHEMA], join(APP, 'plain'))

t('fixture.theTenantFileExists', existsSync(join(APP, 'fleet', 'shops', 'shop-one.db')), true)
t('fixture.thePlainDbExists',    existsSync(join(APP, 'plain', 'plain.db')), true)

// ─── servers ──────────────────────────────────────────────────────────────

function startStudio(port, schema, cwd) {
  const p = spawn('bun', [CLI, 'studio', '--schema', schema, '--port', port, '--no-open'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: ENV,
  })
  p.out = ''
  p.stdout.on('data', d => { p.out += d })
  p.stderr.on('data', d => { p.out += d })
  return p
}

const fleet = startStudio(PORT_FLEET, FLEET_SCHEMA, join(APP, 'fleet'))
const stale = startStudio(PORT_STALE, PLAIN_NEXT,   join(APP, 'plain'))
const ctrl  = startStudio(PORT_CTRL,  PLAIN_SCHEMA, join(APP, 'plain'))

let chromeProc = null
let chromeProfile = null
function cleanup() {
  for (const p of [fleet, stale, ctrl]) { try { process.kill(-p.pid) } catch {} }
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
await waitFor(FLEET, fleet)
await waitFor(STALE, stale)
await waitFor(CTRL,  ctrl)

const advisor = async (base) => await (await fetch(`${base}/api/perf/advisor`)).json()
const post = async (base, path, body) => await fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
})

// ─── the fleet: what was graded, and what was not ─────────────────────────

const closed = await advisor(FLEET)

t('fleet.nothingIsGraded',   closed.issues, [])
t('fleet.andItSaysWhyNot',   closed.source?.reason, 'no-tenant')
t('fleet.tenancyIsReported', closed.source?.tenantsEnabled, true)
t('fleet.noTenantIsNamed',   closed.source?.tenant, null)

// The control, and it is the assertion that makes the four above mean anything:
// a fix that returned no issues under every condition passes all of them. The
// unindexed foreign key is really there, and opening the tenant finds it.
await post(FLEET, '/api/tenants/open', { id: 'shop-one' })
const open = await advisor(FLEET)

t('fleet.openingATenantGrades',   open.issues.length > 0, true)
t('fleet.andFindsTheRealFinding', open.issues.some(i => i.title === 'Missing FK index on Book.authorId'), true)
t('fleet.theTenantIsNamed',       open.source?.tenant, 'shop-one')
t('fleet.theRefusalIsGone',       open.source?.reason, null)
t('fleet.aTenantIsNotBehind',     open.source?.behind, null)

// Closing it puts the refusal back. The half nothing would notice: a switch
// that only ever opened would leave the panel grading the base file again with
// the tenant badge still on screen.
await post(FLEET, '/api/tenants/open', {})
t('fleet.closingItRefusesAgain', (await advisor(FLEET)).source?.reason, 'no-tenant')

// ─── the plain app: a database behind the schema grading it ───────────────

const behind  = await advisor(STALE)
const current = await advisor(CTRL)

t('behind.isReported',        typeof behind.source?.behind === 'string', true)
t('behind.namesTheIndex',     (behind.source?.behind ?? '').includes('authorId'), true)
t('behind.stillGrades',       behind.issues.length > 0, true)
// The control. One database, two schemas, and only the later one is behind.
t('current.isNotReported',    current.source?.behind, null)
t('current.namesTheFile',     (current.source?.path ?? '').endsWith('plain.db'), true)

// ─── the panel ────────────────────────────────────────────────────────────

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

await cmd('Page.navigate', { url: FLEET })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (typeof showTool === 'function' && typeof perfInit === 'function') return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

await evaluate(`
  showTool('perf');
  await perfInit();
  return true;
`)

t('panel.saysNothingWasGraded', await evaluate(`
  return document.getElementById('perfIssueDetail').textContent.includes('nothing to grade');
`), true)
t('panel.namesTheStrategy', await evaluate(`
  return document.getElementById('perfIssueDetail').textContent.includes('strategy database');
`), true)
// The way OUT is on the panel that refused. A refusal with no next step is a
// dead end somebody screenshots.
t('panel.offersTheTenant', await evaluate(`
  return !!document.getElementById('perfIssueDetail').querySelector('button');
`), true)
t('panel.countIsNotRed', await evaluate(`
  return document.getElementById('perfIssueCount').className.includes('danger');
`), false)

// Pressing it grades, and the line above the list says what it graded. Every
// assertion above passes against a button that does nothing.
// The button is READ rather than assumed: with the refusal gone this probe used
// to throw, and a drive that throws names none of its rows.
t('panel.pressingItGrades', await evaluate(`
  const b = document.getElementById('perfIssueDetail').querySelector('button');
  if (!b) return 'no button to press';
  b.click();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (document.querySelectorAll('#perfIssueList .advisor-item').length > 0) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`), true)
t('panel.sourceLineNamesTheTenant', await evaluate(`
  const el = document.getElementById('perfSourceLine');
  return !el.hidden && el.textContent.includes('shop-one');
`), true)

await cmd('Page.navigate', { url: STALE })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (typeof showTool === 'function' && typeof perfInit === 'function') return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)
await evaluate(`showTool('perf'); await perfInit(); return true;`)

t('panel.behindIsOnTheLine', await evaluate(`
  const el = document.getElementById('perfSourceLine');
  return !el.hidden && el.textContent.includes('behind');
`), true)
t('panel.andItStillListsIssues', await evaluate(`
  return document.querySelectorAll('#perfIssueList .advisor-item').length > 0;
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
