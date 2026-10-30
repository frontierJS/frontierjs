#!/usr/bin/env node
// web/test/verify-provision.mjs — Basecamp makes a machine at a cloud.
//
//   bun web/test/verify-provision.mjs
//
// The flow the mockup promised and nothing here ran: choose an account, read
// that account's own regions and sizes, see what it will cost, and press a
// button that spends money. Then the machine boots, enrolls itself, and the
// screen follows along.
//
// Starts and stops EVERYTHING itself — a scratch database in a temp directory,
// the DigitalOcean stand-in, the API, the web server and Chrome — so it touches
// nothing local and never asks anybody to reset a dev fleet.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   A picker is offering the VENDOR's list. Every unit test here hands the
//   connector a canned answer, so *the catalog reached a <select>* is a claim
//   no test on either side can make: the service could answer correctly and the
//   screen could render a hardcoded list, and both halves would be green.
//
//   The spend guard is not in the way of the thing it protects. `sendVia`
//   refuses a POST at a non-loopback address, and a guard that also refused the
//   stand-in would look exactly like a working one to every test that only asks
//   about the refusal. This drive provisions for real, through the guard.
//
//   The machine arrives ON ITS OWN. Every other test moves the droplet by
//   calling `sinkBoot`; here the sink is a separate process with
//   `DO_SINK_BOOT_MS` set, so the row moves `provisioning → installing` because
//   a job polled a vendor and found an address — with nothing in the browser
//   asking, which is the claim the live progress strip makes.
//
//   The enrollment route is reachable. It answers 405 to a path parameter
//   spelled `:id` and every function behind it stays correct, which is how it
//   shipped unreachable; here a real curl-shaped POST goes at it.
//
// ─── Traps this file has already paid for ────────────────────────────────
//
//   Setting `.value` on an input does not notify Mesa — it listens for `input`.
//   `--headless=new` delivers almost no rendering lifecycle after load, so
//   everything is polled rather than slept on.
//   Backgrounding a server from a tool call is unreliable; this spawns, polls
//   until each answers, asserts, and kills.

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'
import { portFor } from '@frontierjs/cli/core/ports.js'

const HERE      = dirname(fileURLToPath(import.meta.url))
const PKG       = join(HERE, '..', '..')
// The dev slot by default; `API_PORT`/`UI_PORT` move the drive (the test slot
// is 7120/7020) so it can run beside a dev server holding 8120/8020.
const API_PORT  = Number(process.env.API_PORT ?? await portFor(import.meta.url, 'be', { env: 'dev' }))
const WEB_PORT  = Number(process.env.UI_PORT ?? await portFor(import.meta.url, 'fe', { env: 'dev' }))
const SINK_PORT = await portFor(import.meta.url, 'be', { service: 2 })   // the DO stand-in
const HZ_PORT   = await portFor(import.meta.url, 'be', { service: 4 })   // …and the Hetzner one
const MACHINE_PORT = await portFor(import.meta.url, 'be', { service: 6 }) // the machine's command port
const BASE      = `http://localhost:${WEB_PORT}`
const API       = `http://localhost:${API_PORT}`
const SINK      = `http://localhost:${SINK_PORT}`
const HZ_SINK   = `http://localhost:${HZ_PORT}`
const EMAIL     = 'dev@knight.works'
const PASSWORD  = 'test1234'
const DO_TOKEN  = 'dop_v1_devtoken'
// 64 characters and no prefix, which is Hetzner's shape and not DigitalOcean's.
const HZ_TOKEN  = 'hz'.padEnd(64, '0')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
let passed = 0, failed = 0
let browser = null

function ok(label)          { passed++; console.log(`  ✓ ${label}`) }
function bad(label, detail) { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail) }

// The GROUP, not the child. `bun run web` spawns vite and `bun api/index.ts`
// spawns the app, so killing the direct child leaves the server holding its
// port — the next run then either refuses to start or, worse, is answered by
// the process that never went away. Every child here is spawned detached for
// exactly this: `-pid` is its group.
async function cleanup() {
  for (const c of children) {
    try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill?.() } catch {} }
  }
  await sleep(500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  await browser?.close()
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }

// ─── A database of its own ───────────────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), 'basecamp-provision-'))
const DB      = join(SCRATCH, 'basecamp.db')
// The operator's ssh config, as the API will find it: HOME is pointed here, so
// the listing reads two aliases this drive wrote and never the machine's own.
// 192.0.2.0/24 is TEST-NET-1 — nothing answers there, so the probe is a refusal.
const SSH_HOME = join(SCRATCH, 'home')
mkdirSync(join(SSH_HOME, '.ssh'), { recursive: true })
writeFileSync(join(SSH_HOME, '.ssh', 'config'),
  'Host desk\n  HostName 192.0.2.7\n  User ops\n  Port 2201\nHost named\n  HostName example.invalid\n')
// …and two checkouts under ~/code for /git-activity/local/: one a FrontierJS app committed with
// a token in its remote and a file left uncommitted, one empty.
const gitIn = (cwd, ...args) => spawnSync('git', args, { cwd, env: { ...process.env, HOME: SSH_HOME,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
for (const name of ['alpha', 'beta']) {
  mkdirSync(join(SSH_HOME, 'code', name), { recursive: true })
  gitIn(join(SSH_HOME, 'code', name), 'init', '-q', '-b', 'main')
}
const ALPHA = join(SSH_HOME, 'code', 'alpha')
writeFileSync(join(ALPHA, 'README'), 'x')
writeFileSync(join(ALPHA, 'frontier.config.js'), 'export default {}')
// …with the two halves a preview needs: a web/ to edit, and the schema that
// makes it an app root (`findProjectRoot`), so its branch claims a port block.
mkdirSync(join(ALPHA, 'web', 'config'), { recursive: true })
writeFileSync(join(ALPHA, 'web', 'index.html'), '<h1>alpha</h1>\n<script type="module" src="./main.js"></script>\n')
// …which Freeze builds with Vite, and whose bundle must carry FRONTIER_PUBLIC_API_URL.
writeFileSync(join(ALPHA, 'web', 'main.js'), 'document.body.dataset.api = import.meta.env.FRONTIER_PUBLIC_API_URL\n')
// …and reads FRONTIER_PORT_FE the way a scaffolded config does: `fli dev` leaves an
// app that ignores it at slot 0 and refuses when 8000 is held, so Start app put
// no port on the card on any machine with a dev server up. envPrefix is sierra's
// own: without it vite leaves FRONTIER_PUBLIC_API_URL out of the bundle.
writeFileSync(join(ALPHA, 'web', 'config', 'vite.config.js'), 'export default { envPrefix: [\'VITE_\', \'FRONTIER_PUBLIC_\'], server: { port: Number(process.env.FRONTIER_PORT_FE ?? 8000) } }\n')
mkdirSync(join(ALPHA, 'db'), { recursive: true })
writeFileSync(join(ALPHA, 'db', 'schema.lite'), 'model Lead { id Int @id }\n')
// A stand-in for the checkout's own `fli done`, which the workbench runs after
// a run ends: one unfinished item and one drive, whatever the tree holds.
mkdirSync(join(ALPHA, 'packages', 'cli', 'core'), { recursive: true })
writeFileSync(join(ALPHA, 'packages', 'cli', 'core', 'done.js'), `export function runDone(root) {
  return { root, changed: 2, unfinished: 1,
    items:  [{ check: 'snapshots', subject: 'a', ok: false, message: 'a.snapshot.md is stale' }],
    drives: [{ changed: 'a screen', tier: 'path', on: [], run: ['cd web && bun run verify'] }] }
}
`)
writeFileSync(join(ALPHA, '.gitignore'), '.env\nnode_modules\n')
// This package's Vite, reached the way a branch's own install would leave it;
// the preview's copy list carries the link into the worktree.
symlinkSync(join(HERE, '..', '..', 'node_modules'), join(ALPHA, 'node_modules'))
gitIn(ALPHA, 'add', '.'); gitIn(ALPHA, 'commit', '-q', '-m', 'first commit')
// Ignored, so only the copy list carries it into a branch.
writeFileSync(join(ALPHA, '.env'), 'SECRET=alpha\n')
gitIn(ALPHA, 'remote', 'add', 'origin', 'https://me:tok_secret@example.test/alpha.git')
writeFileSync(join(ALPHA, 'dirty.txt'), 'y')
// …and the Claude Code the workbench runs, as a stand-in: the real one costs
// money and needs a login. It answers in stream-json, slowly enough that the
// card's WORKING state is on screen for a poll or two, and leaves a file in
// the checkout so the card's dirty count has something to follow.
const WORKBENCH = join(SCRATCH, 'workbench')
// A Build plan prompt names its file; the stand-in writes this there, with
// its argv beside it, since only the real claude can enforce the edit scope.
// A Go prompt names a step, as Next's does under its handoff, and the stand-in
// ticks that box as a session would — except the welcome mail, which it leaves open as a session stopping short.
// On 0.2 it also files a defect and a question where the checkout keeps registers.
const PLAN_FIXTURE = `# Sign-up form

### Phase 0 — Groundwork

Goal: the form exists.
Done when: it posts.

- [x] 0.1 Read the schema
  - It has an email column.
- [ ] 0.2 Write the form
- [~] 0.3 A captcha — dropped: nobody asked
- [ ] 0.4 Send the welcome mail

## Open questions (owner)

- **Q1 — Which mail provider?**
  - **A** — the one configured
  - **B** — a second
  - **Recommend A** — nothing new
`
const FAKE_CLAUDE = join(SCRATCH, 'fake-claude')
writeFileSync(FAKE_CLAUDE, `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
const plan = input.match(/^Write a plan at \`([^\`]+)\`/)
const step = input.match(/^Carry out step (\\S+) of the plan at \`([^\`]+)\`/m)
const out = l => process.stdout.write(JSON.stringify(l) + '\\n')
out({ type: 'system', subtype: 'init', session_id: '5acea7bb-3850-44cf-81dc-97688510acda' })
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }] } })
setTimeout(() => {
  fs.writeFileSync('claude-was-here.txt', input)
  if (plan) { fs.writeFileSync(plan[1], ${JSON.stringify(PLAN_FIXTURE)}); fs.writeFileSync('claude-argv.txt', process.argv.join('\\n')) }
  if (step && !/welcome mail/.test(input)) fs.writeFileSync(step[2], fs.readFileSync(step[2], 'utf8').replace('- [ ] ' + step[1], '- [x] ' + step[1]))
  if (step && step[1] === '0.2' && fs.existsSync('ISSUES.md')) fs.writeFileSync('ISSUES.md', fs.readFileSync('ISSUES.md', 'utf8')
    .replace('| --- | --- | --- | --- |\\n', '| --- | --- | --- | --- |\\n| <a id="dl-d1"></a>DL-D1 | web | **Which captcha?** | asked in 0.2 |\\n')
    .replace('| --- | --- | --- | --- | --- | --- |\\n', '| --- | --- | --- | --- | --- | --- |\\n| <a id="dl-002"></a>DL-002 | web | **The form posts twice** | open | 2026-10-13 | found in 0.2 |\\n'))
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done: ' + input }] } })
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42, num_turns: 3 })
}, /slow/.test(input) ? 20000 : 3000)
`, { mode: 0o755 })

console.log('\nBasecamp — provisioning a machine\n')
console.log(`  seeding ${DB}`)

const seed = spawn('bun', ['db/seed.js'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, DATABASE_URL: DB, AUDIT_PATH: join(SCRATCH, 'audit.db') },
})
let seedErr = ''
seed.stderr.on('data', d => { seedErr += d })
const seedCode = await new Promise(r => seed.on('exit', r))
if (seedCode !== 0) fail(`db/seed.js exited ${seedCode}\n${seedErr}`)

// ─── No cloud account, to start with ─────────────────────────────────────
// `db/seed.js` writes provider keys of its own — a fleet with nothing in it
// teaches you nothing about the UI. They are removed here for two reasons and
// both are assertions below: the EMPTY state is the one a fresh install is in
// and is where this feature was undiscoverable, and with them gone the account
// this drive makes is the only one, so a picker offering it cannot be confused
// with a picker offering somebody else's.
{
  const { Database } = await import('bun:sqlite')
  const db = new Database(DB)
  db.run("DELETE FROM secret WHERE kind = 'provider_key'")
  db.close()
}

// ─── Refuse a port that already answers ──────────────────────────────────
for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT],
                            ['DO sink', SINK_PORT], ['Hetzner sink', HZ_PORT], ['machine', MACHINE_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

// ─── The cloud ───────────────────────────────────────────────────────────
// A separate PROCESS, not an in-process fake. The token is really read off an
// Authorization header conduit really wrote, from a Secret that was really
// decrypted — and the created droplet really comes up a few seconds later
// rather than being moved by a function call.
const sinkProc = spawn('bun', ['api/src/providers/compute/digitalocean-sink.ts'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  env: { ...process.env, DO_SINK_PORT: String(SINK_PORT), DO_SINK_BOOT_MS: '4000' },
})
children.push(sinkProc)
// The stand-in names what it refused. A credential mistake otherwise arrives
// here as the vendor's own opaque 401 and there is nothing to look at.
const sinkRefusals = []
sinkProc.stderr.on('data', d => { const t = String(d); if (/refused/.test(t)) sinkRefusals.push(t.trim()) })

// The SECOND cloud, and a second process for the reason the first one is one:
// two vendors answered by one listener would share a router and an error shape,
// which is exactly what a second connector is here to disprove.
const hzProc = spawn('bun', ['api/src/providers/compute/hetzner-sink.ts'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  env: { ...process.env, HZ_SINK_PORT: String(HZ_PORT), HZ_SINK_BOOT_MS: '4000' },
})
children.push(hzProc)
hzProc.stderr.on('data', d => { const t = String(d); if (/refused/.test(t)) sinkRefusals.push(t.trim()) })

const api = spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: {
    ...process.env,
    DATABASE_URL: DB, FRONTIER_APP_URL: BASE, AUDIT_PATH: join(SCRATCH, 'audit.db'),
    // What points the connector at the stand-in. Loopback, so `sendVia`'s
    // spend guard allows the POST without `ALLOW_CLOUD_SPEND` — which is the
    // guard's own claim and is asserted below rather than assumed.
    DIGITALOCEAN_URL: SINK,
    HETZNER_URL:      HZ_SINK,
    FRONTIER_PORT_BE: String(API_PORT),
    LOCAL_MACHINE:    '1',
    HOME:             SSH_HOME,
    WORKBENCH_DIR:    WORKBENCH,
    CLAUDE_BIN:       FAKE_CLAUDE,
  },
})
children.push(api)
// A credential that resolves to nothing is answered by the vendor as an opaque
// 401. `core/credentials.ts` names which of the four ways it failed; this is
// what puts that sentence in front of whoever is reading this drive's output.
const apiWarnings = []
const apiErrors   = []
// `FJS_DRIVE_LOG=<path>` tees the app's own output somewhere readable. Not on
// by default and not needed for a pass — but when this drive fails, the API's
// own sentence about what it refused is usually the whole answer, and it is
// otherwise thrown away with the process.
api.stdout.on('data', d => {
  if (process.env.FJS_DRIVE_LOG) appendFileSync(process.env.FJS_DRIVE_LOG, String(d))
})
api.stderr.on('data', d => {
  const t = String(d)
  if (process.env.FJS_DRIVE_LOG) appendFileSync(process.env.FJS_DRIVE_LOG, t)
  if (/\[credentials\]/.test(t)) apiWarnings.push(t.trim())
  // Anything the app logged as a failure. A service that refused a call
  // answers the browser, and the browser may or may not render it — this is
  // the side that always has the sentence.
  for (const line of t.split('\n'))
    if (/"level":"(error|warn)"|failed/.test(line)) apiErrors.push(line.slice(0, 400))
})
children.push(spawn('bun', ['run', 'web'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) },
}))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) {
    try { await fetch(url); return } catch {}
    await sleep(500)
  }
  fail(`${label} never answered ${url}`)
}
await waitFor(`${SINK}/v2/account`, 'the DigitalOcean stand-in')
await waitFor(`${API}/health`, 'the API')
await waitFor(BASE, 'the web server')

// ─── Chrome ──────────────────────────────────────────────────────────────
browser = await openChrome().catch(async (e) => {
  console.error(`\n✗ ${e.message}\n`)
  await cleanup()
  process.exit(1)
})
const send = browser.cmd

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const ex = r.exceptionDetails
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex))
  return r.result?.value
}

/** Poll until an expression settles rather than sleeping a guessed amount. */
async function until(expression, predicate, label, ms = 20_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 200)}`)
}

const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }
const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
const body = () => evaluate(`document.body.textContent`)
const click = sel => evaluate(`
  (() => { const el = document.querySelector(${JSON.stringify(sel)})
           if (!el) throw new Error('no ' + ${JSON.stringify(sel)})
           el.click(); return true })()`)
const fill = fields => evaluate(`
  (() => {
    ${Object.entries(fields).map(([id, v]) =>
      `{ const el = document.getElementById(${JSON.stringify(id)})
         if (!el) throw new Error('no field #${id} on ' + location.pathname)
         el.value = ${JSON.stringify(v)}
         el.dispatchEvent(new Event('input', { bubbles: true }))
         el.dispatchEvent(new Event('change', { bubbles: true })) }`).join('\n    ')}
  })()`)

/** The options a <select> is actually offering, by value. */
const options = id => evaluate(
  `[...document.getElementById(${JSON.stringify(id)}).options].map(o => o.value).filter(Boolean)`)

/**
 * Watch what the page SENDS, not what its DOM shows. For a textarea the value
 * property and the child text diverge the moment either is written, so reading
 * a box back says nothing about the record a form will submit — which is the
 * difference between the token being on screen and it being in the payload.
 *
 * The SOCKET is hooked as well as fetch, and that is the half that matters:
 * Junction sends over a WebSocket whenever one is connected and falls back to
 * HTTP, so an instrument watching fetch alone would report that this app sends
 * nothing at all.
 *
 * Re-installed after every full page load, because Page.navigate throws the
 * window away and a hook installed once quietly stops recording.
 */
async function instrument() {
  await evaluate(`
    (() => {
      if (window.__sent) return
      window.__sent = []
      const orig = window.fetch
      window.fetch = async (input, init) => {
        try {
          const url  = typeof input === 'string' ? input : input?.url
          const body = init?.body
          if (typeof body === 'string') window.__sent.push({ via: 'http', url, body })
        } catch {}
        return orig(input, init)
      }
      window.__recv = []
      // A rejected promise nobody awaited. goto is async and callers do not
      // await it, so a navigation that fails is silent in the console AND
      // invisible to a check that only asks where the page ended up.
      window.__unhandled = []
      addEventListener('unhandledrejection', e => {
        try { window.__unhandled.push(String(e.reason?.stack ?? e.reason)) } catch {}
      })
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === 'string') window.__sent.push({ via: 'ws', body: data })
          // The ANSWER, once per socket. A call that was sent and never landed
          // is either still pending or was answered with something the page did
          // not act on, and only the reply tells the two apart.
          if (!this.__watched) {
            this.__watched = true
            window.__sockets = (window.__sockets ?? 0) + 1
            this.addEventListener('message', e => {
              try { if (typeof e.data === 'string') window.__recv.push(e.data) } catch {}
            })
            // A socket that CLOSES mid-call answers nothing and looks exactly
            // like a server that never replied.
            this.addEventListener('close', e => {
              try { window.__recv.push('[close] code=' + e.code + ' reason=' + e.reason) } catch {}
            })
            this.addEventListener('error', () => {
              try { window.__recv.push('[error]') } catch {}
            })
          }
        } catch {}
        return send.call(this, data)
      }
    })()`)
}

/**
 * What the page the redirect was aiming at actually says, loaded directly.
 *
 * The created row's id comes off the socket reply rather than the URL, because
 * the URL is exactly what did not change. A route module that fails to compile
 * renders Sierra's own error overlay here and nothing anywhere else.
 */
async function destinationSays() {
  const id = await evaluate(`(() => {
    const hit = (window.__recv ?? []).find(r => /service_result/.test(r) && /"status"/.test(r))
    if (!hit) return ''
    try { return JSON.parse(hit).result?.id ?? '' } catch { return '' }
  })()`)
  if (!id) return '(no created row on the socket to aim at)'
  await send('Page.navigate', { url: `${BASE}/servers/${id}/` })
  await sleep(2500)
  return String(await body()).replace(/\s+/g, ' ').slice(0, 220)
}

const consoleErrors = []
browser.on('Runtime.consoleAPICalled', (params) => {
  if (['error', 'warning'].includes(params.type)) {
    const t = params.args.map(a => a.value ?? a.description ?? '').join(' ')
    if (/favicon|\[vite\]|Download the .* DevTools/i.test(t)) return
    consoleErrors.push(t)
  }
})

try {
  // ─── Sign in ───────────────────────────────────────────────────────────
  await goto('/login/')
  await until(`!!document.getElementById('email')`, v => v, 'the sign-in form never rendered')
  await fill({ email: EMAIL, password: PASSWORD })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/', 'sign-in never landed on the overview')
  ok('signed in as the seeded owner')

  // ─── Getting there at all ──────────────────────────────────────────────
  // The half that was broken and had nothing to do with the code: a person
  // could not find this feature. One button said "Add server" and whether it
  // provisioned was decided by a dropdown four fields down.
  console.log('\n  /servers/ — two acts, two buttons')
  await goto('/servers/')
  const buttons = await evaluate(
    `[...document.querySelectorAll('.section-header a, .section-header button')].map(e => e.textContent.trim())`)
  check('the list offers provisioning by name', buttons.some(b => /provision a machine/i.test(b)), buttons.join(' | '))
  check('and importing as a separate act', buttons.some(b => /import existing/i.test(b)), buttons.join(' | '))

  // ─── The empty state, which is what a fresh install shows ──────────────
  await goto('/servers/provision/')
  await until(`!!document.getElementById('no-accounts') || !!document.getElementById('account')`, v => v,
    'the provision screen never settled')
  check('with no cloud account it says so, rather than showing a dead picker',
    await evaluate(`!!document.getElementById('no-accounts')`))
  const empty = await text('#no-accounts')
  check('…and points at the Secret that fixes it', /provider key/i.test(empty ?? ''), empty?.replace(/\s+/g, ' ').slice(0, 140))
  check('…and at importing, for somebody who has a machine already',
    await evaluate(`!!document.querySelector('#no-accounts a[href="/servers/import/"]')`))

  // ─── The account ───────────────────────────────────────────────────────
  // An account is a `Secret` of kind `provider_key` that NAMES a cloud. Made
  // through the screen rather than written into the database, because the
  // schema's `@@check` refuses one that names no cloud and the field that
  // satisfies it has to exist on the form — a check with no way to answer it is
  // a kind somebody can choose and never save.
  console.log('\n  /secrets/ — an account at a cloud')
  await goto('/secrets/')
  await click('#new-secret')
  await until(`!!document.getElementById('kind')`, v => v, 'the secret form never opened')

  // What the page SENDS, not what its DOM shows. For a `<textarea>` the value
  // property and the child text diverge the moment either is written, so
  // reading the box back says nothing about the record the form will submit —
  // which is the difference between *the token is on screen* and *the token is
  // in the payload*.
  //
  // The SOCKET is hooked as well as fetch, and that is the half that matters:
  // Junction sends over a WebSocket whenever one is connected and falls back to
  // HTTP, so an instrument that watched `fetch` alone would report that this
  // app sends nothing at all.
  await instrument()


  await fill({ name: 'do-main', kind: 'provider_key' })
  await until(`!!document.getElementById('providerKind')`, v => v,
    'choosing provider_key never revealed the cloud field')
  ok('choosing "provider key" asks which cloud — the column the @@check requires')

  const clouds = await options('providerKind')
  // Read off the schema's own enum, and `custom` is filtered: a provider key at
  // no provider is exactly what the check refuses.
  check('the clouds offered come from the schema, without the one that means none',
    clouds.includes('digitalocean') && !clouds.includes('custom'), clouds.join(', '))

  // The refusal FIRST, and it is a pair with the save below: a form that
  // refused everything would satisfy any assertion about the refusal alone.
  await fill({ data: JSON.stringify({ token: DO_TOKEN }) })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`!!document.getElementById('screen-error')`, v => v,
    'a provider key naming no cloud was accepted')
  const refusal = await text('#screen-error')
  check('a provider key naming no cloud is refused, and the message names the field',
    /providerKind|which cloud/i.test(refusal ?? ''), refusal)

  // A value typed into a write-only field must survive a refusal. It cannot be
  // read back from the API by design, so losing it on a rejected submit means
  // retyping a credential with nothing on screen saying it is gone — and the
  // second attempt then stores an EMPTY token, which fails later at the vendor
  // as an authentication error nobody can trace back to this form.
  const kept = await evaluate(`document.getElementById('data')?.value ?? ''`)
  check('the token typed survives the refusal — it cannot be read back to check',
    kept.includes('dop_v1_'), kept ? `held ${kept.length} chars` : '(empty)')

  await fill({ providerKind: 'digitalocean' })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`document.body.textContent.includes('do-main')`, v => v,
    'the secret never appeared in the list')
  ok('and with the cloud named it is stored')

  // ─── The wizard reads the VENDOR ───────────────────────────────────────
  console.log('\n  /servers/provision/ — the catalog is the account\'s')
  await goto('/servers/provision/')
  await until(`!!document.getElementById('account')`, v => v, 'the create form never rendered')
  await instrument()

  const accounts = await evaluate(
    `[...document.getElementById('account').options].map(o => o.textContent.trim())`)
  check('the account appears, named with its cloud',
    accounts.some(a => a.includes('do-main') && a.includes('digitalocean')), accounts.join(' | '))

  // One account is not a choice, so the screen makes it. Asserted rather than
  // assumed: without it a person adds their only cloud account and lands on a
  // picker asking them to pick it.
  const preselected = await evaluate(`document.getElementById('account').value`)
  check('a workspace with ONE account has it chosen already', !!preselected, `value=${preselected}`)

  // BY NAME, never by position. A seeded workspace can already hold a provider
  // key, and taking the first option would silently drive the whole rest of
  // this file against somebody else's account.
  const accountId = await evaluate(
    `[...document.getElementById('account').options].find(o => o.textContent.includes('do-main'))?.value ?? ''`)
  check('and it is the account this drive made that gets chosen', !!accountId)
  await fill({ account: accountId })

  // The failure here is almost always the CATALOG READ rather than the picker,
  // so the wait reports what the screen said instead of `false`.
  await until(`(() => {
      const err = document.getElementById('catalog-error')
      if (err) return 'catalog-error: ' + err.textContent.trim()
      const r = document.getElementById('region')
      if (!r) return 'no #region'
      return r.options.length > 1 ? true : 'region has ' + r.options.length + ' options'
    })()`, v => v === true,
    'the catalog never reached the region picker'
      + (apiWarnings.length ? ` | ${apiWarnings[0]}` : '')
      + (sinkRefusals.length ? ` | ${sinkRefusals[0]}` : ''), 25_000)
  ok('choosing an account reads that cloud, and the regions arrive')

  const regions = await options('region')
  // The vendor's own list, and the whole claim: a hardcoded picker passes every
  // unit test on either side of this.
  check('the regions offered are the ones the vendor answered',
    regions.includes('nyc3') && regions.includes('fra1'), regions.join(', '))
  // `ams2` is in the stand-in's list and is `available: false`. A picker
  // offering it is a create that fails at the vendor with a message nobody here
  // wrote — this is the pair that separates *rendered the list* from *rendered
  // the right list*.
  check('and a region the vendor marks unavailable is NOT offered',
    !regions.includes('ams2'), regions.join(', '))

  // ─── A size belongs to a region ────────────────────────────────────────
  await fill({ region: 'nyc3' })
  await until(`document.getElementById('size').options.length > 1`, v => v,
    'sizes never arrived for nyc3')
  const nyc = await options('size')
  check('nyc3 offers the CPU-optimized size', nyc.includes('c-4'), nyc.join(', '))

  await fill({ region: 'fra1' })
  await until(`[...document.getElementById('size').options].map(o => o.value).join(',')`,
    v => !v.includes('c-4'), 'fra1 went on offering a size it does not have')
  const fra = await options('size')
  check('fra1 does not — the picker narrows by region, both ways',
    !fra.includes('c-4') && fra.includes('s-2vcpu-4gb'), fra.join(', '))

  // ─── What it costs, before it is spent ─────────────────────────────────
  // One field at a time, waiting for each to take. Choosing a region CLEARS the
  // size and re-renders its options, so setting both in one pass writes a value
  // the select does not yet offer — which a <select> answers by staying empty,
  // silently, and the submit below is then disabled for a reason nothing says.
  await fill({ region: 'nyc3' })
  await until(`[...document.getElementById('size').options].map(o => o.value).includes('s-2vcpu-4gb')`,
    v => v, 'nyc3 never offered the size again')

  // The button is DISABLED until a provision has everything it costs money to
  // get wrong. Asserted here, one field short, because a submit that fell back
  // to `create` on a missing field would record a machine nobody made.
  // The name is filled FIRST so the halfway assertion is about the size and the
  // image. With it blank the button is disabled for a reason this row does not
  // mean, and the check would pass against a screen that never arms at all.
  await fill({ name: 'drive-web-01' })
  const halfway = await evaluate(`document.querySelector('form button[type=submit]').disabled`)
  check('the submit is refused while the machine is only half chosen', halfway === true, `disabled=${halfway}`)

  await fill({ size: 's-2vcpu-4gb' })
  await fill({ image: 'ubuntu-24-04-x64' })
  await until(`!!document.getElementById('provision-cost')`, v => v,
    'the cost line never appeared')
  const cost = await text('#provision-cost')
  // $24.00/month is the stand-in's `price_monthly: 24`, crossed as minor units
  // and formatted by the currency's own divisor. A number typed into this
  // screen would read the same and mean nothing.
  check('the cost line quotes the vendor\'s own price', /24\.00/.test(cost ?? ''), cost?.trim())
  check('and says plainly that this creates a machine and starts billing',
    /creates a machine/i.test(cost ?? '') && /billing/i.test(cost ?? ''))

  const label = await evaluate(`document.querySelector('form button[type=submit]').textContent.trim()`)
  // One act per screen now, so the button states it flatly instead of inferring
  // it from a dropdown four fields up.
  check('the button names the act, and it is the only one this screen does',
    label === 'Provision machine', label)

  // ─── Provision ─────────────────────────────────────────────────────────
  // Through the spend guard, for real. `sendVia` refuses a POST at anything
  // that is not loopback and the stand-in is on localhost, so this is the only
  // assertion that the guard is not also in the way of the thing it protects.
  console.log('\n  provisioning')
  const armed = await evaluate(`!document.querySelector('form button[type=submit]').disabled`)
  check('and offered once every one of them is answered', armed === true)
  await evaluate(`document.querySelector('form button[type=submit]').click()`)

  // A rejected promise nobody holds. Measured against the real fault this file
  // paid for and it does NOT catch that one — sierra absorbs the rejection
  // somewhere between `goto` and here — so it is a general guard and not a
  // tripwire for `FJS-1026`. Kept, and its limit stated, because an assertion
  // believed to cover something it does not is worse than no assertion.
  await sleep(2500)
  const unhandled = await evaluate(`JSON.stringify(window.__unhandled ?? [])`)
  check('nothing rejected with nobody holding it',
    unhandled === '[]', String(unhandled).slice(0, 300))

  // The refusal, if there is one, is on the page — reported instead of a bare
  // the provision path, which says only that nothing happened.
  await until(`(() => {
      const p = location.pathname
      if (/^\\/servers\\/[0-9a-f-]{36}\\/$/.test(p)) return true
      // The form's own id, never the alert-danger class: the shell's
      // fleet-notice bar wears the same classes, and the seed leaves an
      // unreachable machine sitting in it. (No backticks in here -- this is
      // inside a template literal and one would close it.)
      const err = document.querySelector('#form-error .alert-content')
      return err ? 'refused: ' + err.textContent.trim() : p
    })()`, v => v === true,
    'provisioning never landed on the machine'
      + ` | sent: ${String(await evaluate('JSON.stringify((window.__sent ?? []).map(s => s.body).filter(b => /provision/.test(b)))')).slice(0, 400)}`
      + ` | recv=${(await evaluate('(window.__recv ?? []).length')) ?? '?'}`
      + ` | sent ${await evaluate('(window.__sent ?? []).length')}, received ${await evaluate('(window.__recv ?? []).length')}`
      + (consoleErrors.length ? ` | console: ${consoleErrors.slice(-1)[0].slice(0, 200)}` : '')
      + (apiErrors.length ? ` | api: ${apiErrors.slice(-1)[0].slice(0, 200)}` : '')
      // The DESTINATION, loaded directly. `goto` awaits the route module's
      // dynamic import and its callers do not await `goto`, so a route whose
      // module throws reads here as *nothing happened* with no error anywhere.
      // Loading it as a full page is the only thing that says which — and it is
      // what diagnosed `FJS-1025` after an hour of looking at the wrong half.
      + ` | destination: ${await destinationSays()}`, 30_000)
  const serverPath = await evaluate(`location.pathname`)
  const serverId   = serverPath.split('/')[2]
  ok('it lands on the machine it just asked for')

  const status0 = await until(`document.getElementById('server-status')?.textContent?.trim()`,
    v => !!v, 'the status pill never rendered')
  check('which exists at `provisioning` before any cloud has answered',
    status0 === 'provisioning', status0)

  const flight = await text('#server-inflight')
  check('and says what it is waiting for, in words a person would use',
    /asking the provider/i.test(flight ?? ''), flight?.trim()?.slice(0, 120))

  // ─── The machine arrives, and the screen follows ───────────────────────
  // Nothing here refreshes. The row is WATCHED, so this moves because a job in
  // another process polled a vendor, found an address and transitioned the row
  // — which is the whole claim of the progress strip above it.
  const status1 = await until(`document.getElementById('server-status')?.textContent?.trim()`,
    v => v === 'installing', 'the row never reached installing', 60_000)
  check('the row reaches `installing` with nothing in the browser asking', status1 === 'installing')

  const addr = await until(`document.body.textContent`, t => /203\.0\.113\./.test(t),
    'the address the vendor gave never reached the screen', 20_000)
  check('carrying the address the vendor gave it', /203\.0\.113\./.test(addr))

  const trail = await text('#server-events')
  check('and the trail says what was asked for',
    /s-2vcpu-4gb/.test(trail ?? '') && /nyc3/.test(trail ?? ''), trail?.replace(/\s+/g, ' ').slice(0, 160))

  // ─── The machine comes online, and the open page follows ───────────────
  //
  // This drive stands in for the machine. Every step below is one cloud-init
  // takes: read the token the vendor's metadata service handed it, exchange it
  // once with a key pair of its own (FJS-D1604), then sign with THAT.
  //
  // The token is the REAL one — read out of the dispatched job's payload, which
  // is where `servers.provision` put it and the only place it exists outside
  // the machine. Minting a second token here would prove the enrollment route
  // works and say nothing about whether the token cloud-init actually carries
  // does.
  console.log('\n  the machine enrolls and comes online')
  const enrollToken = await (async () => {
    const { Database } = await import('bun:sqlite')
    const jobs = new Database(DB.replace('.db', '-jobs.db'), { readonly: true })
    const row = jobs.query(
      "SELECT data FROM jobs WHERE name = 'server:provision' ORDER BY created_at DESC LIMIT 1").get()
    jobs.close()
    try { return JSON.parse(row?.data ?? '{}').enrollToken ?? '' } catch { return '' }
  })()
  check('the token cloud-init carries is the one the app dispatched',
    /^bcen_[0-9a-f]{64}$/.test(enrollToken), enrollToken ? 'shaped wrong' : '(none found)')

  const machineKeys = await (await import('@frontierjs/toolbelt/signature')).generateSigningKeys()
  const enrolled = await fetch(`${API}/servers/${serverId}/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // The certificate the machine's command port would answer with. Nothing
    // here sends it a command; enrollment refuses a machine that has none.
    body: JSON.stringify({ token: enrollToken, cert: (await import('@frontierjs/outpost/cert'))
      .ensureCert(join(tmpdir(), `basecamp-provision-tls-${process.pid}`)).cert,
      publicKey: machineKeys.publicKey }),
  })
  const credential = machineKeys.privateKey
  const hubKey     = (await enrolled.json()).hubKey
  check('the exchange takes a key of its own and answers the hub\'s', enrolled.status === 200 && !!hubKey)

  /** A heartbeat, signed the way the outpost on that machine signs one. */
  async function heartbeat(key, extra = {}) {
    const { signRequest } = await import('@frontierjs/toolbelt/signature')
    const body = JSON.stringify({ outpost_version: '0.4.1', health: { cpu: 4, memory: 12 }, ...extra })
    const path = `/servers/${serverId}`
    const headers = await signRequest({
      ...key, method: 'POST', path, serviceMethod: 'heartbeat', query: '', body,
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
    return fetch(API + path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-service-method': 'heartbeat' },
      body,
    })
  }

  // The FLEET key first, and it must be refused. That is the property the whole
  // per-machine credential exists for: one string every machine holds must not
  // open this machine's door. Asserted BEFORE the acceptance, so a run that
  // stopped here could not be read as a pass.
  const fleet = await heartbeat({ secret: 'outpost-dev-secret' })
  check('the fleet-wide key is REFUSED for a machine that has its own',
    fleet.status === 401, `${fleet.status}`)

  const own = await heartbeat({ privateKey: credential })
  check('and its own key is accepted', own.status === 200, `${own.status}`)

  // The half only a browser can ask. The page has been open since before the
  // machine existed; nothing here reloads it.
  const online = await until(`document.getElementById('server-status')?.textContent?.trim()`,
    v => v === 'online', 'the open page never saw the machine come online', 20_000)
  check('the page that has been open all along says `online`', online === 'online')
  check('and the progress strip is gone, because nothing is in flight now',
    await evaluate(`!document.getElementById('server-inflight')`))
  // The heartbeat recorded a reading; the card that draws it is the dashboard's,
  // and the push that carried `health` is what fills it on a page already open.
  const health = await until(`document.getElementById('server-health')?.textContent ?? ''`,
    t => /\d+\s*%/.test(t), 'the health card never drew a reading', 15_000).catch(e => e.message)
  check('the health card draws the reading the machine just sent', /\d+\s*%/.test(health), String(health).slice(0, 160))

  // ─── The machine enrolls itself ────────────────────────────────────────
  // Over real HTTP at the real route, with no session, no signature and no
  // principal — which is what cloud-init has. This route answered 405 to
  // everything for its whole life because the path parameter was spelled `:id`,
  // and every function behind it was correct.
  console.log('\n  enrollment')
  const wrong = await fetch(`${API}/servers/${serverId}/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'bcen_not_the_one', cert: (await import('@frontierjs/outpost/cert'))
      .ensureCert(join(tmpdir(), `basecamp-provision-tls-${process.pid}`)).cert, publicKey: machineKeys.publicKey }),
  })
  check('a wrong token is refused by the route — which is REACHED, not 405',
    wrong.status === 401, `${wrong.status}`)

  // ─── Reconcile ─────────────────────────────────────────────────────────
  // The cloud against the list, both ways. First clean — the one machine tagged
  // at the stand-in is the one just provisioned — and then with a droplet
  // created behind the app's back, tagged as a server this list has never
  // held, which is what a row deleted while its machine kept billing looks like.
  console.log('\n  /servers/ — reconcile with the cloud')
  await goto('/servers/')
  await until(`!!document.getElementById('reconcile-open')`, v => v, 'no Find orphans once an account exists')
  await click('#reconcile-open')
  await until(`!!document.getElementById('reconcile-run')`, v => v, 'the reconcile drawer never opened')
  await click('#reconcile-run')
  const clean = await until(`document.getElementById('reconcile-summary')?.textContent
                             ?? document.getElementById('reconcile-error')?.textContent ?? ''`,
    t => t, 'reconciling never answered', 20_000)
  check('a clean account reports the one machine it tagged', /^\s*1 tagged machine/.test(clean), clean.trim())
  check('and no orphans', await evaluate(`!document.getElementById('reconcile-orphans')`))

  const ghost = '00000000-0000-4000-8000-00000000beef'
  const planted = await fetch(`${SINK}/v2/droplets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DO_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'leaked', region: 'nyc3', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64',
                           tags: ['basecamp', `basecamp:server:${ghost}`] }),
  })
  check('a droplet is made at the stand-in behind the app\'s back', planted.status < 300, `${planted.status}`)
  await click('#reconcile-run')
  const orphan = await until(`document.getElementById('reconcile-orphans')?.textContent ?? ''`,
    t => t, 'the planted droplet never showed as an orphan', 20_000)
  check('reconcile finds it, and names the server it claims to be', orphan.includes(ghost), orphan.trim().slice(0, 160))

  // ─── A second cloud, on the same screen ────────────────────────────────
  //
  // Everything above is one vendor, and a wizard driven by one vendor cannot
  // say whether it reads a catalog or knows DigitalOcean. This is the same
  // screen against Hetzner, and nothing in it was changed to make that work.
  //
  // Two things live only here. A price is per LOCATION at Hetzner, so the SAME
  // size in two regions is two figures — which no assertion at DigitalOcean can
  // make, because its price does not move. And it is the first non-dollar
  // currency this app has ever rendered, so the divisor being the currency's
  // stops being a comment and becomes a number on a screen.
  console.log('\n  a second cloud — the same wizard, a different vendor')

  await goto('/secrets/')
  await until(`!!document.getElementById('new-secret')`, v => v, 'the secrets screen never rendered')
  await click('#new-secret')
  await until(`!!document.getElementById('name')`, v => v, 'the secret form never opened')
  await fill({ name: 'hz-main', kind: 'provider_key' })
  await until(`!!document.getElementById('providerKind')`, v => v, 'the cloud field never appeared')

  const clouds2 = await options('providerKind')
  check('the second cloud is offered too, off the schema rather than a list here',
    clouds2.includes('hetzner') && clouds2.includes('digitalocean'), clouds2.join(', '))

  await fill({ providerKind: 'hetzner', data: JSON.stringify({ token: HZ_TOKEN }) })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`document.body.textContent.includes('hz-main')`, v => v,
    'the Hetzner key never appeared in the list')
  ok('a Hetzner key is stored the same way')

  await goto('/servers/provision/')
  await until(`!!document.getElementById('account')`, v => v, 'the provision form never rendered')

  // Two accounts now, so the picker is a real choice and the one chosen decides
  // which vendor is read. Chosen by NAME: taking the first would drive the rest
  // of this section against DigitalOcean and every assertion below would be
  // about the wrong cloud.
  const hzOption = await evaluate(
    `[...document.getElementById('account').options].find(o => o.textContent.includes('hz-main'))?.value ?? ''`)
  check('both accounts are offered, and they name their clouds', !!hzOption, hzOption)
  await fill({ account: hzOption })

  await until(`(() => {
      const r = document.getElementById('region')
      if (!r) return 'no #region'
      return [...r.options].some(o => o.value === 'nbg1') ? true : 'regions: '
        + [...r.options].map(o => o.value).join(',')
    })()`, v => v === true, "the Hetzner catalog never reached the region picker", 20_000)

  const hzRegions = await options('region')
  check('the regions are HETZNER\'s, and DigitalOcean\'s are gone',
    hzRegions.includes('nbg1') && hzRegions.includes('fsn1') && hzRegions.includes('hel1')
      && !hzRegions.includes('nyc3'), hzRegions.join(', '))

  await fill({ region: 'nbg1' })
  const nbg = await until(`[...document.getElementById('size').options].map(o => o.value).filter(Boolean)`,
    v => v.length, 'sizes never arrived for nbg1')
  check('nbg1 offers cpx11 and NOT the Arm size, which is sold in one location',
    nbg.includes('cpx11') && !nbg.includes('cax11'), nbg.join(', '))

  await fill({ region: 'fsn1' })
  const fsn = await until(`[...document.getElementById('size').options].map(o => o.value).filter(Boolean)`,
    v => v.includes('cpx21') ? v : false, 'fsn1 never offered cpx21')
  check('fsn1 sells the Arm size and the picker still leaves it out: the fleet runs x86 only',
    !fsn.includes('cax11'), fsn.join(', '))

  // ── the same size, two regions, two prices ──
  await fill({ region: 'nbg1' })
  await until(`[...document.getElementById('size').options].some(o => o.value === 'cpx11')`, v => v,
    'nbg1 never offered cpx11 again')
  await fill({ size: 'cpx11' })
  await fill({ image: 'ubuntu-24.04' })
  const costNbg = await until(`document.getElementById('provision-cost')?.textContent ?? ''`,
    t => /€/.test(t) ? t : false, 'the Hetzner cost line never appeared')
  check('the cost is in EUR, formatted by the currency and not by a hundred',
    /€5\.18/.test(costNbg), costNbg.replace(/\s+/g, ' ').trim().slice(0, 120))

  await fill({ region: 'hel1' })
  await until(`[...document.getElementById('size').options].some(o => o.value === 'cpx11')`, v => v,
    'hel1 never offered cpx11')
  await fill({ size: 'cpx11' })
  const costHel = await until(`document.getElementById('provision-cost')?.textContent ?? ''`,
    t => /€/.test(t) && !/€5\.18/.test(t) ? t : false,
    'the price never moved with the region', 10_000)
  check('and the SAME size in another region is another price — the map, on a screen',
    /€5\.77/.test(costHel), costHel.replace(/\s+/g, ' ').trim().slice(0, 120))

  // ── and it really provisions, at the other vendor ──
  await fill({ region: 'nbg1' })
  await until(`[...document.getElementById('size').options].some(o => o.value === 'cpx11')`, v => v,
    'nbg1 never offered cpx11 for the provision')
  await fill({ name: 'drive-hz-01', size: 'cpx11', image: 'ubuntu-24.04' })
  await until(`!document.querySelector('form button[type=submit]').disabled`, v => v,
    'the Hetzner provision was never armed')
  await evaluate(`document.querySelector('form button[type=submit]').click()`)

  await until(`(() => {
      const p = location.pathname
      if (/^\\/servers\\/[0-9a-f-]{36}\\/$/.test(p)) return true
      const err = document.querySelector('#form-error .alert-content')
      return err ? 'refused: ' + err.textContent.trim() : p
    })()`, v => v === true,
    'provisioning at the second vendor never landed on the machine', 30_000)
  ok('provisioning at the second cloud lands on the machine, through the same guard')

  const hzTrail = await until(`document.getElementById('server-events')?.textContent ?? ''`,
    t => /cpx11/.test(t) ? t : false, 'the trail never named what was asked for', 20_000)
  check('and the trail names the vendor\'s own words, not DigitalOcean\'s',
    /cpx11/.test(hzTrail) && /nbg1/.test(hzTrail), hzTrail.replace(/\s+/g, ' ').slice(0, 140))

  // ─── Cloud spend ───────────────────────────────────────────────────────
  // The price the vendor quoted, copied onto the row at purchase, summed. Not a
  // bill: the screen says so, and that sentence is asserted because a number
  // presented as a bill is worse than no number.
  console.log('\n  /cloud-spend/ — what was committed')
  await goto('/cloud-spend/')
  await until(`!!document.getElementById('spend-committed')`, v => v,
    'the committed tile never rendered')
  const committed = await text('#spend-committed')
  check('the committed figure is the vendor\'s price, from the row',
    /24\.00/.test(committed ?? ''), committed?.replace(/\s+/g, ' ').trim())
  check('and it says how many machines it covers, since an imported one is in none of it',
    /of \d+ machines/.test(committed ?? ''), committed?.replace(/\s+/g, ' ').trim())
  // The grouping, which had nothing to group until there were two clouds: two
  // currencies cannot be added, so they are listed. A tile that summed them
  // would print one plausible number that is nobody's bill.
  check('and the two currencies are listed rather than added together',
    /24\.00/.test(committed ?? '') && /€/.test(committed ?? ''),
    committed?.replace(/\s+/g, ' ').trim())
  check('the screen still refuses to call it a bill',
    /not what the vendor will bill/i.test(await body()))

  // ─── The operator's own checkouts ──────────────────────────────────────
  // LOCAL_MACHINE=1 again, and two repositories under the scratch HOME. The
  // table is git's answer about each; the remote reaches the screen with its
  // token cut out, since a screen is a thing people share.
  console.log('\n  /git-activity/local/ — the checkouts on this machine')
  await goto('/git-activity/local/')
  await until(`!!document.getElementById('root')`, v => v, 'the folder field never rendered')
  await fill({ root: '~/code' })
  await evaluate(`document.querySelector('#local-repos-form button[type=submit]').click()`)
  await until(`document.getElementById('local-repos-list')?.textContent ?? ''`, t => /alpha/.test(t),
    'the scan never listed a repository', 15_000)
  const listed = await text('#local-repos-list')
  check('both checkouts under ~/code are listed', /alpha/.test(listed) && /beta/.test(listed))
  check('with their branch and whether the tree is clean',
    /main/.test(listed) && /1 changed/.test(listed) && /no commits/.test(listed), listed?.replace(/\s+/g, ' ').slice(0, 300))
  check('and the remote with its token cut out',
    /https:\/\/example\.test\/alpha\.git/.test(listed) && !/tok_secret/.test(await body()))
  check('the totals say how many have uncommitted work',
    /1 with uncommitted work/.test(await text('#local-repos-totals')))
  check('a frontier.config.js at the root marks a FrontierJS app',
    /1 FrontierJS/.test(await text('#local-repos-totals')))
  await evaluate(`document.getElementById('local-repos-frontier-only').click()`)
  await until(`document.getElementById('local-repos-list')?.textContent ?? ''`, t => !/beta/.test(t),
    'the FrontierJS-only filter left beta in the list')
  check('the FrontierJS-only filter keeps alpha and drops beta', /alpha/.test(await text('#local-repos-list')))
  await evaluate(`document.getElementById('local-repos-frontier-only').click()`)
  // alpha has a commit and beta none, so newest-first puts alpha on top and
  // the header's first click — ascending — puts the repository with no commit there.
  const order = () => evaluate(`[...document.querySelectorAll('#local-repos-list tbody strong')].map(e => e.textContent).join(',')`)
  await until(`document.querySelectorAll('#local-repos-list tbody strong').length`, n => n === 2, 'the filter never let beta back')
  check('the list opens newest commit first', (await order()) === 'alpha,beta', await order())
  const sortOn = (label) => evaluate(`[...document.querySelectorAll('#local-repos-list th button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  await sortOn('Last commit')
  await until(`[...document.querySelectorAll('#local-repos-list tbody strong')].map(e => e.textContent).join(',')`,
    t => t === 'beta,alpha', 'the Last commit header did not reverse the order')
  check('the Last commit header reverses it', true)
  await sortOn('Working tree')
  await sortOn('Working tree')
  await until(`[...document.querySelectorAll('#local-repos-list tbody strong')].map(e => e.textContent).join(',')`,
    t => t === 'alpha,beta', 'the Working tree header did not put the changed repository first')
  check('the Working tree header sorts by files changed', true)
  await fill({ root: 'code' })
  await evaluate(`document.querySelector('#local-repos-form button[type=submit]').click()`)
  await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => /absolute/.test(t),
    'a relative folder was not refused')
  check('a relative folder is refused by name', true)

  // ─── The workbench ─────────────────────────────────────────────────────
  // A checkout starred on the listing becomes a card with a chat. A message is
  // a run of the stand-in claude above, in that checkout; the card says it is
  // working while it is, says done when it ends, and the tab says so too.
  console.log('\n  /workbench/ — a Claude Code chat per pinned checkout')
  const call = (method, path, serviceMethod, payload) => evaluate(`fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
        'x-workspace-id': localStorage.getItem('basecamp_workspace'),
        ${serviceMethod ? `'x-service-method': ${JSON.stringify(serviceMethod)},` : ''} },
      ${payload ? `body: ${JSON.stringify(JSON.stringify(payload))},` : ''}
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`)
  await fill({ root: '~/code' })
  await evaluate(`document.querySelector('#local-repos-form button[type=submit]').click()`)
  await until(`document.querySelectorAll('#local-repos-list [aria-label^="Pin alpha"]').length`, n => n === 1,
    'the listing offered no pin for alpha')
  await click('#local-repos-list [aria-label^="Pin alpha"]')
  await until(`document.querySelectorAll('#local-repos-list [aria-label^="Unpin alpha"]').length`, n => n === 1,
    'starring alpha did not turn into an unpin')
  check('a checkout on the listing pins to the workbench', true)

  await goto('/workbench/')
  // An earlier visit left this browser's stage chosen and empty, so a new pin
  // waits in the dock (FJS-D1176) until a click stages it.
  const alphaTile = `document.querySelector('.workbench-dock .workbench-tile-open')`
  await until(`!!(${alphaTile} || document.querySelector('#workbench-grid article[data-state]'))`, v => v,
    'the pinned checkout was drawn nowhere')
  await evaluate(`${alphaTile}?.click()`)
  await until(`document.querySelectorAll('#workbench-grid article[data-state]').length`, n => n === 1,
    'the pinned checkout never became a card')
  const card = `document.querySelector('#workbench-grid article[data-state]')`
  check('the card shows the checkout, its branch and its dirty count',
    await evaluate(`/alpha/.test(${card}.textContent) && /main/.test(${card}.textContent) && /1 changed/.test(${card}.textContent)`),
    (await evaluate(`${card}.textContent`)).replace(/\s+/g, ' ').slice(0, 200))
  check('and starts idle', (await evaluate(`${card}.dataset.state`)) === 'idle')

  await evaluate(`(() => { const t = ${card}.querySelector('.workbench-composer textarea')
    t.value = 'add a readme'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evaluate(`${card}.querySelector('.workbench-composer button[type=submit]').click()`)
  await until(`${card}.dataset.state`, s => s === 'working', 'the card never said it was working')
  check('a message turns the card to working', true)
  await until(`${card}.querySelector('.workbench-now')?.textContent ?? ''`, t => /Bash bun test/.test(t),
    'the card never showed the tool call in progress')
  check('and it shows what the run is doing now', true)
  check('the dot pulses while it works', await evaluate(`!!${card}.querySelector('.fjs-dot-ping')`),
    await evaluate(`${card}.querySelector('h2').innerHTML.slice(0, 200)`))
  check('and the tab title counts it', /^● 1/.test(await evaluate('document.title')), await evaluate('document.title'))

  await until(`${card}.dataset.state`, s => s === 'done', 'the run never finished', 15_000)
  const chat = await evaluate(`${card}.querySelector('.workbench-log').textContent`)
  check('when it ends the chat holds the message, the tool call and the answer',
    /add a readme/.test(chat) && /› Bash bun test/.test(chat) && /Done: add a readme/.test(chat), chat.replace(/\s+/g, ' ').slice(0, 300))
  check('and what it cost', /\$0\.42/.test(await evaluate(`${card}.textContent`)))
  check('an unread finish is marked new', /\bnew\b/.test(await evaluate(`${card}.querySelector('.section-header').textContent`)))
  await until(`${card}.textContent`, t => /2 changed/.test(t), 'the dirty count never followed the run')
  check('the dirty count follows what the run changed', true)
  check('the run happened in the checkout', /add a readme/.test(
    spawnSync('cat', [join(ALPHA, 'claude-was-here.txt')], { encoding: 'utf8' }).stdout))
  check('the resume command is offered for a terminal',
    await evaluate(`[...${card}.querySelectorAll('button')].some(b => /Copy resume/.test(b.textContent))`))

  // After the run: the checkout's own fli done, the running cost, a review,
  // and the diff a line comment is made on.
  const tab = (sel, key) => evaluate(`${sel}.querySelector('[data-tab=${key}]').click()`)
  const checks = await until(`${card}.querySelector('[data-tab=checks]')?.textContent ?? ''`, t => /unfinished/.test(t),
    'the checks tab never showed fli done\'s report', 15_000)
  check('a finished run runs the checkout\'s fli done and its tab says what is unfinished',
    /1 unfinished/.test(checks) && /1 drive to run/.test(checks), checks.replace(/\s+/g, ' '))
  await tab(card, 'checks')
  await until(`!!${card}.querySelector('.workbench-checks')`, v => v, 'the checks tab opened no report')
  check('…and opening it lists the item and the drive to run',
    await evaluate(`/a\\.snapshot\\.md is stale/.test(${card}.querySelector('.workbench-checks').textContent)
      && /cd web && bun run verify/.test(${card}.querySelector('.workbench-checks').textContent)`))
  check('the card totals what its runs cost', /\$0\.42 total/.test(await evaluate(`${card}.textContent`)))
  check('and the header totals today across cards',
    /today \$0\.42/.test(await evaluate(`document.getElementById('workbench-today')?.textContent ?? ''`)))

  await evaluate(`[...${card}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Review').click()`)
  await until(`!!${card}.querySelector('[data-tab=review]')`, v => v, 'Review drew no tab')
  await tab(card, 'review')
  const reviewed = await until(`${card}.querySelector('.workbench-review')?.textContent ?? ''`, t => /Done: /.test(t),
    'the review never answered', 15_000)
  check('Review runs a read-only session and the card shows its reply', /read-only/.test(reviewed), reviewed.replace(/\s+/g, ' ').slice(0, 200))
  await until(`${card}.textContent`, t => /\$0\.84 total/.test(t), 'the review\'s cost never reached the total')
  check('…and its cost reaches the total', true)
  await evaluate(`[...${card}.querySelectorAll('.workbench-review button')].find(b => /Use as message/.test(b.textContent)).click()`)
  check('"Use as message" puts the reply in the message box rather than sending it',
    await until(`${card}.querySelector('.workbench-composer textarea').value`, v => /^A read-only reviewer/.test(v), 'the reply never reached the draft') && true)

  await tab(card, 'diff')
  const files = await until(`[...${card}.querySelectorAll('.workbench-file code')].map(c => c.textContent).join(' ')`,
    t => /claude-was-here\.txt/.test(t), 'the diff never listed the file the run wrote')
  check('the diff lists the tree\'s changes, untracked files included', /dirty\.txt/.test(files), files)
  await evaluate(`(() => { const f = [...${card}.querySelectorAll('.workbench-file')].find(f => /dirty.txt/.test(f.textContent)); f.open = true
    f.querySelector('.workbench-line').click() })()`)
  await until(`!!${card}.querySelector('.workbench-comment input')`, v => v, 'a click on a line opened no comment box')
  await evaluate(`(() => { const i = ${card}.querySelector('.workbench-comment input')
    i.value = 'why this file?'; i.dispatchEvent(new Event('input', { bubbles: true }))
    ${card}.querySelector('.workbench-comment button[type=submit]').click() })()`)
  const pending = await until(`${card}.querySelector('.workbench-comments')?.textContent ?? ''`, t => /why this file\?/.test(t),
    'the comment never joined the next message')
  check('a line comment waits above the message box, naming the file and line', /dirty\.txt:1/.test(pending), pending.replace(/\s+/g, ' '))

  await click('#workbench-grid article[data-state]')
  await until(`${card}.querySelector('.section-header').textContent`, t => !/\bnew\b/.test(t), 'opening the card did not mark it seen')
  check('clicking the card marks it seen', true)

  await evaluate(`(() => { const t = ${card}.querySelector('.workbench-composer textarea')
    t.value = 'slow one'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evaluate(`${card}.querySelector('.workbench-composer button[type=submit]').click()`)
  await until(`${card}.dataset.state`, s => s === 'working', 'the second message never started')
  await until(`[...${card}.querySelectorAll('button')].some(b => b.textContent.trim() === 'Stop')`, v => v, 'no Stop while working')
  await evaluate(`[...${card}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Stop').click()`)
  await until(`${card}.dataset.state`, s => s === 'error', 'stop did not end the run')
  check('Stop ends a run and the chat says it was stopped',
    /Stopped\./.test(await evaluate(`${card}.querySelector('.workbench-log').textContent`)))
  check('the line comment went with that message, and left the box',
    /My comments on the diff:[\s\S]*dirty\.txt:1[\s\S]*why this file\?[\s\S]*slow one/.test(await evaluate(`${card}.querySelector('.workbench-log').textContent`))
      && !(await evaluate(`!!${card}.querySelector('.workbench-comments')`)))
  check('a new message hides the checks and review it made stale, and shows the chat',
    !(await evaluate(`!!${card}.querySelector('[data-tab=checks], [data-tab=review]')`))
      && await evaluate(`${card}.querySelector('[data-tab=chat]').getAttribute('aria-selected') === 'true'`))

  // Two messages sent, so two notches; a fold clamps one side and leaves the
  // other open, and a click on one message flips it against the mode.
  const notches = await until(`${card}.querySelectorAll('.workbench-notch').length`, n => n === 2,
    'the jump rail never drew a notch per message')
  check('the rail has a notch per message sent', notches === 2)
  const foldState = `[...${card}.querySelectorAll('.workbench-msg')].map(m =>
    (m.classList.contains('workbench-you') ? 'you' : 'ai') + ':' + (m.querySelector('.clamp-2') ? 'folded' : 'open')).join(' ')`
  const foldButton = label => `[...${card}.querySelectorAll('.workbench-folds button')].find(b => b.textContent.trim() === '${label}').click()`
  await evaluate(foldButton('Mine'))
  const mine = await until(foldState, s => /you:folded/.test(s), 'Mine folded nothing')
  check('Mine folds your messages and leaves Claude\'s open', !/you:open|ai:folded/.test(mine), mine)
  await evaluate(`${card}.querySelector('.workbench-you .workbench-msg-head').click()`)
  const flipped = await until(foldState, s => /you:open/.test(s), 'clicking a folded message did not open it')
  check('a click opens one folded message and no other', (flipped.match(/you:folded/g) ?? []).length === 1, flipped)
  await evaluate(foldButton('Both'))
  const both = await until(foldState, s => !/open/.test(s), 'Both left a message open')
  check('Both folds every message and the tool calls collapse to a count',
    /› \d+ tool calls?/.test(await evaluate(`${card}.querySelector('.workbench-log').textContent`)), both)
  await evaluate(foldButton('None'))
  await until(foldState, s => !/folded/.test(s), 'None left a message folded')

  // A branch: Fork cuts alpha's dirty tree into a worktree of its own, drawn
  // after its parent; a message there forks the chat; Land carries its work
  // back uncommitted; Archive removes the tree and keeps the git branch.
  // The dialogs are answered in the page -- a native one blocks the drive.
  const answer = (fn, value) => evaluate(`window.${fn} = () => ${JSON.stringify(value)}`)
  const button = (sel, label) => `[...${sel}.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')`

  // A second chat: New chat opens a tab under the message box and shows it
  // empty. The two share alpha's tree, so while one works the other's box is
  // held rather than queued; Close takes the tab and the first chat is as it was.
  const logText = `${card}.querySelector('.workbench-log').textContent`
  const chatTabs = `[...${card}.querySelectorAll('.workbench-chat-open')].map(b => (b.getAttribute('aria-current') ? '*' : '') + b.querySelector('.workbench-chat-title').textContent.trim()).join(' | ')`
  await evaluate(`${button(card, 'New chat')}.click()`)
  const twoTabs = await until(chatTabs, t => t.split(' | ').length === 2, 'New chat drew no strip of tabs')
  check('New chat opens a second tab, shown, with an empty log',
    /^add a readme \| \*New chat$/.test(twoTabs) && !(await evaluate(`${logText}.trim()`)), twoTabs)
  await evaluate(`(() => { const t = ${card}.querySelector('.workbench-composer textarea')
    t.value = 'a second chat'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evaluate(`${card}.querySelector('.workbench-composer button[type=submit]').click()`)
  await until(`${card}.dataset.state`, s => s === 'working', 'the second chat never started')
  await evaluate(`${card}.querySelector('.workbench-chat-open').click()`)
  await until(`${card}.querySelector('.workbench-composer textarea').placeholder`, t => /Another chat here is working/.test(t),
    'the first chat\'s box offered to send while the second worked')
  check('while one chat works the other\'s box cannot send — one run at a time in a checkout',
    await evaluate(`${card}.querySelector('.workbench-composer button[type=submit]').disabled`)
      && /slow one/.test(await evaluate(logText)) && !/a second chat/.test(await evaluate(logText)))
  await until(`${card}.dataset.state`, s => s === 'done', 'the second chat never finished', 15_000)
  const titled = await until(chatTabs, t => /a second chat$/.test(t), 'the second tab never took its first message as its title')
  check('a tab is titled by its first message', /^\*add a readme \| a second chat$/.test(titled), titled)
  await answer('confirm', true)
  await evaluate(`${card}.querySelectorAll('.workbench-chat-tab')[1].querySelector('.workbench-chat-close').click()`)
  await until(`!!${card}.querySelector('.workbench-chats')`, v => !v, 'Close left the strip of tabs')
  check('Close takes the tab, and one chat draws no strip', /slow one/.test(await evaluate(logText)))

  await answer('prompt', 'try')
  await evaluate(`${button(card, 'Fork')}.click()`)
  await until(`document.querySelectorAll('#workbench-grid article[data-state]').length`, n => n === 2, 'Fork drew no second card')
  const branch = `document.querySelector('#workbench-grid article[data-branch]')`
  const drawn  = await evaluate(`[...document.querySelectorAll('#workbench-grid article[data-state]')].map(a => a.dataset.branch ?? 'parent').join(' ')`)
  check('Fork puts the branch on the stage beside its parent', drawn === 'parent wb/try', drawn)

  // The stage holds two; the rest are tiles in the dock, and this browser
  // remembers which two.
  const panes = `document.querySelectorAll('#workbench-grid article[data-state]').length`
  await evaluate(`${branch}.querySelector('[aria-label^="Move"][aria-label$="to the dock"]').click()`)
  await until(panes, n => n === 1, 'the dock button left the branch on the stage')
  check('a pane moved to the dock becomes a tile there',
    await evaluate(`!!document.querySelector('.workbench-dock .workbench-tile[data-branch="wb/try"]')`))
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: '2', altKey: true, bubbles: true }))`)
  await until(panes, n => n === 2, 'Alt+2 did not bring the branch back')
  check('Alt+2 puts the second chat back on the stage', true)
  await goto('/workbench/')
  await until(panes, n => n === 2, 'a reload forgot the stage')
  check('…and a reload keeps both on the stage',
    (await evaluate(`[...document.querySelectorAll('#workbench-grid article[data-state]')].map(a => a.dataset.branch ?? 'parent').join(' ')`)) === 'parent wb/try')

  // A third chat replaces the pane touched least recently, in that pane's
  // slot. The pauses keep two touches from landing on one millisecond.
  const GAMMA = join(SCRATCH, 'elsewhere', 'gamma')
  mkdirSync(GAMMA, { recursive: true })
  gitIn(GAMMA, 'init', '-q', '-b', 'main')
  const gammaPin = (await call('POST', '/workbench', 'pin', { path: GAMMA })).body
  await goto('/workbench/')
  const gammaTile = `document.querySelector('.workbench-dock #workbench-${gammaPin?.id} .workbench-tile-open')`
  await until(`!!${gammaTile}`, v => v, 'a third pin did not wait in the dock')
  const onStage = `[...document.querySelectorAll('#workbench-grid article[data-state]')]
    .map(a => a.dataset.branch ?? (a.id === 'workbench-${gammaPin?.id}' ? 'gamma' : 'parent')).join(' ')`
  await evaluate(`${branch}.click()`); await sleep(20)
  await evaluate(`${card}.click()`);   await sleep(20)
  await evaluate(`${gammaTile}.click()`)
  await until(onStage, s => s === 'parent gamma', 'a third chat did not replace the pane touched least recently')
  check('a third chat replaces the pane touched least recently, in its slot', true)
  await sleep(20)
  await evaluate(`${card}.click()`);   await sleep(20)
  await evaluate(`document.querySelector('.workbench-dock .workbench-tile[data-branch="wb/try"] .workbench-tile-open').click()`)
  await until(onStage, s => s === 'parent wb/try', 'a chat staged and not touched since was kept over one touched after it')
  check('…and a chat staged and not touched since is the stalest', true)
  // Layout: the panes fold to cards on a grid one column wider and one row
  // taller, every empty cell a box. A box starts a chat in a checkout it
  // asks for; a card dropped in the extra row or column grows the grid, and
  // the grid is as big as what it holds.
  const alt = (code) => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', altKey: true, bubbles: true }))`)
  const arranging = `!!document.querySelector('.workbench-panes[data-arranging]')`
  const shape = `getComputedStyle(document.querySelector('.workbench-panes')).getPropertyValue('--cols').trim() + 'x' + getComputedStyle(document.querySelector('.workbench-panes')).getPropertyValue('--rows').trim()`
  const slot  = (area) => `[...document.querySelectorAll('.workbench-slot')].find(s => s.style.gridArea === '${area}')`
  const cardOf = (sel) => `[...document.querySelectorAll('.workbench-card')].find(c => c.id === ${sel}.id)`
  const tops  = `[...document.querySelectorAll('#workbench-grid article[data-state]')].map(a => (a.dataset.branch ?? (a.id === 'workbench-${gammaPin?.id}' ? 'gamma' : 'parent')) + '@' + Math.round(a.getBoundingClientRect().top)).join(' ')`
  await alt('KeyL')
  await until(arranging, v => v, 'Alt+L did not open the layout')
  check('Layout folds the panes to cards on a grid one column wider and one row taller',
    await evaluate(`document.querySelectorAll('.workbench-card').length`) === 2 && await evaluate(`document.querySelectorAll('.workbench-slot').length`) === 4
      && await evaluate(shape) === '3x2', await evaluate(shape))
  await evaluate(`${slot('2 / 1')}.querySelector('.workbench-slot-new').click()`)
  await until(`!!${slot('2 / 1')}.querySelector('select[name=pin]')`, v => v, 'the box did not ask which checkout')
  check('a box asks which checkout, offering the ones in the dock',
    (await evaluate(`[...${slot('2 / 1')}.querySelectorAll('select[name=pin] option')].map(o => o.textContent).join(',')`)) === 'gamma')
  await evaluate(`${slot('2 / 1')}.querySelector('form').requestSubmit()`)
  await until(shape, v => v === '3x3', 'starting a chat in the extra row did not grow the grid')
  check('…and starts it there, the grid a row taller', await evaluate(`!!${cardOf(`document.getElementById('workbench-${gammaPin?.id}')`)}`))
  await evaluate(`document.getElementById('workbench-layout').click()`)
  await until(arranging, v => !v, 'Done did not bring the panes back')
  const stacked = await until(tops, s => /parent@(\d+) wb\/try@\1 gamma@/.test(s), 'the third chat was not drawn under the first two')
  check('Done draws the three panes, the new one under the first two', Number(stacked.match(/gamma@(\d+)/)[1]) > Number(stacked.match(/parent@(\d+)/)[1]), stacked)
  await goto('/workbench/')
  await until(shape, v => v === '2x2', 'a reload forgot the grid')
  check('…and a reload keeps the grid', true)

  // Dragging: a card to the extra row stacks them, which empties the second
  // column; back to the extra column puts them side by side again.
  const drag = (from, to) => evaluate(`(() => {
    const dt = new DataTransfer()
    const from = ${from}, to = ${to}
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })()`)
  await alt('KeyL')
  await until(arranging, v => v, 'Alt+L did not open the layout again')
  await evaluate(`${cardOf(`document.getElementById('workbench-${gammaPin?.id}')`)}.querySelector('[aria-label^="Move"]').click()`)
  await until(shape, v => v === '3x2', 'docking the third card did not shrink the grid')
  check('a card sent to the dock shrinks the grid back', true)
  await drag(`document.querySelector('.workbench-card[data-branch="wb/try"]')`, slot('2 / 1'))
  await until(shape, v => v === '2x3', 'dropping the branch in the extra row did not stack the two')
  check('a card dropped in the extra row stacks them, and the emptied column goes', true)
  await evaluate(`document.getElementById('workbench-layout').click()`)
  await until(tops, s => { const m = /parent@(\d+) wb\/try@(\d+)/.exec(s); return !!m && Number(m[2]) > Number(m[1]) }, 'the stacked panes were not drawn one under the other')
  check('…and Done draws them one under the other', true)
  await alt('KeyL')
  await drag(`document.querySelector('.workbench-card[data-branch="wb/try"]')`, slot('1 / 2'))
  await until(shape, v => v === '3x2', 'dropping the branch in the extra column did not put them side by side')
  await alt('KeyL')
  await until(onStage, s => s === 'parent wb/try', 'Alt+L did not close the layout')
  check('…and back to the extra column puts them side by side, in their places', true)

  check('the unpinned third chat goes', (await call('POST', `/workbench/${gammaPin?.id}`, 'unpin')).status === 200)
  await goto('/workbench/')
  await until(panes, n => n === 2, 'unpinning a docked chat changed the stage')

  // Zoom: one pane takes the stage, the other waits in the dock still staged.
  const zoomOf = (sel) => `${sel}.querySelector('[aria-label^="Zoom"], [aria-label="Show every pane"]')`
  const widths = `[...document.querySelectorAll('#workbench-grid article[data-state]')].map(a => Math.round(a.getBoundingClientRect().width))`
  const stageWidth = await evaluate(`document.querySelector('.workbench-panes').getBoundingClientRect().width`)
  await evaluate(`${zoomOf(card)}.click()`)
  await until(panes, n => n === 1, 'Zoom left both panes drawn')
  check('Zoom gives one pane the whole stage',
    Math.abs((await evaluate(widths))[0] - stageWidth) <= 2 && await evaluate(`${zoomOf(card)}.getAttribute('aria-pressed') === 'true'`))
  check('…and the other waits in the dock as a tile',
    await evaluate(`!!document.querySelector('.workbench-dock .workbench-tile[data-branch="wb/try"]')`))
  await alt('Digit2')
  await until(onStage, s => s === 'wb/try', 'Alt+2 while zoomed did not show the branch')
  check('Alt+2 while zoomed shows that chat zoomed', true)
  await goto('/workbench/')
  await until(onStage, s => s === 'wb/try', 'a reload forgot the zoom')
  check('…and a reload keeps the zoom', true)
  await alt('KeyZ')
  await until(onStage, s => s === 'parent wb/try', 'Alt+Z did not bring both panes back')
  check('Alt+Z brings both panes back, in their places', true)
  const branchText = (await evaluate(`${branch}.textContent`)).replace(/\s+/g, ' ')
  check('…naming its parent, its git branch and the uncommitted files it carried',
    /branch of alpha/.test(branchText) && /wb\/try/.test(branchText) && /carried 2 uncommitted files/.test(branchText), branchText.slice(0, 300))
  check('…and saying its first message forks the chat', /forks its chat/.test(branchText))
  check('…and what the copy list carried that git does not', /copied 1 ignored path · no install/.test(branchText), branchText.slice(0, 400))
  const TREE = join(WORKBENCH, 'trees')
  const inTree = (file) => spawnSync('cat', [join(TREE, spawnSync('ls', [TREE], { encoding: 'utf8' }).stdout.trim(), 'try', file)], { encoding: 'utf8' }).stdout
  check('the tree is outside the repository, holding the parent\'s uncommitted file', inTree('dirty.txt') === 'y')
  check('…and its ignored .env', inTree('.env') === 'SECRET=alpha\n')
  await tab(branch, 'settings')
  await tab(card, 'settings')
  check('a branch\'s settings have no copy list, since a branch is not forked',
    !(await evaluate(`!!${branch}.querySelector('textarea[name=copy]')`)) && await evaluate(`!!${card}.querySelector('textarea[name=copy]')`))

  await evaluate(`(() => { const t = ${branch}.querySelector('.workbench-composer textarea')
    t.value = 'in the branch'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evaluate(`${branch}.querySelector('.workbench-composer button[type=submit]').click()`)
  await until(`${branch}.dataset.state`, s => s === 'done', 'the branch\'s run never finished', 15_000)
  check('a message runs in the branch, not in alpha',
    /in the branch/.test(spawnSync('cat', [join(TREE, spawnSync('ls', [TREE], { encoding: 'utf8' }).stdout.trim(), 'try', 'claude-was-here.txt')], { encoding: 'utf8' }).stdout)
      && !/in the branch/.test(spawnSync('cat', [join(ALPHA, 'claude-was-here.txt')], { encoding: 'utf8' }).stdout))
  // Three finished runs and a review at $0.42 each — the closed chat's run still counted.
  await until(`${card}.textContent`, t => /\$1\.68 total/.test(t), 'the parent\'s total never took in the branch')
  check('the parent\'s total takes in its branch and keeps a closed chat', true)
  check('a parent with a branch cannot be unpinned', await evaluate(`${button(card, 'Unpin')}.disabled`))

  await tab(branch, 'diff')
  const branchFiles = await until(`[...${branch}.querySelectorAll('.workbench-file code')].map(c => c.textContent).join(' ')`,
    t => /claude-was-here\.txt/.test(t), 'the branch\'s diff never listed what its run wrote')
  check('the branch\'s diff is its work alone, not what it carried', !/dirty\.txt/.test(branchFiles), branchFiles)
  check('a branch\'s diff offers no commit — its work lands first', !(await evaluate(`!!${branch}.querySelector('.workbench-commit')`)))

  await evaluate(`${button(branch, 'Land')}.click()`)
  const landed = await until(`document.getElementById('workbench-notice')?.textContent ?? ''`, t => /Landed/.test(t), 'Land said nothing')
  check('Land carries the branch\'s work into alpha\'s tree, uncommitted',
    /Landed 1 file/.test(landed) && /in the branch/.test(spawnSync('cat', [join(ALPHA, 'claude-was-here.txt')], { encoding: 'utf8' }).stdout)
      && spawnSync('git', ['-C', ALPHA, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout === '', landed.replace(/\s+/g, ' '))

  await answer('confirm', true)
  await evaluate(`${button(branch, 'Archive')}.click()`)
  await until(`document.querySelectorAll('#workbench-grid article[data-state]').length`, n => n === 1, 'Archive left the branch\'s card')
  check('Archive removes the branch\'s card and its tree, and keeps wb/try',
    !spawnSync('ls', [join(TREE, spawnSync('ls', [TREE], { encoding: 'utf8' }).stdout.trim())], { encoding: 'utf8' }).stdout.includes('try')
      && /wb\/try/.test(spawnSync('git', ['-C', ALPHA, 'branch', '--list', 'wb/*'], { encoding: 'utf8' }).stdout))

  // Commit off alpha's Diff tab: the landed file chosen, dirty.txt unticked,
  // so the commit carries one file and the other stays in the tree.
  gitIn(ALPHA, 'config', 'user.email', 't@t'); gitIn(ALPHA, 'config', 'user.name', 't')
  const headBefore = gitIn(ALPHA, 'rev-parse', 'HEAD').stdout.toString().trim()
  await tab(card, 'diff')
  await until(`!!${card}.querySelector('.workbench-commit') && [...${card}.querySelectorAll('.workbench-file code')].map(c => c.textContent).join(' ')`,
    t => /claude-was-here\.txt/.test(t) && /dirty\.txt/.test(t), 'alpha\'s diff drew no commit form over its two files')
  const commitButton = `${card}.querySelector('.workbench-commit button[type=submit]')`
  check('the commit form chooses every file listed, and waits for a message',
    await evaluate(`/Commit 2 files/.test(${commitButton}.textContent) && ${commitButton}.disabled`))
  await evaluate(`(() => { const box = ${card}.querySelector('[aria-label="Commit dirty.txt"]')
    box.click()
    const t = ${card}.querySelector('.workbench-commit textarea')
    t.value = "Land the branch's readme"; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  check('unticking a file drops it from the count, and the box over them goes mixed',
    await until(`${commitButton}.textContent`, t => /Commit 1 file\b/.test(t), 'unticking dirty.txt left the count') && await evaluate(
      `${card}.querySelector('.workbench-commit input[name=all]').indeterminate && !${commitButton}.disabled
        && !${card}.querySelector('[aria-label="Commit dirty.txt"]').closest('details').open`))
  await evaluate(`${commitButton}.click()`)
  const commitNotice = await until(`document.getElementById('workbench-notice')?.textContent ?? ''`, t => /Committed/.test(t), 'Commit said nothing')
  const show = gitIn(ALPHA, 'show', '--name-only', '--format=%s%n%P', 'HEAD').stdout.toString()
  check('Commit puts the chosen file on HEAD with the message, and leaves the unticked one in the tree',
    /Committed [0-9a-f]{7} on alpha: 1 file/.test(commitNotice) && show.split('\n').filter(Boolean).join('|') === `Land the branch's readme|${headBefore}|claude-was-here.txt`
      && gitIn(ALPHA, 'status', '--porcelain', '--', 'dirty.txt').stdout.toString() === '?? dirty.txt\n', `${commitNotice.replace(/\s+/g, ' ')} :: ${show.replace(/\s+/g, ' ')}`)
  const afterCommit = await until(`[...${card}.querySelectorAll('.workbench-file code')].map(c => c.textContent).join(' ')`,
    t => !/claude-was-here\.txt/.test(t), 'the diff still lists the committed file')
  check('…and the diff reads again without it', /dirty\.txt/.test(afterCommit), afterCommit)

  // ─── The Plan tab ──────────────────────────────────────────────────────
  // A checkout of its own, so the plan chat and the file it writes reach
  // nothing the preview below cuts. It has IDEAS/, so the path defaults
  // beside the papers and follows the goal as it is typed.
  console.log('\n  the Plan tab — Build plan, then the plan read off its boxes')
  const DELTA = join(SCRATCH, 'elsewhere', 'delta')
  mkdirSync(join(DELTA, 'IDEAS'), { recursive: true })
  // Registers, so a step's filed rows have somewhere to land; DL-001 is there
  // before any step and is no step's. Needs a decision comes first: its
  // separator is a suffix of the six-column one the stand-in also matches.
  writeFileSync(join(DELTA, 'package.json'), JSON.stringify({ name: 'delta', private: true, registers: { prefix: 'DL' } }))
  writeFileSync(join(DELTA, 'ISSUES.md'), [
    '# Issues', '', '## Needs a decision', '', '| Id | Area | Question | Detail |', '| --- | --- | --- | --- |', '',
    '## S3 — medium', '', '| Id | Area | Title | Status | Verified | Detail |', '| --- | --- | --- | --- | --- | --- |',
    '| <a id="dl-001"></a>DL-001 | web | **Already here** | open | 2026-10-01 | — |', '',
  ].join('\n'))
  writeFileSync(join(DELTA, 'DECISIONS.md'), '# Decisions\n\n## Mail\n\n## Sign-up\n\n## Open (discussed, not yet ruled)\n')
  gitIn(DELTA, 'init', '-q', '-b', 'main')
  const deltaPin = (await call('POST', '/workbench', 'pin', { path: DELTA })).body
  await goto('/workbench/')
  const deltaTile = `document.querySelector('.workbench-dock #workbench-${deltaPin?.id} .workbench-tile-open')`
  // With the branch archived the stage has room, so it may be drawn there
  // already; from the dock, a click stages it.
  const delta = `document.querySelector('#workbench-grid article#workbench-${deltaPin?.id}')`
  await until(`!!(${delta} || ${deltaTile})`, v => v, 'the plan checkout was drawn nowhere')
  await evaluate(`${deltaTile}?.click()`)
  await until(`!!${delta}?.dataset.state`, v => v, 'the plan checkout never reached the stage')
  await tab(delta, 'plan')
  const goalBox = `${delta}.querySelector('.workbench-plan-build textarea')`
  const pathBox = `${delta}.querySelector('.workbench-plan-build input[name=path]')`
  await until(`!!${goalBox}`, v => v, 'a checkout with no plan showed no Build plan form')
  check('with no plan the Plan tab is the Build plan form, its button held until there is a goal',
    await evaluate(`${button(delta, 'Build plan')}.disabled`))
  await evaluate(`(() => { const t = ${goalBox}; t.value = 'Ship the sign-up form'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const defaulted = await until(`${pathBox}.value`, v => v === 'IDEAS/ship-the-sign-up-form.md', 'the path did not follow the goal into IDEAS/')
  check('the path defaults to IDEAS/<slug>.md where the checkout has IDEAS/, following the goal', true, defaulted)
  await evaluate(`${button(delta, 'Build plan')}.click()`)
  await until(`${delta}.dataset.state`, s => s === 'working', 'Build plan started no run')
  check('Build plan starts a run in the checkout', true)
  const steps = `[...${delta}.querySelectorAll('.workbench-step')].map(li => li.dataset.step + ':' + li.dataset.box + (li.getAttribute('aria-current') ? '*' : '')).join(' ')`
  const drawnSteps = await until(steps, t => t.split(' ').length === 4, 'the plan the session wrote was never drawn', 15_000)
  check('the tab draws the plan off the file — each step with its box, the first open one marked',
    drawnSteps === '0.1:done 0.2:open* 0.3:dropped 0.4:open', drawnSteps)
  check('…and the tab names the next step', /Plan · 0\.2/.test(await evaluate(`${delta}.querySelector('[data-tab=plan]').textContent`)))
  check('…with the phase\'s goal, a finding folded under its step, and the open question',
    await evaluate(`(() => { const t = ${delta}.querySelector('.workbench-plan').textContent
      return /Goal: the form exists/.test(t) && /1 finding/.test(t) && /1 open question/.test(t) && /Which mail provider/.test(t) })()`))
  const sent = spawnSync('cat', [join(DELTA, 'claude-was-here.txt')], { encoding: 'utf8' }).stdout
  const argv = spawnSync('cat', [join(DELTA, 'claude-argv.txt')], { encoding: 'utf8' }).stdout.split('\n')
  const planFile = join(DELTA, 'IDEAS', 'ship-the-sign-up-form.md')
  check('the session was handed the goal and the path, and may edit that file',
    /^Write a plan at `IDEAS\/ship-the-sign-up-form\.md`/.test(sent) && /Ship the sign-up form/.test(sent)
      && argv.some(a => a.includes(`Edit(/${planFile})`)), argv.join(' ').slice(0, 400))
  check('the plan chat is not a work session', !argv.includes('bypassPermissions'), argv.join(' ').slice(0, 400))
  await until(`${delta}.dataset.state`, s => s !== 'working', 'the plan run never finished')
  // A stand-in Notification and a page without focus, so the announcement
  // is caught rather than shown.
  await evaluate(`(() => {
    window.__notes = []; window.__realNotification = window.Notification
    window.Notification = class { static permission = 'granted'; constructor(t, o) { window.__notes.push(t + ' | ' + (o?.body ?? '')) } }
    document.hasFocus = () => false
  })()`)
  await evaluate(`${button(delta, 'Go')}.click()`)
  await until(`${delta}.dataset.state`, s => s === 'working', 'Go started no run')
  const started = await until(`${delta}.querySelector('[data-step="0.2"] .workbench-step-ran')?.textContent ?? ''`, t => /Started/.test(t), 'the step Go started was not marked on the tab')
  check('Go starts a run on the next box, and the tab marks the step started', true, started)
  const ticked = await until(steps, t => t === '0.1:done 0.2:done 0.3:dropped 0.4:open*', 'the box the session ticked was never drawn', 15_000)
  check('…and the box the step session ticked is drawn, the next one marked', /Plan · 0\.4/.test(await evaluate(`${delta}.querySelector('[data-tab=plan]').textContent`)), ticked)
  const stepSent = spawnSync('cat', [join(DELTA, 'claude-was-here.txt')], { encoding: 'utf8' }).stdout
  check('the step session was handed the step and its plan, and told to commit nothing',
    /^Carry out step 0\.2 of the plan at `IDEAS\/ship-the-sign-up-form\.md`: Write the form/.test(stepSent) && /Commit nothing\./.test(stepSent), stepSent.slice(0, 200))
  // 0.4's session ends with its box still open: the tab offers the tick.
  await until(`${delta}.dataset.state`, s => s !== 'working', 'the 0.2 run never finished')
  // The plan holds Q1, so the run that ended is waiting on the owner.
  const needs = `${delta}.querySelector('.workbench-needs')`
  const needsText = await until(`${needs}?.textContent.trim() ?? ''`, t => !!t, 'a run ending with an open question drew no needs you')
  check('a run that ends with an open question on the plan reads needs you, the question in its title',
    needsText === 'needs you · 1' && /Which mail provider\?/.test(await evaluate(`${needs}.title`)), needsText)
  const notes = await until('window.__notes.join("\\n")', t => /needs you/.test(t), 'the end of the run announced no needs you')
  check('…the announcement says needs you and asks the question, not done',
    /: needs you \| Q1 — Which mail provider\?$/m.test(notes) && !/: done/.test(notes), notes)
  await evaluate(`(() => { window.Notification = window.__realNotification; delete document.hasFocus })()`)
  check('…and the tab title counts it apart from the unread', /\? 1 · /.test(await evaluate('document.title')), await evaluate('document.title'))
  await evaluate(`${delta}.click()`)
  await tab(delta, 'chat')
  check('seeing the chat does not answer it', await evaluate(`!!${needs}`))
  await evaluate(`${needs}.click()`)
  await until(`${delta}.querySelector('[data-tab=plan]').getAttribute('aria-selected')`, v => v === 'true', 'needs you did not open the Plan tab')
  check('needs you opens the Plan tab, on the question', await evaluate(`!!${delta}.querySelector('[data-question]')`))
  const stepCost = await until(`${delta}.querySelector('[data-step="0.2"] .workbench-step-ran')?.textContent ?? ''`, t => /\$/.test(t), 'the finished step drew no cost')
  check('a finished step shows what its run cost, off its chat', /· \$0\.42 · 3 turns$/.test(stepCost.trim()), stepCost)
  const filed = (st) => `[...${delta}.querySelectorAll('[data-step="${st}"] [data-filed]')].map(li => li.dataset.filed + ':' + li.querySelector('.badge, [class*=badge]')?.textContent.trim()).join(' ')`
  const filed02 = await until(filed('0.2'), t => !!t, 'the rows 0.2 filed were never drawn under it')
  check('the rows a step filed are drawn under it — the question first, then the defect, and nothing filed before it',
    filed02 === 'DL-D1:question DL-002:S3', filed02)
  check('a step whose session ticked its box offers no manual tick',
    !await evaluate(`!!${delta}.querySelector('[data-step="0.2"] .workbench-step-open')`))
  // The strip of chat tabs is drawn from a second chat on; the pin is the count.
  const deltaChats = async () => (await call('POST', '/workbench', 'pins')).body?.pins?.find(x => x.id === deltaPin?.id)?.chats?.length
  const chatsBefore = await deltaChats()
  check('Next is held while the plan has an open question, and says which',
    await evaluate(`${button(delta, 'Next')}.disabled`) && /Which mail provider\?/.test(await evaluate(`${button(delta, 'Next')}.title`)))
  const blocked = await call('POST', `/workbench/${deltaPin?.id}`, 'next')
  check('…and the API refuses it, opening no chat', blocked.status === 409 && /open question/.test(JSON.stringify(blocked.body))
    && await deltaChats() === chatsBefore, `${blocked.status} ${JSON.stringify(blocked.body).slice(0, 200)}`)
  // The owner rules it in the tab: a letter, a section, Rule — fli's decide
  // with the plan named as the file the question is argued in.
  const Q1 = 'ship-the-sign-up-form:q1-which-mail-provider'
  const question = `${delta}.querySelector('[data-question="${Q1}"]')`
  const ruleForm = `${delta}.querySelector('.workbench-plan-rule')`
  const pick = (letter) => evaluate(`${question}.querySelector('[data-pick="${letter}"]').click()`)
  check('an open question offers its letters, the recommendation marked',
    await evaluate(`[...${question}.querySelectorAll('[data-pick]')].map(b => b.dataset.pick).join(' ')`) === 'A B'
      && /recommended/.test(await evaluate(`${question}.querySelector('[data-pick="A"]').parentElement.textContent`)))
  const against = await call('POST', `/workbench/${deltaPin?.id}`, 'decide', { question: Q1, pick: 'B', section: 'Mail' })
  check('the API refuses a pick against the recommendation with no reason, in decide\'s words, and writes nothing',
    against.status === 400 && /not the recommendation/.test(JSON.stringify(against.body)) && /- \*\*Q1 — Which mail provider\?\*\*/.test(readFileSync(planFile, 'utf8')),
    `${against.status} ${JSON.stringify(against.body).slice(0, 200)}`)
  await pick('B')
  await until(`!!${ruleForm}`, v => v, 'a letter opened no ruling form')
  check('the section is the owner\'s: the DECISIONS.md sections, none chosen',
    await evaluate(`[...${ruleForm}.querySelectorAll('select[name=section] option')].map(o => o.value).join('|')`) === '|Mail|Sign-up'
      && await evaluate(`${ruleForm}.querySelector('select[name=section]').value`) === '')
  await evaluate(`(() => { const el = ${ruleForm}.querySelector('select[name=section]'); el.value = 'Mail'; el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  check('B against the recommendation holds Rule until a reason is written',
    await evaluate(`${button(ruleForm, 'Rule B')}.disabled`) && /not the recommendation/.test(await evaluate(`${ruleForm}.textContent`)))
  await pick('A')
  await until(`${ruleForm}?.querySelector('button[type=submit]')?.textContent.trim()`, t => t === 'Rule A', 'pressing A did not retarget the form')
  check('…while A, the recommendation, rules with no reason, the section kept',
    !await evaluate(`${button(ruleForm, 'Rule A')}.disabled`) && await evaluate(`${ruleForm}.querySelector('select[name=section]').value`) === 'Mail')
  await evaluate(`${button(ruleForm, 'Rule A')}.click()`)
  const ruledNote = await until(`${delta}.querySelector('[data-ruled-note]')?.textContent ?? ''`, t => /Ruled/.test(t), 'a ruling drew no note')
  check('Rule writes the ruling and strikes the question in the plan, and the note names the id',
    /Ruled DL-D2: A/.test(ruledNote)
      && /- ~~\*\*Q1 — Which mail provider\?\*\*~~ \*\*Answered \S+ \(`DL-D2`\): A — the one configured\.\*\*/.test(readFileSync(planFile, 'utf8'))
      && /^## Mail\n\n### <a id="dl-d2"><\/a>/m.test(readFileSync(join(DELTA, 'DECISIONS.md'), 'utf8')), ruledNote)
  await until(`${button(delta, 'Next')}.disabled`, v => !v, 'Next stayed held once the question was ruled')
  check('…and the question leaves the callout, which goes with it', !await evaluate(`!!${question}`))
  await until(`!${needs}`, v => v, 'needs you stayed once the question was ruled')
  check('…and the card no longer needs you, nor the tab title', !/\? \d+ · /.test(await evaluate('document.title')), await evaluate('document.title'))
  await evaluate(`${button(delta, 'Next')}.click()`)
  await until(`${delta}.dataset.state`, s => s === 'working', 'Next on 0.4 started no run')
  const chatsAfter = await deltaChats()
  check('Next opens a new chat for the next box, and shows it',
    chatsAfter === chatsBefore + 1 && await evaluate(`${delta}.querySelectorAll('.workbench-chat-tab').length`) === chatsAfter, `${chatsBefore} → ${chatsAfter}`)
  check('no tick is offered while the step\'s run is live',
    !await evaluate(`!!${delta}.querySelector('[data-step="0.4"] .workbench-step-open')`))
  const leftOpen = await until(`${delta}.querySelector('[data-step="0.4"] .workbench-step-open')?.textContent ?? ''`,
    t => /still open/.test(t), 'a step whose run left its box open was not marked so', 15_000)
  check('a step whose run ended with its box open says so, with a Tick', /Tick/.test(leftOpen), leftOpen)
  // By number the ruling is 0.2's: it answers the question that step stopped on.
  const filed02ruled = await evaluate(filed('0.2'))
  check('…and a step that filed nothing draws no rows, while the earlier step keeps its own and the ruling on its question',
    await evaluate(filed('0.4')) === '' && filed02ruled === 'DL-D1:question DL-D2:ruling DL-002:S3', filed02ruled)
  const handoff = spawnSync('cat', [join(DELTA, 'claude-was-here.txt')], { encoding: 'utf8' }).stdout
  check('Next hands the new session the plan and the last reply, then the step',
    /^This is a fresh session continuing the plan at `IDEAS\/ship-the-sign-up-form\.md`/.test(handoff)
      && /The last session's reply:\n\nDone: Carry out step 0\.2/.test(handoff)
      && !/Which mail provider\?/.test(handoff) && /^Carry out step 0\.4 /m.test(handoff), handoff.slice(0, 300))
  await evaluate(`[...${delta}.querySelectorAll('[data-step="0.4"] button')].find(b => b.textContent.trim() === 'Tick').click()`)
  const handTicked = await until(steps, t => t === '0.1:done 0.2:done 0.3:dropped 0.4:done', 'the manual tick was never drawn')
  check('Tick writes the box into the file and the tab reads Plan ✓',
    /^- \[x\] 0\.4 Send the welcome mail$/m.test(readFileSync(planFile, 'utf8'))
      && /Plan ✓/.test(await evaluate(`${delta}.querySelector('[data-tab=plan]').textContent`)), handTicked)
  // File issue and Ask question write through fli's fileIssue; by number the
  // rows are 0.4's, the last step started.
  const fileForm = `${delta}.querySelector('.workbench-plan-file')`
  const fillFiling = (sel, value, ev = 'input') => evaluate(`(() => { const el = ${fileForm}.querySelector('${sel}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('${ev}', { bubbles: true })) })()`)
  await evaluate(`${button(delta, 'File issue')}.click()`)
  await until(`!!${fileForm}`, v => v, 'File issue opened no form')
  check('File issue is a form whose button is held until area, title and detail are written',
    await evaluate(`${button(fileForm, 'File')}.disabled`) && await evaluate(`${fileForm}.querySelector('select[name=severity]').value`) === 'S3')
  await fillFiling('select[name=severity]', 'S2', 'change')
  await fillFiling('input[name=area]', 'web')
  await fillFiling('input[name=title]', 'The welcome mail has no unsubscribe link')
  await fillFiling('textarea[name=detail]', 'Found reading 0.4.')
  await until(`${button(fileForm, 'File')}.disabled`, v => !v, 'File stayed held with every field written')
  // The checkout declares no S2 table: fileIssue's refusal is the banner, and the form keeps what was typed.
  await evaluate(`${button(fileForm, 'File')}.click()`)
  const noTable = await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => /no `## S2` table/.test(t), 'a refused filing drew no reason')
  check('a filing fileIssue refuses shows its reason and keeps the form as typed',
    await evaluate(`${fileForm}?.querySelector('input[name=title]').value`) === 'The welcome mail has no unsubscribe link', noTable.trim())
  await fillFiling('select[name=severity]', 'S3', 'change')
  await evaluate(`${button(fileForm, 'File')}.click()`)
  const filedNote = await until(`${delta}.querySelector('[data-filed-note]')?.textContent ?? ''`, t => /DL-003/.test(t), 'filing drew no note')
  check('File writes the row into the checkout\'s ISSUES.md at its severity and says where',
    /\| <a id="dl-003"><\/a>DL-003 \| web \| \*\*The welcome mail has no unsubscribe link\*\* \| open \|/.test(readFileSync(join(DELTA, 'ISSUES.md'), 'utf8'))
      && /ISSUES\.md:\d+/.test(filedNote) && !await evaluate(`!!${fileForm}`), filedNote)
  await evaluate(`${button(delta, 'Ask question')}.click()`)
  await until(`!!${fileForm}`, v => v, 'Ask question opened no form')
  check('Ask question names no severity', !await evaluate(`!!${fileForm}.querySelector('select')`))
  await fillFiling('input[name=area]', 'web')
  await fillFiling('input[name=title]', 'Does the welcome mail wait for verification?')
  await fillFiling('textarea[name=detail]', 'A — send at once. B — after verify.')
  await until(`${button(fileForm, 'Ask')}.disabled`, v => !v, 'Ask stayed held with every field written')
  await evaluate(`${button(fileForm, 'Ask')}.click()`)
  const filed04 = await until(filed('0.4'), t => /DL-D3/.test(t), 'the rows filed from the tab were never drawn under 0.4')
  check('…and both rows are drawn under the last step started, the question first',
    filed04 === 'DL-D3:question DL-003:S3' && await evaluate(filed('0.2')) === 'DL-D1:question DL-D2:ruling DL-002:S3', filed04)
  const refusedFile = await call('POST', `/workbench/${deltaPin?.id}`, 'file', { severity: 'S9', area: 'web', title: 'x', detail: 'y' })
  check('the API refuses a severity fileIssue does not name, with its reason', refusedFile.status === 400
    && /S1, S2, S3, S4, decision/.test(JSON.stringify(refusedFile.body)), `${refusedFile.status} ${JSON.stringify(refusedFile.body).slice(0, 200)}`)
  // Several plans per pin: Open plan shows a file already written, the picker
  // switches back, and each plan keeps its own steps; Close plan forgets one.
  writeFileSync(join(DELTA, 'IDEAS', 'second.md'), '# Second\n\n## Plan\n\n### Phase 0 — Again\n\n- [ ] 0.1 Do it again\n')
  const openForm = `${delta}.querySelector('.workbench-plan-open')`
  const openPath = (value) => evaluate(`(() => { const el = ${openForm}.querySelector('input[name=open-path]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evaluate(`${button(delta, 'Open plan')}.click()`)
  await until(`!!${openForm}`, v => v, 'Open plan opened no form')
  await openPath('IDEAS/nope.md')
  await evaluate(`${button(openForm, 'Open')}.click()`)
  const noPlan = await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => /nothing is written at IDEAS\/nope\.md/.test(t), 'opening a file that is not there drew no reason')
  check('Open plan refuses a path with nothing written there, by name', !!noPlan)
  await openPath('IDEAS/second.md')
  await evaluate(`${button(openForm, 'Open')}.click()`)
  const second = await until(steps, t => t === '0.1:open*', 'the opened plan was never drawn')
  const picker = `${delta}.querySelector('.workbench-plan select[name=plan]')`
  check('Open plan shows the file it names, its next step on the tab, and a picker over both plans',
    /Plan · 0\.1/.test(await evaluate(`${delta}.querySelector('[data-tab=plan]').textContent`))
      && await evaluate(`${picker}?.value`) === 'IDEAS/second.md' && !await evaluate(`!!${openForm}`), second)
  await evaluate(`(() => { const el = ${picker}; el.value = 'IDEAS/ship-the-sign-up-form.md'; el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  const firstAgain = await until(steps, t => t === '0.1:done 0.2:done 0.3:dropped 0.4:done', 'the picker never drew the first plan again')
  check('the picker shows the first plan again, its steps and the rows they filed kept',
    await evaluate(filed('0.2')) === 'DL-D1:question DL-D2:ruling DL-002:S3', firstAgain)
  await evaluate(`${button(delta, 'Close plan')}.click()`)
  const left = await until(steps, t => t === '0.1:open*', 'Close plan never showed the plan left')
  check('Close plan forgets the shown plan and shows the other, and the file stays',
    !await evaluate(`!!${picker}`) && existsSync(planFile)
      && await evaluate(`${delta}.querySelector('.workbench-plan code')?.textContent`) === 'IDEAS/second.md', left)
  check('the unpinned plan checkout goes', (await call('POST', `/workbench/${deltaPin?.id}`, 'unpin')).status === 200)
  await goto('/workbench/')
  await until(`!!${delta}`, v => !v, 'the unpinned plan checkout was still drawn')
  await until(`!!${card}?.dataset.state`, v => v, 'alpha left the stage with the plan checkout')

  // ─── The Run tab ────────────────────────────────────────────────────────
  // What the checkout declares, started from the card: alpha's own `fli dev`
  // (its node_modules is this package's, so the real cli, holding its session
  // under the scratch HOME) and a package.json script. Written now and removed
  // after, so the preview below cuts the tree it always has.
  console.log('\n  the Run tab — the checkout\'s app and scripts')
  writeFileSync(join(ALPHA, 'package.json'), JSON.stringify({ name: 'alpha', scripts: {
    dev: 'echo alpha dev up && sleep 60', greet: 'echo hello from alpha',
  } }))
  await tab(card, 'run')
  await until(`${card}.querySelector('.workbench-run')?.textContent ?? ''`, t => /greet/.test(t), 'the Run tab listed no scripts')
  check('the Run tab lists the app and each script by what it runs',
    await evaluate(`(() => { const t = ${card}.querySelector('.workbench-run').textContent
      return /fli dev/.test(t) && /bun run greet/.test(t) && /bun run dev/.test(t) })()`))

  await evaluate(`${button(`${card}.querySelector('[data-row="task:greet"]')`, 'Run')}.click()`)
  const greeted = await until(`${card}.querySelector('[data-row="task:greet"]')?.textContent ?? ''`, t => /exited 0/.test(t) && /hello from alpha/.test(t),
    'the script never ran to its end with its output shown')
  check('a script runs in the checkout and its output and exit show on its row', /✓ exited 0/.test(greeted), greeted.replace(/\s+/g, ' '))

  await evaluate(`${card}.querySelector('.workbench-start-app').click()`)
  const served = await until(`[...${card}.querySelectorAll('.workbench-meta a')].map(a => a.textContent + ' ' + a.href).join(' ')`, t => /web :\d+/.test(t),
    'Start app put no port on the card', 30_000)
  check('Start app is the checkout\'s fli dev, and the card links the port it claimed',
    /localhost:\d+/.test(served) && !(await evaluate(`!!${card}.querySelector('.workbench-start-app')`)), served)
  await until(`${card}.querySelector('[data-row="app:."]')?.textContent ?? ''`, t => /alpha dev up/.test(t), 'fli dev never ran the app\'s dev script')
  check('the tab says Run · 1 up while it serves', /Run · 1 up/.test(await evaluate(`${card}.querySelector('[data-tab=run]').textContent`)))

  await evaluate(`${button(`${card}.querySelector('[data-row="app:."]')`, 'Stop')}.click()`)
  await until(`${card}.querySelector('[data-row="app:."]')?.textContent ?? ''`, t => /stopped/.test(t) && !/running/.test(t), 'Stop left the app running')
  check('Stop ends fli dev and the card offers Start app again',
    await evaluate(`!!${card}.querySelector('.workbench-start-app') && !${card}.querySelector('.workbench-meta a')`))
  spawnSync('rm', [join(ALPHA, 'package.json')])
  await tab(card, 'chat')

  // ─── A preview: Open ───────────────────────────────────────────────────
  // A branch forked FOR A CLIENT is an Environment of its own, its hostname
  // routed to the branch's web port on the machine holding the worktree. The
  // machine is a stand-in on the command port's real TLS, with the certificate
  // enrollment pinned, so the route is read off the wire rather than off
  // Open's own answer.
  console.log('\n  a preview — the Workbench branch a client edits')
  //
  // The machine is outpost's own server and static store, so Freeze's bytes
  // are written, activated and SERVED by the code a fleet machine runs. Only
  // docker (there is none) and Caddy (`routes` holds what it would) stand in.
  const tls = (await import('@frontierjs/outpost/cert')).ensureCert(join(tmpdir(), `basecamp-provision-tls-${process.pid}`))
  const { createOutpostServer } = await import('@frontierjs/outpost/server')
  const { createStatic }        = await import('@frontierjs/outpost/static')
  const { createStaticServer }  = await import('@frontierjs/outpost/serve')
  const { createDocker }        = await import('@frontierjs/outpost/docker')
  const STATIC_DIR = join(SCRATCH, 'outpost-static'), STATIC_PORT = await portFor(import.meta.url, 'be', { service: 7 })
  const routes = new Map()
  const outpost = createOutpostServer({ serverId, signingKey: credential, hubKey, version: '0.1.0', staticPort: STATIC_PORT }, {
    statics: createStatic({ staticDir: STATIC_DIR }),
    docker:  createDocker({ run: async () => ({ exitCode: 1, stdout: '', stderr: 'Error: No such object' }) }),
    ingress: {
      route:   async ({ appId, hosts, port, host = null }) => { routes.set(appId, { hosts, port, host }); return { hosts } },
      unroute: async ({ appId }) => ({ removed: routes.delete(appId) }),
    },
    log: { warn() {}, error() {} },
  })
  const origin = createStaticServer({ staticDir: STATIC_DIR }, { log: { warn() {}, error() {} } })
  // What the hostname answers: Caddy's route for it, dialed with the Host it sets.
  const getHostname = async (hostname) => {
    const r = [...routes.values()].find(r => r.hosts.includes(hostname))
    if (!r) return { status: 'unrouted' }
    if (r.port !== STATIC_PORT) return { status: 'dev-server', port: r.port }
    const res = await origin.handle(new Request(`http://127.0.0.1:${STATIC_PORT}/`, { headers: { host: r.host } }))
    return { status: res.status, text: await res.text() }
  }
  const machineSaw = []
  const machine = Bun.serve({
    port: MACHINE_PORT, tls: { cert: Bun.file(tls.certPath), key: Bun.file(tls.keyPath) },
    async fetch(req) {
      machineSaw.push({ path: new URL(req.url).pathname, body: await req.clone().json().catch(() => ({})) })
      return outpost.handle(req)
    },
  })
  const registered = await heartbeat({ privateKey: credential }, { outpost_url: `https://localhost:${MACHINE_PORT}` })
  check('the machine reports its command port', registered.status === 200, `${registered.status}`)

  const alphaPin = (await call('POST', '/workbench', 'pins')).body?.pins?.find(p => !p.from)
  const projectId = (await call('GET', '/projects')).body?.data?.[0]?.id
  const settings = { projectId, app: '.', domain: 'preview.example.test', apiUrl: 'https://api.example.test', serverId }

  const notMine = await call('POST', `/workbench/${alphaPin?.id}`, 'configure', { preview: { ...settings, projectId: 'no-such-project' } })
  check('preview settings naming a project outside this workspace are refused',
    notMine.status === 404 && /not found in this workspace/.test(notMine.body?.message ?? ''), JSON.stringify(notMine))
  const noSettings = await call('POST', `/workbench/${alphaPin?.id}`, 'fork', { slug: 'client', preview: true })
  check('…and a preview fork before any settings is refused, with no branch cut',
    noSettings.status === 409 && /no preview settings/.test(noSettings.body?.message ?? '')
      && !/wb\/client/.test(spawnSync('git', ['-C', ALPHA, 'branch', '--list', 'wb/*'], { encoding: 'utf8' }).stdout), JSON.stringify(noSettings))
  const set = await call('POST', `/workbench/${alphaPin?.id}`, 'configure', { preview: settings, copy: ['**/.env', 'node_modules'] })
  check('the checkout takes preview settings', set.status === 200 && set.body?.preview?.domain === 'preview.example.test', JSON.stringify(set))

  const opened = await call('POST', `/workbench/${alphaPin?.id}`, 'fork', { slug: 'client', preview: true })
  const o = opened.body?.opened ?? {}
  check('Open answers the branch with what it made',
    opened.status === 200 && opened.body?.branch === 'wb/client' && o.hostname === 'client.preview.example.test'
      && Number.isInteger(o.port) && o.route?.ok === true, JSON.stringify(opened).slice(0, 400))
  const envRow = (await call('GET', `/environments/${o.environmentId}`)).body
  check('…an Environment at the preview tier, its slug the branch\'s', envRow?.tier === 'preview' && envRow?.slug === 'wb-client', JSON.stringify(envRow))
  const appRow = (await call('GET', `/apps/${o.appId}`)).body
  check('…one static inline App on the branch\'s web port, placed on the machine',
    appRow?.type === 'static' && appRow?.source?.kind === 'inline' && appRow?.port === o.port
      && JSON.stringify(appRow).includes(serverId), JSON.stringify(appRow).slice(0, 300))
  const vars = (await call('GET', `/variables?environmentId=${o.environmentId}`)).body?.data ?? []
  check('…the frozen build\'s FRONTIER_PUBLIC_API_URL on that App', vars.some(v => v.key === 'FRONTIER_PUBLIC_API_URL' && v.value === 'https://api.example.test' && v.appId === o.appId), JSON.stringify(vars))
  const doms = (await call('GET', `/domains?appId=${o.appId}`)).body?.data ?? []
  check('…and its hostname as a Domain', doms.length === 1 && doms[0].hostname === 'client.preview.example.test', JSON.stringify(doms))
  const routed = machineSaw.find(c => c.path === '/route')
  check('the machine was sent /route with the hostname and the branch\'s port',
    routed?.body?.app_id === o.appId && JSON.stringify(routed?.body?.hosts) === '["client.preview.example.test"]' && routed?.body?.port === o.port,
    JSON.stringify(machineSaw))
  const clientTree = join(TREE, spawnSync('ls', [TREE], { encoding: 'utf8' }).stdout.trim(), 'client')
  const markerAt = spawnSync('git', ['-C', clientTree, 'rev-parse', '--path-format=absolute', '--git-path', 'fjs-preview'], { encoding: 'utf8' }).stdout.trim()
  check('the branch\'s worktree is marked a preview, outside its tree',
    spawnSync('test', ['-f', markerAt]).status === 0 && !markerAt.startsWith(clientTree + '/'), markerAt)
  check('…and its hostname dials the branch\'s dev server', (await getHostname(o.hostname)).port === o.port)

  // ─── …Freeze, Thaw, and Retire ─────────────────────────────────────────
  // The § Silence artefact: the hostname serves the built UI once frozen, and
  // answers nothing once retired.
  const frozen = await call('POST', `/workbench/${opened.body?.id}`, 'freeze')
  const head = spawnSync('git', ['-C', clientTree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  check('Freeze builds web/, publishes it and queues a release of that digest',
    frozen.status === 200 && /^sha256:[0-9a-f]{64}$/.test(frozen.body?.digest ?? '') && frozen.body?.files >= 2
      && frozen.body?.commitSha === head, JSON.stringify(frozen).slice(0, 600))
  let release
  for (let i = 0; i < 60 && !['success', 'failed'].includes(release?.status); i++) {
    await new Promise(r => setTimeout(r, 250))
    release = (await call('GET', `/deployments/${frozen.body?.deploymentId}`)).body
  }
  check('…which runs without an upload, as a freeze, at the branch\'s head',
    release?.status === 'success' && release?.trigger === 'freeze' && release?.builtImage === frozen.body?.digest
      && release?.commitSha === head && release?.branch === 'wb/client'
      && JSON.stringify(release?.steps?.map(s => s.name)) === '["Validate","Activate","Health check"]',
    JSON.stringify(release).slice(0, 600))
  const servedFrozen = await getHostname(o.hostname)
  check('the hostname serves the built UI, carrying production\'s API origin',
    servedFrozen.status === 200 && /<h1>alpha<\/h1>/.test(servedFrozen.text ?? '') && /\/assets\/[^"]+\.js/.test(servedFrozen.text ?? ''),
    JSON.stringify(servedFrozen).slice(0, 300))
  const bundle = (servedFrozen.text ?? '').match(/\/assets\/[^"]+\.js/)?.[0]
  const js = bundle ? await origin.handle(new Request(`http://127.0.0.1:${STATIC_PORT}${bundle}`, { headers: { host: routes.get(o.appId)?.host } })).then(r => r.text()) : ''
  check('…whose bundle has FRONTIER_PUBLIC_API_URL inlined', js.includes('https://api.example.test'), bundle ?? 'no bundle')

  // The App row is where the dev server's port lives, not Open's record of
  // it: an edit to the row is what Thaw must send.
  const moved = await call('PATCH', `/apps/${o.appId}`, null, { port: o.port + 1 })
  const thawed = await call('POST', `/workbench/${opened.body?.id}`, 'thaw')
  check('Thaw routes the hostname back to the dev server, on the port the App row names',
    moved.status === 200 && thawed.status === 200 && (await getHostname(o.hostname)).port === o.port + 1, JSON.stringify(thawed))

  const notPreview = await call('POST', `/workbench/${alphaPin?.id}`, 'freeze')
  check('…and Freeze on a checkout that is not a preview is refused', notPreview.status === 409 && /not a preview/.test(notPreview.body?.message ?? ''), JSON.stringify(notPreview))

  const retired = await call('POST', `/workbench/${opened.body?.id}`, 'archive', { discard: true })
  check('Archive retires the preview first, and the machine took it',
    retired.status === 200 && retired.body?.retired?.machine?.ok === true, JSON.stringify(retired))
  check('…so the hostname answers nothing', (await getHostname(o.hostname)).status === 'unrouted', JSON.stringify([...routes]))
  check('…its files are off the static origin too',
    (await origin.handle(new Request(`http://127.0.0.1:${STATIC_PORT}/`, { headers: { host: `${o.appId}.localhost` } }))).status === 404)
  check('…the Environment is removed', (await call('GET', `/environments/${o.environmentId}`)).status === 404)
  check('…and the git branch is kept',
    /wb\/client/.test(spawnSync('git', ['-C', ALPHA, 'branch', '--list', 'wb/*'], { encoding: 'utf8' }).stdout))
  machine.stop(true)

  // Focus mode, on the screen it was asked for. A sidebar left in the DOM
  // would keep its grid column, so the screen's left edge is the proof.
  const panels = `[!!document.querySelector('.shell > .sidebar'), !!document.querySelector('.notice-rail')]`
  check('the sidebar is drawn before focus', (await evaluate(panels))[0])
  await click('#focus-toggle')
  await until(panels, ([s, r]) => !s && !r, 'Focus left a side panel drawn')
  check('Focus hides the sidebar and the notice rail', true)
  check('…and the screen takes the sidebar\'s column',
    (await evaluate(`document.getElementById('main').getBoundingClientRect().left`)) < 1)
  await goto('/workbench/')
  await until(panels, ([s, r]) => !s && !r, 'a reload came back unfocused')
  check('…and a reload stays focused', true)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true }))`)
  await until(panels, ([s]) => s, 'Ctrl+. did not bring the sidebar back')
  check('Ctrl+. brings them back', true)

  // A pin outlives its folder: renamed on disk, the card says so, runs are
  // refused by path, and Unpin is reachable from a card that is not in focus.
  const BETA = join(SSH_HOME, 'code', 'beta')
  const betaPin = (await call('POST', '/workbench', 'pin', { path: BETA })).body
  renameSync(BETA, `${BETA}-renamed`)
  await goto('/workbench/')
  const betaCard = `document.getElementById('workbench-${betaPin?.id}')`
  await until(`!!${betaCard}?.querySelector('.workbench-gone')`, v => v, 'a renamed checkout drew no warning')
  check('a renamed checkout\'s card warns, even as a tile in the dock',
    await evaluate(`!!${betaCard}.closest('.workbench-dock') && ${betaCard}.querySelector('.workbench-gone').offsetParent !== null`))
  check('…and offers no message box or diff', !(await evaluate(`!!${betaCard}.querySelector('[id^=workbench-draft-], .workbench-diff-panel')`)))
  const goneSend = await call('POST', `/workbench/${betaPin?.id}`, 'send', { prompt: 'hello' })
  check('…and a send is refused by the path', goneSend.status === 400 && /no longer there/.test(goneSend.body?.message ?? ''), JSON.stringify(goneSend))
  await answer('confirm', true)
  await evaluate(`${button(betaCard, 'Unpin')}.click()`)
  await until(`!${betaCard}`, v => v, 'Unpin left the renamed checkout\'s card')
  check('…and Unpin from its tile removes it', true)
  renameSync(`${BETA}-renamed`, BETA)

  // ⌘K's Recent group. Both visits are full page loads, so the entry it
  // offers has to have come back out of storage.
  const firstRow = `document.querySelector('.fjs-cp-row')?.textContent.trim() ?? ''`
  const palette = () => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
  await goto('/servers/')
  await goto('/workbench/')
  await palette()
  const back = await until(firstRow, t => t.length > 0, 'the palette opened with no rows')
  check('⌘K opens on "Go back to" the screen before, across a reload', /^Go back to Servers/.test(back), back)
  await click('.fjs-cp-row')
  await until(`location.pathname`, p => p === '/servers/', 'Go back went nowhere')
  check('…and choosing it goes there', true)
  await palette()
  const again = await until(firstRow, t => t.length > 0, 'the palette reopened with no rows')
  check('…after which it offers the screen just left', /^Go back to Workbench/.test(again), again)
  await evaluate(`document.querySelector('.fjs-cp-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  // ─── The other act ─────────────────────────────────────────────────────
  // The screen this one was split from. Asserted because the split is only a
  // gain if BOTH halves still work: a rename that left importing broken would
  // pass every row above.
  console.log('\n  /servers/import/ — the act that costs nothing')
  await goto('/servers/import/')
  await until(`!!document.getElementById('ipAddress')`, v => v, 'the import form never rendered')
  check('it says plainly that nothing is billed and nothing is contacted',
    /nothing is billed/i.test(await body()))
  check('and offers no account, region catalog or price',
    await evaluate(`!document.getElementById('account') && !document.getElementById('size')`))

  // ─── …and, on an operator's own machine, their ssh aliases ─────────────
  // LOCAL_MACHINE=1 and a HOME holding two aliases. The pick fills what ssh -G
  // resolved; a HostName that is a NAME is left out of the address column,
  // which feeds DNS records.
  await until(`!!document.getElementById('sshAlias')`, v => v, 'the ssh alias picker never rendered')
  check('the picker offers the aliases the config names, and nothing else',
    JSON.stringify(await options('sshAlias')) === '["desk","named"]', JSON.stringify(await options('sshAlias')))
  await fill({ sshAlias: 'desk' })
  await until(`document.getElementById('sshUser')?.value`, v => v === 'ops', 'picking an alias filled no user')
  check('picking one fills the address, user and port ssh resolved',
    await evaluate(`[document.getElementById('ipAddress').value, document.getElementById('sshPort').value].join(' ')`) === '192.0.2.7 2201')
  await until(`document.getElementById('ssh-aliases').textContent`, t => /unreachable/.test(t), 'the probe never answered', 15_000)
  check('and says whether this laptop can reach it',
    /unreachable/.test(await text('#ssh-aliases')))
  check('with the command that would put Basecamp itself there',
    /fli deploy:setup --server desk/.test(await text('#ssh-aliases')))
  await fill({ sshAlias: 'named' })
  await until(`document.getElementById('sshUser')?.value`, v => v !== 'ops', 'picking a second alias changed nothing')
  check('a HostName that is a name is not written into the address',
    await evaluate(`document.getElementById('ipAddress').value`) === '')
  await fill({ sshUser: 'root', sshPort: '22' })

  await fill({ name: 'under-the-desk', ipAddress: '10.0.1.9', region: 'dc1' })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`location.pathname`, p => /^\/servers\/[0-9a-f-]{36}\/$/.test(p),
    'importing never landed on the machine', 20_000)
  const imported = await text('#server-status')
  // `pending`, not `provisioning`: nothing was bought, so no job is working on
  // it and no cloud will ever answer about it.
  check('an imported machine lands at `pending`, with no job working on it',
    imported === 'pending', imported)
  // The PAIR, and it is the whole point of the row. `pending` alone cannot say
  // whether anything is working on this machine: a provisioned one is queued,
  // an imported one is parked. The provisioned machine above showed the strip
  // at `provisioning`; this one must not show it at `pending`, or the screen is
  // telling an operator their own box is queued for a job that will never run.
  check('and NO progress strip — nothing is queued for a machine nobody bought',
    await evaluate(`!document.getElementById('server-inflight')`))

  // ─── …and it is told how to get a credential ───────────────────────────
  // An imported machine holds nothing. There is no fleet-wide key any more, so
  // until it enrolls its check-ins are refused — which is a machine somebody
  // has not finished installing rather than one that is broken, and the screen
  // has to say which.
  check('the screen says it has no credential of its own',
    await evaluate(`!!document.getElementById('needs-enrollment')`))

  await click('#needs-enrollment button')
  await until(`!!document.getElementById('enroll-command')`, v => v,
    'the install command never appeared')
  const command = await text('#enroll-command')
  check('and hands over one command to run on it',
    /curl -fsSL .*\/install\.sh; \} \| sudo bash$/.test(command?.trim() ?? ''), command?.trim()?.slice(0, 120))
  // A URL puts the token in an access log and a proxy's; sudo's argv puts it in
  // the system journal (FJS-3511). Only bash's stdin carries it.
  check('…carrying the token on stdin, not in the URL or sudo\'s argv',
    /^\{ echo export .*ENROLL_TOKEN=bcen_[0-9a-f]{64}/.test(command?.trim() ?? '')
    && !/install\.sh\?/.test(command ?? '') && !/sudo env/.test(command ?? ''), command?.trim()?.slice(0, 160))

  check('with a button that copies it',
    await evaluate(`[...document.querySelectorAll('#needs-enrollment button')].some(b => /Copy command/.test(b.textContent))`))

  // ─── What a person may correct ─────────────────────────────────────────
  // The drawer offers the operator's columns and nothing the machine or the
  // provider reports; a save is read back through the API.
  const importedId = (await evaluate(`location.pathname`)).split('/')[2]
  await click('#server-edit')
  await until(`!!document.querySelector('#server-edit-save')`, v => v, 'the edit drawer never opened')
  check('the edit offers how it is reached', await evaluate(`!!document.querySelector('dialog[open] [name=sshUser]')`))
  // No vendor reports an imported box's address, so nothing but this box ever
  // corrects it, and a Domain on a box with none is never pushed (FJS-3516).
  check('…its address included, on a box no provider reports',
    await evaluate(`!!document.querySelector('dialog[open] [name=ipAddress]')`))
  check('and not what the machine reports about itself',
    await evaluate(`!document.querySelector('dialog[open] [name=outpostVersion], dialog[open] [name=health], dialog[open] [name=status]')`))
  await evaluate(`(() => { const el = document.querySelector('dialog[open] [name=sshUser]')
                           el.value = 'deploy'
                           el.dispatchEvent(new Event('input', { bubbles: true }))
                           el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await click('#server-edit-save')
  await until(`document.body.textContent`, t => t.includes('deploy@10.0.1.9'), 'the saved SSH user never reached the screen')
  const readBack = await evaluate(`fetch('/servers/${importedId}', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': localStorage.getItem('basecamp_workspace') } }).then(r => r.json())`)
  check('an SSH user edited in the drawer is the one stored', readBack?.sshUser === 'deploy', JSON.stringify(readBack?.sshUser))

  // A self or imported box with no address has its Domains skipped by the edge
  // sync in silence, so the screen is the only place that can say so (FJS-3515).
  check('a machine with an address carries no address warning', await evaluate(`!document.getElementById('needs-address')`))
  await click('#server-edit')
  await until(`!!document.querySelector('dialog[open] [name=ipAddress]')`, v => v, 'the edit drawer never reopened')
  await evaluate(`(() => { const el = document.querySelector('dialog[open] [name=ipAddress]')
                           el.value = ''
                           el.dispatchEvent(new Event('input', { bubbles: true }))
                           el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await click('#server-edit-save')
  await until(`!!document.getElementById('needs-address')`, v => v, 'clearing the address never raised the warning')
  check('clearing the address in the drawer warns that its Domains are never pushed', true)

  // The script the command fetches is public and carries nothing. Asserted from
  // the browser because that is the origin a person's machine would fetch it
  // from, and a route that only answered in a unit test would pass there.
  const script = await fetch(`${API}/install.sh`)
  const text0  = await script.text()
  check('the script it fetches is served, and holds no credential',
    script.status === 200 && !text0.includes('bcen_'), `${script.status}`)

  // ─── The console ───────────────────────────────────────────────────────
  console.log('\n  the console')
  check('no console errors or warnings across the flow',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

} catch (e) {
  bad('the run stopped', e.message)
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`)
await cleanup()
await rm(SCRATCH, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
